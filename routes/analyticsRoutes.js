import express from "express";
import jwt from "jsonwebtoken";
import Soultee from "../models/Soultee.js";
import Session from "../models/Session.js";
import Soulpana from "../models/Soulpana.js";
import Souljar from "../models/souljar.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";
import SoulteeApplication from "../models/SoulteeApplication.js";
import admin from "../config/firebase.js";

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret";

// ─── Auth middleware ──────────────────────────────────────────────────────────
const requireAdmin = (req, res, next) => {
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ message: "No token provided" });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getDateRange(period, start, end) {
  const now = new Date();
  if (start && end) return { since: new Date(start), until: new Date(end) };
  switch (period) {
    case "daily":   return { since: new Date(now - 24 * 60 * 60 * 1000), until: now };
    case "monthly": return { since: new Date(now.getFullYear(), now.getMonth(), 1), until: now };
    default:        return { since: new Date(now - 7 * 24 * 60 * 60 * 1000), until: now };
  }
}

function getFirestoreDb() {
  if (!admin.apps.length) return null;
  return admin.firestore();
}

function computePerformanceScore(sessionCount, rating) {
  const sessionScore = Math.min(60, sessionCount / 2);
  const ratingScore  = Math.min(40, rating * 8);
  return Math.round(sessionScore + ratingScore);
}

function assignBadge(score) {
  if (score >= 90) return "Diamond";
  if (score >= 75) return "Gold";
  return "Silver";
}

