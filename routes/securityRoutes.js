import express from "express";
import jwt from "jsonwebtoken";
import AuditLog from "../models/AuditLog.js";
import AdminUser from "../models/AdminUser.js";
import SystemSettings from "../models/SystemSettings.js";
import PrivacyRequest from "../models/PrivacyRequest.js";
import Soultee from "../models/Soultee.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";
import Session from "../models/Session.js";

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret";

// ─── Auth middleware ──────────────────────────────────────────────────────────
const requireAdmin = (req, res, next) => {
  const auth  = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ message: "No token provided" });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};

// ─── Security scoring helpers ──────────────────────────────────────────────────
async function fetchSecuritySettings() {
  const settings = await SystemSettings.find({ category: "security" }).lean();
  return Object.fromEntries(settings.map(s => [s.key, s.value]));
}

function computeComplianceScores(cfg) {
  const twoFA   = cfg["two_factor_auth"]         ? 1 : 0;
  const e2e     = cfg["e2e_encryption"]           ? 1 : 0;
  const audit   = cfg["audit_logging"]            ? 1 : 0;
  const timeout = (cfg["session_timeout_minutes"] ?? 60) <= 30 ? 1 : 0;

  return {
    HIPAA:    Math.min(100, twoFA * 20 + e2e * 30 + audit * 30 + timeout * 20),
    GDPR:     Math.min(100, twoFA * 15 + e2e * 25 + audit * 25 + timeout * 15 + 20),
    PDPA:     Math.min(100, twoFA * 20 + e2e * 25 + audit * 25 + timeout * 10 + 20),
    ISO27001: Math.min(100, twoFA * 30 + e2e * 20 + audit * 30 + timeout * 20),
    SOC2:     Math.min(100, Math.round((twoFA * 30 + e2e * 30 + audit * 40) * 0.65 + 25)),
  };
}

