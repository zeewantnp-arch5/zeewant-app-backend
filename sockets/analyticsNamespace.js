import jwt from "jsonwebtoken";
import Soultee from "../models/Soultee.js";
import Session from "../models/Session.js";
import Soulpana from "../models/Soulpana.js";
import Souljar from "../models/souljar.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";
import admin from "../config/firebase.js";

const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret";
const ANALYTICS_ALLOWED_ROLES = new Set(["superAdmin", "analyticsAdmin"]);
const souljarEmitDedupe = new Map();

function cleanupSouljarDedupe() {
  const now = Date.now();
  for (const [key, ts] of souljarEmitDedupe.entries()) {
    if (now - ts > 60_000) {
      souljarEmitDedupe.delete(key);
    }
  }
}

function getFirestoreDb() {
  if (!admin.apps.length) return null;
  return admin.firestore();
}

function computeScore(sessionCount, rating) {
  return Math.round(Math.min(60, sessionCount / 2) + Math.min(40, rating * 8));
}

// ── Snapshot builders ─────────────────────────────────────────────────────────

async function buildDashboardSnapshot() {
  const [
    activeSoultees,
    totalSoultees,
    totalSessions,
    completedSessions,
    activeLinks,
    totalSoulpana,
    pendingSoulpana,
    revPipe,
  ] = await Promise.all([
    Soultee.countDocuments({ status: { $in: ["online", "busy"] } }),
    Soultee.countDocuments(),
    Session.countDocuments(),
    Session.countDocuments({ status: "completed" }),
    StudentSoulteeLink.countDocuments({ status: "active" }),
    Soulpana.countDocuments(),
    Soulpana.countDocuments({ status: "pending" }),
    Session.aggregate([
      { $match: { status: "completed" } },
      { $group: { _id: null, total: { $sum: "$sessionFee" } } },
    ]),
  ]);

  let totalUsers = totalSoultees + activeLinks;
  try {
    const db = getFirestoreDb();
    if (db) {
      const snap = await db.collection("users").count().get();
      totalUsers = snap.data().count;
    }
  } catch { /* fallback already set */ }

  return {
    type: "dashboard",
    ts: Date.now(),
    totalUsers,
    activeSoultees,
    totalSoultees,
    totalSessions,
    completedSessions,
    activeLinks,
    totalSoulpana,
    pendingSoulpana,
    totalRevenue: revPipe[0]?.total ?? 0,
    systemHealth: "healthy",
    uptime: Math.round(process.uptime()),
  };
}

async function buildBadgeSummary() {
  const [soultees, sessionCounts] = await Promise.all([
    Soultee.find().select("firebaseUid rating").lean(),
    Session.aggregate([
      { $match: { status: "completed" } },
      { $group: { _id: "$soulteeFirebaseUid", sessions: { $sum: 1 } } },
    ]),
  ]);

  const sessionMap = Object.fromEntries(sessionCounts.map(s => [s._id, s.sessions]));
  const summary = { Diamond: 0, Gold: 0, Silver: 0 };

  for (const s of soultees) {
    const score = computeScore(sessionMap[s.firebaseUid] || 0, s.rating || 0);
    const badge = score >= 90 ? "Diamond" : score >= 75 ? "Gold" : "Silver";
    summary[badge]++;
  }

  return { type: "badges", ts: Date.now(), ...summary, total: soultees.length };
}

async function buildSoulpanaUpdate() {
  const [total, pending, answered] = await Promise.all([
    Soulpana.countDocuments(),
    Soulpana.countDocuments({ status: "pending" }),
    Soulpana.countDocuments({ status: "answered" }),
  ]);
  return { type: "soulpana_update", ts: Date.now(), total, pending, answered };
}

export async function buildSouljarRealtimeSummary() {
  const [dailyTotal, weeklyTotal, monthlyTotal] = await Promise.all([
    Souljar.countDocuments({
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    }),
    Souljar.countDocuments({
      createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    }),
    Souljar.countDocuments({
      createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    }),
  ]);

  return {
    type: "souljar_update",
    ts: Date.now(),
    summary: {
      dailyTotal,
      weeklyTotal,
      monthlyTotal,
    },
  };
}