// ── GET /api/analytics/dashboard ─────────────────────────────────────────────
router.get("/dashboard", requireAdmin, async (req, res) => {
  try {
    const { period = "weekly", start, end } = req.query;
    const { since, until } = getDateRange(period, start, end);
    const now      = new Date();
    const weekAgo  = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const [
      activeSoultees,
      totalSoultees,
      totalSessions,
      completedSessions,
      sessionsSince,
      activeLinks,
      totalSoulpana,
      soulpanaSince,
      revenuePipe,
      revenueSincePipe,
      weeklyTrend,
      soulpanaCategories,
    ] = await Promise.all([
      Soultee.countDocuments({ status: { $in: ["online", "busy"] } }),
      Soultee.countDocuments(),
      Session.countDocuments(),
      Session.countDocuments({ status: "completed" }),
      Session.countDocuments({ createdAt: { $gte: since, $lte: until } }),
      StudentSoulteeLink.countDocuments({ status: "active" }),
      Soulpana.countDocuments(),
      Soulpana.countDocuments({ createdAt: { $gte: since, $lte: until } }),
      Session.aggregate([
        { $match: { status: "completed" } },
        { $group: { _id: null, total: { $sum: "$sessionFee" } } },
      ]),
      Session.aggregate([
        { $match: { status: "completed", createdAt: { $gte: since, $lte: until } } },
        { $group: { _id: null, total: { $sum: "$sessionFee" } } },
      ]),
      Session.aggregate([
        { $match: { createdAt: { $gte: weekAgo } } },
        { $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 },
        }},
        { $sort: { _id: 1 } },
      ]),
      Soulpana.aggregate([
        { $group: { _id: "$category", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
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

    res.json({
      period,
      kpi: {
        totalUsers,
        activeSoultees,
        totalSoultees,
        totalSessions,
        completedSessions,
        sessionsSince,
        activeLinks,
        totalSoulpana,
        soulpanaSince,
        totalRevenue:  revenuePipe[0]?.total ?? 0,
        periodRevenue: revenueSincePipe[0]?.total ?? 0,
        completionRate: totalSessions > 0
          ? Math.round((completedSessions / totalSessions) * 100)
          : 0,
        systemHealth: "healthy",
        uptime: Math.round(process.uptime()),
      },
      weeklyTrend,
      soulpanaCategories: soulpanaCategories.map(c => ({
        category: c._id || "General",
        count: c.count,
      })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/analytics/app-performance ───────────────────────────────────────
router.get("/app-performance", requireAdmin, async (req, res) => {
  try {
    const { period = "weekly", start, end } = req.query;
    const { since, until } = getDateRange(period, start, end);

    const [
      activeSoultees,
      totalSoultees,
      categoryBreakdown,
      sessionsByStatus,
      soulpanaSince,
      souljarSince,
      linksSince,
      sessionsTrend,
    ] = await Promise.all([
      Soultee.countDocuments({ status: { $in: ["online", "busy"] } }),
      Soultee.countDocuments(),
      SoulteeApplication.aggregate([
        { $match: { status: "approved" } },
        { $group: { _id: "$category", count: { $sum: 1 } } },
      ]),
      Session.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      Soulpana.countDocuments({ createdAt: { $gte: since, $lte: until } }),
      Souljar.countDocuments({ createdAt: { $gte: since, $lte: until } }),
      StudentSoulteeLink.countDocuments({ createdAt: { $gte: since, $lte: until } }),
      Session.aggregate([
        { $match: { createdAt: { $gte: since, $lte: until } } },
        { $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 },
        }},
        { $sort: { _id: 1 } },
      ]),
    ]);

    const catMap = Object.fromEntries(categoryBreakdown.map(c => [c._id || "Unknown", c.count]));
    const peerCount    = catMap["Peer Counsellor"] || catMap["peer_counsellor"] || catMap["Peer"] || 0;
    const coachCount   = catMap["Coach"] || catMap["coach"] || 0;
    const warriorCount = catMap["Life Warrior"] || catMap["life_warrior"] || catMap["Warrior"] || 0;
    const totalOnboarded = peerCount + coachCount + warriorCount || totalSoultees;

    const statusMap = Object.fromEntries(sessionsByStatus.map(s => [s._id, s.count]));
    const totalSessions = Object.values(statusMap).reduce((a, b) => a + b, 0);

    const sessionPeriodCount = sessionsTrend.reduce((s, d) => s + d.count, 0);
    const maxActivity = Math.max(soulpanaSince, souljarSince, linksSince, sessionPeriodCount, 1);

    res.json({
      period,
      activeSoultees,
      totalSoultees,
      onlineRatio: totalSoultees > 0 ? Math.round((activeSoultees / totalSoultees) * 100) : 0,
      soulteesByCategory: {
        peerCount,
        coachCount,
        warriorCount,
        totalOnboarded,
      },
      sessions: { ...statusMap, total: totalSessions },
      featureUsage: [
        { feature: "Soulpana (Questions)", count: soulpanaSince,       ratio: soulpanaSince / maxActivity },
        { feature: "Session Chat",         count: sessionPeriodCount,  ratio: sessionPeriodCount / maxActivity },
        { feature: "Souljar (Journal)",    count: souljarSince,        ratio: souljarSince / maxActivity },
        { feature: "New Connections",      count: linksSince,          ratio: linksSince / maxActivity },
      ],
      sessionsTrend,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/analytics/badges ─────────────────────────────────────────────────
router.get("/badges", requireAdmin, async (req, res) => {
  try {
    const [soultees, sessionCounts] = await Promise.all([
      Soultee.find()
        .select("firebaseUid name category rating totalFeedbacks status")
        .lean(),
      Session.aggregate([
        { $match: { status: "completed" } },
        { $group: { _id: "$soulteeFirebaseUid", sessions: { $sum: 1 } } },
      ]),
    ]);

    const sessionMap = Object.fromEntries(sessionCounts.map(s => [s._id, s.sessions]));

    const enriched = soultees.map(s => {
      const sessionCount = sessionMap[s.firebaseUid] || 0;
      const rating       = s.rating || 0;
      const score        = computePerformanceScore(sessionCount, rating);
      const badge        = assignBadge(score);
      return {
        uid:          s.firebaseUid,
        name:         s.name || "Unknown",
        category:     s.category || "Peer Counsellor",
        status:       s.status || "offline",
        sessionCount,
        rating:       Math.round(rating * 10) / 10,
        totalRatings: s.totalFeedbacks || 0,
        score,
        badge,
      };
    }).sort((a, b) => b.score - a.score);

    const summary = enriched.reduce(
      (acc, s) => { acc[s.badge] = (acc[s.badge] || 0) + 1; return acc; },
      { Diamond: 0, Gold: 0, Silver: 0 }
    );

    res.json({ soultees: enriched, summary });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/analytics/financial ─────────────────────────────────────────────
router.get("/financial", requireAdmin, async (req, res) => {
  try {
    const { period = "weekly", start, end } = req.query;
    const { since, until } = getDateRange(period, start, end);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      totalRevenuePipe,
      periodRevenuePipe,
      monthRevenuePipe,
      totalCompleted,
      periodCompleted,
      revenueTrend,
      recentSessions,
    ] = await Promise.all([
      Session.aggregate([
        { $match: { status: "completed" } },
        { $group: { _id: null, total: { $sum: "$sessionFee" } } },
      ]),
      Session.aggregate([
        { $match: { status: "completed", createdAt: { $gte: since, $lte: until } } },
        { $group: { _id: null, total: { $sum: "$sessionFee" } } },
      ]),
      Session.aggregate([
        { $match: { status: "completed", createdAt: { $gte: monthStart } } },
        { $group: { _id: null, total: { $sum: "$sessionFee" } } },
      ]),
      Session.countDocuments({ status: "completed" }),
      Session.countDocuments({ status: "completed", createdAt: { $gte: since, $lte: until } }),
      Session.aggregate([
        { $match: { createdAt: { $gte: since, $lte: until } } },
        { $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          revenue: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, "$sessionFee", 0] } },
          count:   { $sum: 1 },
        }},
        { $sort: { _id: 1 } },
      ]),
      Session.find({ status: "completed" })
        .sort({ createdAt: -1 })
        .limit(10)
        .select("studentFirebaseUid soulteeFirebaseUid sessionFee status createdAt sessionType")
        .lean(),
    ]);

    const totalRevenue  = totalRevenuePipe[0]?.total ?? 0;
    const periodRevenue = periodRevenuePipe[0]?.total ?? 0;
    const monthRevenue  = monthRevenuePipe[0]?.total ?? 0;
    const avgFee        = totalCompleted > 0 ? Math.round(totalRevenue / totalCompleted) : 0;

    const transactions = recentSessions.map((s, i) => ({
      id:     `TXN-${String(totalCompleted - i).padStart(4, "0")}`,
      userId: `user_${(s.studentFirebaseUid || "").slice(-4) || "????"}`,
      type:   "Session Payment",
      amount: s.sessionFee || 0,
      date:   s.createdAt,
      status: "Completed",
    }));

    res.json({
      period,
      summary: {
        totalRevenue,
        periodRevenue,
        monthRevenue,
        totalCompleted,
        periodCompleted,
        avgFee,
        currency: "PKR",
      },
      revenueTrend,
      transactions,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/analytics/engagement ─────────────────────────────────────────────
router.get("/engagement", requireAdmin, async (req, res) => {
  try {
    const { period = "weekly", start, end } = req.query;
    const { since, until } = getDateRange(period, start, end);

    const [
      activeSoultees,
      activeLinks,
      soulpanaSince,
      souljarSince,
      sessionsSince,
      linksSince,
      avgDurationPipe,
      activityTrend,
    ] = await Promise.all([
      Soultee.countDocuments({ status: { $in: ["online", "busy"] } }),
      StudentSoulteeLink.countDocuments({ status: "active" }),
      Soulpana.countDocuments({ createdAt: { $gte: since, $lte: until } }),
      Souljar.countDocuments({ createdAt: { $gte: since, $lte: until } }),
      Session.countDocuments({ createdAt: { $gte: since, $lte: until } }),
      StudentSoulteeLink.countDocuments({ createdAt: { $gte: since, $lte: until } }),
      Session.aggregate([
        { $match: { status: "completed", durationMinutes: { $exists: true, $gt: 0 } } },
        { $group: { _id: null, avg: { $avg: "$durationMinutes" } } },
      ]),
      Session.aggregate([
        { $match: { createdAt: { $gte: since, $lte: until } } },
        { $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          sessions: { $sum: 1 },
        }},
        { $sort: { _id: 1 } },
      ]),
    ]);

    const avgDuration = Math.round(avgDurationPipe[0]?.avg ?? 22);

    res.json({
      period,
      kpi: {
        activeSoultees,
        activeLinks,
        soulpanaSince,
        souljarSince,
        sessionsSince,
        linksSince,
        avgDuration,
      },
      activityTrend,
      breakdown: [
        { label: "Sessions",        count: sessionsSince  },
        { label: "Soulpana Posts",  count: soulpanaSince  },
        { label: "Journal Entries", count: souljarSince   },
        { label: "New Connections", count: linksSince     },
      ],
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/analytics/soulpana ───────────────────────────────────────────────
router.get("/soulpana", requireAdmin, async (req, res) => {
  try {
    const { period = "weekly", start, end } = req.query;
    const { since, until } = getDateRange(period, start, end);

    const [
      totalCount,
      pendingCount,
      answeredCount,
      submissionsSince,
      categoryBreakdown,
      submissionTrend,
      recent,
    ] = await Promise.all([
      Soulpana.countDocuments(),
      Soulpana.countDocuments({ status: "pending" }),
      Soulpana.countDocuments({ status: "answered" }),
      Soulpana.countDocuments({ createdAt: { $gte: since, $lte: until } }),
      Soulpana.aggregate([
        { $group: { _id: "$category", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Soulpana.aggregate([
        { $match: { createdAt: { $gte: since, $lte: until } } },
        { $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 },
        }},
        { $sort: { _id: 1 } },
      ]),
      Soulpana.find()
        .sort({ createdAt: -1 })
        .limit(8)
        .select("title category status assignedSoulteeUid createdAt")
        .lean(),
    ]);

    const closedCount     = totalCount - pendingCount - answeredCount;
    const resolvedCount   = answeredCount + closedCount;
    const resolutionRate  = totalCount > 0 ? Math.round((resolvedCount / totalCount) * 100) : 0;

    res.json({
      period,
      summary: {
        total:          totalCount,
        pending:        pendingCount,
        answered:       answeredCount,
        closed:         closedCount,
        submissionsSince,
        resolutionRate,
      },
      categoryBreakdown: categoryBreakdown.map(c => ({
        category: c._id || "General",
        count:    c.count,
        ratio:    totalCount > 0 ? c.count / totalCount : 0,
      })),
      submissionTrend,
      recent: recent.map(s => ({
        id:       s._id,
        title:    (s.title || "Untitled").slice(0, 60),
        category: s.category || "General",
        status:   s.status || "pending",
        assigned: !!s.assignedSoulteeUid,
        date:     s.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