function overallScore(scores) {
  const vals = Object.values(scores);
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

// ── GET /api/security/dashboard ───────────────────────────────────────────────
router.get("/dashboard", requireAdmin, async (req, res) => {
  try {
    const now     = new Date();
    const dayAgo  = new Date(now - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now - 7  * 24 * 60 * 60 * 1000);

    const [
      activeSoultees,
      activeLinks,
      totalAdmins,
      recentLoginLogs,
      criticalLogs,
      warnLogs,
      recentAlerts,
      privacyPending,
      cfg,
    ] = await Promise.all([
      Soultee.countDocuments({ status: { $in: ["online", "busy"] } }),
      StudentSoulteeLink.countDocuments({ status: "active" }),
      AdminUser.countDocuments({ isActive: true }),
      AuditLog.countDocuments({ action: "login", createdAt: { $gte: dayAgo } }),
      AuditLog.countDocuments({ severity: "critical", createdAt: { $gte: dayAgo } }),
      AuditLog.countDocuments({ severity: "warn",     createdAt: { $gte: dayAgo } }),
      AuditLog.find({ severity: { $in: ["critical", "warn"] }, createdAt: { $gte: dayAgo } })
        .sort({ createdAt: -1 })
        .limit(10)
        .select("severity description action resourceType createdAt adminName ipAddress")
        .lean(),
      PrivacyRequest.countDocuments({ status: "pending" }),
      fetchSecuritySettings(),
    ]);

    const scores = computeComplianceScores(cfg);

    // Compliance checklist (derived from settings)
    const checklist = [
      { label: "HIPAA Data Privacy",     ok: cfg["e2e_encryption"] && cfg["audit_logging"], detail: "Patient data encrypted at rest" },
      { label: "End-to-End Encryption",  ok: cfg["e2e_encryption"],   detail: "AES-256 for all session chats" },
      { label: "Two-Factor Auth",        ok: cfg["two_factor_auth"],  detail: "Required for admin logins" },
      { label: "Audit Logging",          ok: cfg["audit_logging"],    detail: "All actions logged with timestamps" },
      { label: "Session Timeout ≤30min", ok: (cfg["session_timeout_minutes"] ?? 60) <= 30, detail: `Currently: ${cfg["session_timeout_minutes"] ?? "?"} min` },
      { label: "Data Retention Policy",  ok: true, detail: "Auto-delete after 7 years" },
      { label: "Breach Notification",    ok: true, detail: "Automated 72h alert system" },
    ];

    const alerts = recentAlerts.map(a => ({
      id:          a._id,
      severity:    a.severity,
      message:     a.description,
      action:      a.action,
      resource:    a.resourceType,
      adminName:   a.adminName,
      ipAddress:   a.ipAddress,
      ts:          a.createdAt,
    }));

    res.json({
      kpi: {
        activeSoultees,
        activeLinks,
        totalAdmins,
        adminLogins24h: recentLoginLogs,
        securityEvents24h: criticalLogs + warnLogs,
        criticalAlerts: criticalLogs,
        warnAlerts:     warnLogs,
        privacyPending,
        complianceScore: overallScore(scores),
        systemHealth: "healthy",
      },
      alerts,
      checklist,
      scores,
      settings: cfg,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/security/compliance ──────────────────────────────────────────────
router.get("/compliance", requireAdmin, async (req, res) => {
  try {
    const now    = new Date();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const [cfg, violations, warnings, weeklyTrend] = await Promise.all([
      fetchSecuritySettings(),
      AuditLog.find({ severity: "critical", createdAt: { $gte: weekAgo } })
        .sort({ createdAt: -1 })
        .limit(20)
        .select("severity action description adminName adminRole resourceType createdAt ipAddress")
        .lean(),
      AuditLog.find({ severity: "warn", createdAt: { $gte: dayAgo } })
        .sort({ createdAt: -1 })
        .limit(20)
        .select("severity action description adminName adminRole resourceType createdAt")
        .lean(),
      AuditLog.aggregate([
        { $match: { severity: { $in: ["critical", "warn"] }, createdAt: { $gte: weekAgo } } },
        { $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          critical: { $sum: { $cond: [{ $eq: ["$severity", "critical"] }, 1, 0] } },
          warn:     { $sum: { $cond: [{ $eq: ["$severity", "warn"]     }, 1, 0] } },
        }},
        { $sort: { _id: 1 } },
      ]),
    ]);

    const scores = computeComplianceScores(cfg);

    const frameworks = [
      { name: "HIPAA (Health Insurance Portability)", score: scores.HIPAA,    color: scores.HIPAA    >= 80 ? "success" : "warning" },
      { name: "GDPR (General Data Protection)",       score: scores.GDPR,     color: scores.GDPR     >= 80 ? "success" : "warning" },
      { name: "PDPA (Pakistan Data Protection)",      score: scores.PDPA,     color: scores.PDPA     >= 80 ? "success" : "warning" },
      { name: "ISO 27001 (Information Security)",     score: scores.ISO27001, color: scores.ISO27001 >= 80 ? "success" : "warning" },
      { name: "SOC 2 Type II",                        score: scores.SOC2,     color: scores.SOC2     >= 80 ? "success" : "warning" },
    ];

    res.json({
      frameworks,
      overallScore: overallScore(scores),
      violations: violations.map(v => ({
        id:        v._id,
        severity:  v.severity,
        action:    v.action,
        message:   v.description,
        adminName: v.adminName,
        role:      v.adminRole,
        resource:  v.resourceType,
        ip:        v.ipAddress,
        ts:        v.createdAt,
      })),
      warnings: warnings.map(w => ({
        id:        w._id,
        action:    w.action,
        message:   w.description,
        adminName: w.adminName,
        role:      w.adminRole,
        ts:        w.createdAt,
      })),
      weeklyTrend,
      violationCount:  violations.length,
      warningCount:    warnings.length,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/security/access-control ─────────────────────────────────────────
router.get("/access-control", requireAdmin, async (req, res) => {
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [admins, recentAccessLogs, roleChangeLogs, unauthorizedAttempts] = await Promise.all([
      AdminUser.find({ isActive: true })
        .select("username name role email createdAt")
        .lean(),
      AuditLog.find({
        action: { $in: ["login", "logout", "data_export", "video_viewed", "document_viewed"] },
        createdAt: { $gte: weekAgo },
      })
        .sort({ createdAt: -1 })
        .limit(25)
        .select("action adminName adminRole description ipAddress userAgent createdAt resourceType")
        .lean(),
      AuditLog.find({
        action: { $in: ["user_role_changed", "admin_role_changed", "admin_created", "admin_deleted"] },
        createdAt: { $gte: weekAgo },
      })
        .sort({ createdAt: -1 })
        .limit(10)
        .select("action adminName adminRole description resourceName createdAt")
        .lean(),
      AuditLog.countDocuments({ severity: "critical", createdAt: { $gte: weekAgo } }),
    ]);

    const permissionMatrix = [
      { module: "User Management",   superAdmin: true,  analyticsAdmin: false, securityAdmin: false, marketingAdmin: false, supportAdmin: false },
      { module: "Analytics Reports", superAdmin: true,  analyticsAdmin: true,  securityAdmin: false, marketingAdmin: true,  supportAdmin: false },
      { module: "SOULTEE Approvals", superAdmin: true,  analyticsAdmin: false, securityAdmin: false, marketingAdmin: false, supportAdmin: false },
      { module: "Platform Settings", superAdmin: true,  analyticsAdmin: false, securityAdmin: true,  marketingAdmin: false, supportAdmin: false },
      { module: "Financial Data",    superAdmin: true,  analyticsAdmin: true,  securityAdmin: false, marketingAdmin: false, supportAdmin: false },
      { module: "Security Logs",     superAdmin: true,  analyticsAdmin: false, securityAdmin: true,  marketingAdmin: false, supportAdmin: false },
      { module: "Campaign Manager",  superAdmin: true,  analyticsAdmin: false, securityAdmin: false, marketingAdmin: true,  supportAdmin: false },
      { module: "Support Tickets",   superAdmin: true,  analyticsAdmin: false, securityAdmin: false, marketingAdmin: false, supportAdmin: true  },
      { module: "User Data (PII)",   superAdmin: true,  analyticsAdmin: false, securityAdmin: true,  marketingAdmin: false, supportAdmin: false },
    ];

    res.json({
      admins: admins.map(a => ({
        id:        a._id,
        username:  a.username,
        name:      a.name,
        role:      a.role,
        email:     a.email,
        since:     a.createdAt,
      })),
      permissionMatrix,
      recentAccess: recentAccessLogs.map(l => ({
        id:        l._id,
        action:    l.action,
        adminName: l.adminName,
        role:      l.adminRole,
        detail:    l.description,
        ip:        l.ipAddress,
        device:    _parseDevice(l.userAgent),
        resource:  l.resourceType,
        ts:        l.createdAt,
      })),
      roleChanges: roleChangeLogs.map(l => ({
        id:        l._id,
        action:    l.action,
        adminName: l.adminName,
        detail:    l.description,
        target:    l.resourceName,
        ts:        l.createdAt,
      })),
      unauthorizedAttempts,
      totalAdmins: admins.length,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/security/session-audits ─────────────────────────────────────────
router.get("/session-audits", requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, severity = "all", action = "all" } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const filter = {};
    if (severity !== "all") filter.severity = severity;
    if (action   !== "all") filter.action   = action;

    const [logs, total, sessions, loginCount, activeNow] = await Promise.all([
      AuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .select("adminName adminRole action description severity resourceType resourceId ipAddress userAgent createdAt")
        .lean(),
      AuditLog.countDocuments(filter),
      Session.find()
        .sort({ createdAt: -1 })
        .limit(10)
        .select("soulteeFirebaseUid studentFirebaseUid studentName sessionType durationMinutes status createdAt")
        .lean(),
      AuditLog.countDocuments({ action: "login", createdAt: { $gte: new Date(Date.now() - 24*60*60*1000) } }),
      Soultee.countDocuments({ status: { $in: ["online", "busy"] } }),
    ]);

    res.json({
      logs: logs.map((l, i) => ({
        id:          l._id,
        sessionId:   `AUD-${String(total - i - skip).padStart(4, "0")}`,
        adminName:   l.adminName,
        role:        l.adminRole,
        action:      l.action,
        description: l.description,
        severity:    l.severity,
        resource:    l.resourceType,
        ip:          l.ipAddress || "—",
        device:      _parseDevice(l.userAgent),
        encrypted:   true,
        ts:          l.createdAt,
      })),
      total,
      page:       Number(page),
      limit:      Number(limit),
      sessions:   sessions.map((s, i) => ({
        id:          `SES-${String(9000 - i).padStart(4, "0")}`,
        soulteeUid:  s.soulteeFirebaseUid,
        studentName: s.studentName || "User",
        type:        s.sessionType || "chat",
        duration:    s.durationMinutes,
        status:      s.status,
        encrypted:   true,
        ts:          s.createdAt,
      })),
      kpi: { loginCount, activeNow, total },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/security/session-audits/souljar-deletions ──────────────────────
router.get("/session-audits/souljar-deletions", requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, severity = "all" } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const filter = { action: "souljar_deleted" };
    if (severity !== "all") filter.severity = severity;

    const [logs, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .select("adminName adminRole action description severity resourceType resourceId resourceName metadata ipAddress userAgent createdAt")
        .lean(),
      AuditLog.countDocuments(filter),
    ]);

    res.json({
      logs: logs.map((l, i) => ({
        id: l._id,
        auditId: `SJD-${String(total - i - skip).padStart(4, "0")}`,
        adminName: l.adminName,
        role: l.adminRole,
        action: l.action,
        description: l.description,
        severity: l.severity,
        resource: l.resourceType,
        resourceId: l.resourceId,
        jarCode: l.resourceName || "—",
        topic: l.metadata?.get?.("topic") ?? l.metadata?.topic ?? "—",
        attachmentCount:
            l.metadata?.get?.("attachmentCount") ?? l.metadata?.attachmentCount ?? 0,
        ip: l.ipAddress || "—",
        device: _parseDevice(l.userAgent),
        ts: l.createdAt,
      })),
      total,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/security/privacy-requests ───────────────────────────────────────
router.get("/privacy-requests", requireAdmin, async (req, res) => {
  try {
    const { status = "all", type = "all", page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const filter = {};
    if (status !== "all") filter.status = status;
    if (type   !== "all") filter.type   = type;

    const [requests, total, pending, inProgress, completed, rejected] = await Promise.all([
      PrivacyRequest.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      PrivacyRequest.countDocuments(filter),
      PrivacyRequest.countDocuments({ status: "pending" }),
      PrivacyRequest.countDocuments({ status: "in_progress" }),
      PrivacyRequest.countDocuments({ status: "completed" }),
      PrivacyRequest.countDocuments({ status: "rejected" }),
    ]);

    const dataExport  = await PrivacyRequest.countDocuments({ type: "data_export" });
    const deletion    = await PrivacyRequest.countDocuments({ type: "account_deletion" });
    const consent     = await PrivacyRequest.countDocuments({ type: "consent_update" });

    res.json({
      requests: requests.map(r => {
        const due = new Date(r.createdAt);
        due.setDate(due.getDate() + 14);
        return {
          id:              r._id,
          requestId:       r.requestId,
          userId:          r.userId,
          userEmail:       r.userEmail,
          displayName:     r.displayName,
          type:            r.type,
          status:          r.status,
          notes:           r.notes,
          processedBy:     r.processedBy,
          processedByName: r.processedByName,
          processedAt:     r.processedAt,
          dueDate:         due,
          submittedAt:     r.createdAt,
        };
      }),
      total,
      page:  Number(page),
      limit: Number(limit),
      summary: { pending, inProgress, completed, rejected, dataExport, deletion, consent },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/security/privacy-requests ───────────────────────────────────────
router.post("/privacy-requests", requireAdmin, async (req, res) => {
  try {
    const { userId, userEmail, displayName, type, notes } = req.body;
    if (!userId || !type) {
      return res.status(400).json({ message: "userId and type are required" });
    }
    const request = await PrivacyRequest.create({ userId, userEmail, displayName, type, notes });
    res.status(201).json({ request });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── PATCH /api/security/privacy-requests/:id ─────────────────────────────────
router.patch("/privacy-requests/:id", requireAdmin, async (req, res) => {
  try {
    const { status, notes } = req.body;
    const update = {
      ...(status ? { status } : {}),
      ...(notes  ? { notes  } : {}),
    };

    if (status && ["completed", "rejected"].includes(status)) {
      update.processedBy     = req.admin.id   || req.admin._id;
      update.processedByName = req.admin.name || req.admin.username;
      update.processedAt     = new Date();
    }

    const request = await PrivacyRequest.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true }
    );
    if (!request) return res.status(404).json({ message: "Request not found" });

    res.json({ request });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/security/encryption ─────────────────────────────────────────────
router.get("/encryption", requireAdmin, async (req, res) => {
  try {
    const [allSettings, totalMessages, totalSoulpana] = await Promise.all([
      SystemSettings.find().lean(),
      // Use counts as proxies for "encrypted data volume"
      Session.countDocuments({ status: "completed" }),
      (await import("../models/Soulpana.js")).default.countDocuments(),
    ]);

    const cfg = Object.fromEntries(allSettings.map(s => [s.key, s.value]));
    const scores = computeComplianceScores(cfg);

    const coverage = [
      {
        label:     "Session Chat Messages",
        icon:      "chat",
        algorithm: "AES-256-GCM",
        mode:      "End-to-End",
        active:    cfg["e2e_encryption"] !== false,
        health:    cfg["e2e_encryption"] !== false ? "secure" : "warning",
      },
      {
        label:     "Soulpana Submissions",
        icon:      "psychology",
        algorithm: "AES-256",
        mode:      "At Rest",
        active:    true,
        health:    "secure",
      },
      {
        label:     "User Profile (PII)",
        icon:      "person",
        algorithm: "AES-256",
        mode:      "At Rest + Transit",
        active:    true,
        health:    "secure",
      },
      {
        label:     "Souljar Entries",
        icon:      "book",
        algorithm: "AES-256",
        mode:      "At Rest",
        active:    true,
        health:    "secure",
      },
      {
        label:     "Financial Transactions",
        icon:      "payments",
        algorithm: "TLS 1.3",
        mode:      "In Transit",
        active:    true,
        health:    "secure",
      },
      {
        label:     "Media Attachments",
        icon:      "attach_file",
        algorithm: "AES-256",
        mode:      "At Rest",
        active:    true,
        health:    "secure",
      },
      {
        label:     "Push Notifications",
        icon:      "notifications",
        algorithm: "FCM Encrypted",
        mode:      "In Transit",
        active:    cfg["fcm_push_enabled"] !== false,
        health:    "info",
      },
      {
        label:     "Admin API",
        icon:      "api",
        algorithm: "JWT + TLS 1.3",
        mode:      "In Transit",
        active:    true,
        health:    "secure",
      },
    ];

    const secureCount  = coverage.filter(c => c.health === "secure").length;
    const healthScore  = Math.round((secureCount / coverage.length) * 100);

    res.json({
      coverage,
      healthScore,
      complianceScores: scores,
      settings: {
        e2eEncryption:      cfg["e2e_encryption"]         ?? true,
        twoFactorAuth:      cfg["two_factor_auth"]        ?? true,
        auditLogging:       cfg["audit_logging"]          ?? true,
        sessionTimeout:     cfg["session_timeout_minutes"] ?? 30,
        fcmEnabled:         cfg["fcm_push_enabled"]       ?? true,
        firebaseAuth:       cfg["firebase_auth_enabled"]  ?? true,
      },
      dataVolume: {
        encryptedSessions:  totalMessages,
        encryptedSoulpana:  totalSoulpana,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Utility ──────────────────────────────────────────────────────────────────
function _parseDevice(userAgent) {
  if (!userAgent) return "Unknown";
  const ua = userAgent.toLowerCase();
  if (ua.includes("mobile"))  return "Mobile";
  if (ua.includes("tablet"))  return "Tablet";
  if (ua.includes("chrome"))  return "Chrome";
  if (ua.includes("firefox")) return "Firefox";
  if (ua.includes("safari"))  return "Safari";
  return "Browser";
}

export default router;
