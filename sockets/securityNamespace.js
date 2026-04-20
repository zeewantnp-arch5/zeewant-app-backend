import jwt from "jsonwebtoken";
import AuditLog from "../models/AuditLog.js";
import PrivacyRequest from "../models/PrivacyRequest.js";
import Soultee from "../models/Soultee.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";
import SystemSettings from "../models/SystemSettings.js";

const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchSecuritySettings() {
  const settings = await SystemSettings.find({ category: "security" }).lean();
  return Object.fromEntries(settings.map(s => [s.key, s.value]));
}

function computeOverallScore(cfg) {
  const twoFA   = cfg["two_factor_auth"]          ? 1 : 0;
  const e2e     = cfg["e2e_encryption"]            ? 1 : 0;
  const audit   = cfg["audit_logging"]             ? 1 : 0;
  const timeout = (cfg["session_timeout_minutes"] ?? 60) <= 30 ? 1 : 0;
  const hipaa   = Math.min(100, twoFA * 20 + e2e * 30 + audit * 30 + timeout * 20);
  const gdpr    = Math.min(100, twoFA * 15 + e2e * 25 + audit * 25 + timeout * 15 + 20);
  const iso     = Math.min(100, twoFA * 30 + e2e * 20 + audit * 30 + timeout * 20);
  return Math.round((hipaa + gdpr + iso) / 3);
}

// ── Snapshot builders ─────────────────────────────────────────────────────────

async function buildSecuritySnapshot() {
  const now    = new Date();
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000);

  const [
    activeSoultees,
    activeLinks,
    securityEvents24h,
    criticalCount,
    privacyPending,
    cfg,
    recentAlerts,
  ] = await Promise.all([
    Soultee.countDocuments({ status: { $in: ["online", "busy"] } }),
    StudentSoulteeLink.countDocuments({ status: "active" }),
    AuditLog.countDocuments({ severity: { $in: ["critical", "warn"] }, createdAt: { $gte: dayAgo } }),
    AuditLog.countDocuments({ severity: "critical", createdAt: { $gte: dayAgo } }),
    PrivacyRequest.countDocuments({ status: "pending" }),
    fetchSecuritySettings(),
    AuditLog.find({ severity: { $in: ["critical", "warn"] }, createdAt: { $gte: dayAgo } })
      .sort({ createdAt: -1 })
      .limit(5)
      .select("severity description action adminName ipAddress createdAt")
      .lean(),
  ]);

  return {
    type: "security_snapshot",
    ts:   Date.now(),
    activeSoultees,
    activeLinks,
    securityEvents24h,
    criticalCount,
    privacyPending,
    complianceScore: computeOverallScore(cfg),
    e2eEncryption:   cfg["e2e_encryption"]  ?? true,
    twoFactorAuth:   cfg["two_factor_auth"] ?? true,
    auditLogging:    cfg["audit_logging"]   ?? true,
    recentAlerts: recentAlerts.map(a => ({
      severity:  a.severity,
      message:   a.description,
      action:    a.action,
      adminName: a.adminName,
      ip:        a.ipAddress,
      ts:        a.createdAt,
    })),
  };
}

// ── Namespace registration ────────────────────────────────────────────────────

export function registerSecurityNamespace(io) {
  const ns = io.of("/security");

  // JWT auth guard
  ns.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.query?.token;
    if (!token) return next(new Error("No security token"));
    try {
      socket.data.admin = jwt.verify(token, JWT_SECRET);
      next();
    } catch {
      next(new Error("Unauthorized security token"));
    }
  });

  ns.on("connection", async (socket) => {
    socket.join("security_room");
    const who = socket.data.admin?.username || socket.id;
    console.log(`🔒 Security connected: ${who}`);

    // Immediate initial snapshot
    try {
      const snap = await buildSecuritySnapshot();
      socket.emit("security_snapshot", snap);
    } catch (err) {
      console.error("Security initial snapshot error:", err.message);
    }

    socket.on("disconnect", () => {
      console.log(`🔒 Security disconnected: ${who}`);
    });
  });

  // ── 30-second periodic push ───────────────────────────────────────────────
  const pushInterval = setInterval(async () => {
    if (ns.sockets.size === 0) return;
    try {
      const snap = await buildSecuritySnapshot();
      ns.to("security_room").emit("security_snapshot", snap);
    } catch (err) {
      console.error("Security periodic push error:", err.message);
    }
  }, 30_000);

  // ── MongoDB Change Streams ────────────────────────────────────────────────
  let auditStream       = null;
  let privacyStream     = null;

  const setupChangeStreams = () => {
    try {
      // Watch new audit log entries for immediate security alerts
      auditStream = AuditLog.watch(
        [{ $match: { operationType: "insert" } }],
        { fullDocument: "updateLookup" }
      );

      auditStream.on("change", async (change) => {
        if (ns.sockets.size === 0) return;
        const doc = change.fullDocument;
        if (!doc) return;

        // Push the new audit event immediately
        ns.to("security_room").emit("audit_event", {
          type:      "audit_event",
          ts:        Date.now(),
          severity:  doc.severity,
          action:    doc.action,
          message:   doc.description,
          adminName: doc.adminName,
          adminRole: doc.adminRole,
          resource:  doc.resourceType,
          ip:        doc.ipAddress,
          eventTs:   doc.createdAt,
        });

        // Also push updated snapshot for critical events
        if (doc.severity === "critical") {
          try {
            const snap = await buildSecuritySnapshot();
            ns.to("security_room").emit("security_snapshot", snap);
          } catch { /* suppress */ }
        }
      });

      auditStream.on("error", (err) => {
        console.warn("Security audit stream error:", err.message);
        auditStream?.close();
        auditStream = null;
      });

      // Watch privacy request changes
      privacyStream = PrivacyRequest.watch(
        [{ $match: { operationType: { $in: ["insert", "update"] } } }],
        { fullDocument: "updateLookup" }
      );

      privacyStream.on("change", async (change) => {
        if (ns.sockets.size === 0) return;
        const doc = change.fullDocument;
        if (!doc) return;

        ns.to("security_room").emit("privacy_update", {
          type:      "privacy_update",
          ts:        Date.now(),
          requestId: doc.requestId,
          status:    doc.status,
          reqType:   doc.type,
          userId:    doc.userId,
          id:        doc._id,
        });
      });

      privacyStream.on("error", (err) => {
        console.warn("Security privacy stream error:", err.message);
        privacyStream?.close();
        privacyStream = null;
      });

      console.log("🔒 Security change streams active");
    } catch (err) {
      console.log("🔒 Security change streams unavailable — polling only:", err.message);
    }
  };

  setTimeout(setupChangeStreams, 3000);

  return () => {
    clearInterval(pushInterval);
    auditStream?.close();
    privacyStream?.close();
  };
}