export async function emitSouljarAnalyticsUpdate(io, sourceDoc = null) {
  try {
    const ns = io.of("/analytics");
    if (!ns || ns.sockets.size === 0) return;

    const dedupeKey = sourceDoc?._id?.toString();
    if (dedupeKey) {
      cleanupSouljarDedupe();
      if (souljarEmitDedupe.has(dedupeKey)) return;
      souljarEmitDedupe.set(dedupeKey, Date.now());
    }

    const summary = await buildSouljarRealtimeSummary();
    ns.to("analytics_room").emit("analytics_snapshot", summary);

    if (sourceDoc) {
      const liveEntry = {
        type: "souljar_live_entry",
        ts: Date.now(),
        entry: {
          id: sourceDoc._id,
          jarCode: sourceDoc.jarCode,
          category: String(sourceDoc.topic || "Uncategorized"),
          mood: String(sourceDoc.mood || "Unknown"),
          anonymous: !!sourceDoc.anonymous,
          wordCount: sourceDoc.wordCount || 0,
          reflectionSeconds: sourceDoc.reflectionSeconds || 0,
          createdAt: sourceDoc.createdAt || new Date(),
          attachmentUrls: sourceDoc.attachmentUrls || [],
        },
      };
      ns.to("analytics_room").emit("analytics_snapshot", liveEntry);
    }
  } catch (err) {
    console.error("Analytics Souljar emit error:", err.message);
  }
}

// ── Namespace registration ────────────────────────────────────────────────────

export function registerAnalyticsNamespace(io) {
  const ns = io.of("/analytics");

  // JWT authentication for every connecting socket
  ns.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.query?.token;
    if (!token) return next(new Error("No analytics token"));
    try {
      socket.data.admin = jwt.verify(token, JWT_SECRET);
      if (!ANALYTICS_ALLOWED_ROLES.has(socket.data.admin?.role)) {
        return next(new Error("Insufficient permissions"));
      }
      next();
    } catch {
      next(new Error("Unauthorized analytics token"));
    }
  });

  ns.on("connection", async (socket) => {
    socket.join("analytics_room");
    const adminId = socket.data.admin?.username || socket.id;
    console.log(`📊 Analytics connected: ${adminId}`);

    // Push initial snapshots immediately on connect
    try {
      const [dash, badges] = await Promise.all([
        buildDashboardSnapshot(),
        buildBadgeSummary(),
      ]);
      socket.emit("analytics_snapshot", dash);
      socket.emit("analytics_snapshot", badges);
    } catch (err) {
      console.error("Analytics initial snapshot error:", err.message);
    }

    socket.on("disconnect", () => {
      console.log(`📊 Analytics disconnected: ${adminId}`);
    });
  });

  // ── 30-second periodic push ───────────────────────────────────────────────
  const pushInterval = setInterval(async () => {
    if (ns.sockets.size === 0) return;
    try {
      const dash = await buildDashboardSnapshot();
      ns.to("analytics_room").emit("analytics_snapshot", dash);
    } catch (err) {
      console.error("Analytics periodic push error:", err.message);
    }
  }, 30_000);

  // ── MongoDB Change Streams (requires Atlas/replica set; fails gracefully) ──
  let sessionStream = null;
  let soulpanaStream = null;
  let souljarStream = null;

  const setupChangeStreams = () => {
    try {
      sessionStream = Session.watch(
        [{ $match: { operationType: { $in: ["insert", "update"] } } }],
        { fullDocument: "updateLookup" }
      );

      sessionStream.on("change", async () => {
        if (ns.sockets.size === 0) return;
        try {
          const dash = await buildDashboardSnapshot();
          ns.to("analytics_room").emit("analytics_snapshot", dash);
        } catch { /* suppress */ }
      });

      sessionStream.on("error", (err) => {
        console.warn("Analytics session stream error:", err.message);
        sessionStream?.close();
        sessionStream = null;
      });

      soulpanaStream = Soulpana.watch(
        [{ $match: { operationType: "insert" } }]
      );

      soulpanaStream.on("change", async () => {
        if (ns.sockets.size === 0) return;
        try {
          const update = await buildSoulpanaUpdate();
          ns.to("analytics_room").emit("analytics_snapshot", update);
        } catch { /* suppress */ }
      });

      soulpanaStream.on("error", (err) => {
        console.warn("Analytics soulpana stream error:", err.message);
        soulpanaStream?.close();
        soulpanaStream = null;
      });

      souljarStream = Souljar.watch(
        [{ $match: { operationType: "insert" } }],
        { fullDocument: "updateLookup" }
      );

      souljarStream.on("change", async (change) => {
        if (ns.sockets.size === 0) return;
        try {
          await emitSouljarAnalyticsUpdate(io, change.fullDocument);
        } catch { /* suppress */ }
      });

      souljarStream.on("error", (err) => {
        console.warn("Analytics souljar stream error:", err.message);
        souljarStream?.close();
        souljarStream = null;
      });

      console.log("📊 Analytics change streams active");
    } catch (err) {
      console.log("📊 Analytics change streams unavailable — polling only:", err.message);
    }
  };

  // Delay setup slightly so server is fully started
  setTimeout(setupChangeStreams, 3000);

  // Return cleanup function (used in tests / graceful shutdown)
  return () => {
    clearInterval(pushInterval);
    sessionStream?.close();
    soulpanaStream?.close();
    souljarStream?.close();
  };
}
