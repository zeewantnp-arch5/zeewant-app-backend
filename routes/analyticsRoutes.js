import express from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import Soultee from "../models/Soultee.js";
import Session from "../models/Session.js";
import Soulpana from "../models/Soulpana.js";
import Souljar from "../models/souljar.js";
import AuditLog from "../models/AuditLog.js";
import Payment from "../models/Payment.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";
import SoulteeApplication from "../models/SoulteeApplication.js";
import admin from "../config/firebase.js";

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret";
const ANALYTICS_ALLOWED_ROLES = new Set(["superAdmin", "analyticsAdmin"]);

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

const requireAnalyticsAccess = (req, res, next) => {
  const role = req.admin?.role;
  if (!ANALYTICS_ALLOWED_ROLES.has(role)) {
    return res.status(403).json({ message: "Insufficient permissions" });
  }
  next();
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

function normalizeSouljarCategory(topic = "") {
  return String(topic || "").trim() || "Uncategorized";
}

function extractStoragePathFromUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(String(url));
    // Firebase download URL format: /v0/b/<bucket>/o/<encodedPath>
    if (parsed.pathname.includes('/o/')) {
      const encoded = parsed.pathname.split('/o/')[1] || '';
      const decoded = decodeURIComponent(encoded);
      return decoded || null;
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeSegment(rawSegment = "all") {
  const segment = String(rawSegment || "all").trim().toLowerCase();
  const allowed = new Set([
    "all",
    "anonymous",
    "identified",
    "high_reflection",
    "with_attachments",
  ]);
  return allowed.has(segment) ? segment : "all";
}

function segmentFilter(segment) {
  switch (segment) {
    case "anonymous":
      return { anonymous: true };
    case "identified":
      return { anonymous: { $ne: true } };
    case "high_reflection":
      return { reflectionSeconds: { $gte: 120 } };
    case "with_attachments":
      return {
        $or: [
          { imagePath: { $exists: true, $nin: [null, ""] } },
          { "attachmentNames.0": { $exists: true } },
          { "attachmentUrls.0": { $exists: true } },
        ],
      };
    default:
      return {};
  }
}

function anonymizeUser(userId, anonymous) {
  if (anonymous) return "Anonymous";
  const hash = crypto
    .createHash("sha1")
    .update(String(userId || "unknown"))
    .digest("hex")
    .slice(0, 8)
    .toUpperCase();
  return `User-${hash}`;
}

// ── GET /api/analytics/dashboard ─────────────────────────────────────────────
router.get("/dashboard", requireAdmin, requireAnalyticsAccess, async (req, res) => {
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
router.get("/app-performance", requireAdmin, requireAnalyticsAccess, async (req, res) => {
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
router.get("/badges", requireAdmin, requireAnalyticsAccess, async (req, res) => {
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
router.get("/financial", requireAdmin, requireAnalyticsAccess, async (req, res) => {
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
router.get("/engagement", requireAdmin, requireAnalyticsAccess, async (req, res) => {
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
router.get("/soulpana", requireAdmin, requireAnalyticsAccess, async (req, res) => {
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

// ── GET /api/analytics/souljar ───────────────────────────────────────────────
router.get("/souljar", requireAdmin, requireAnalyticsAccess, async (req, res) => {
  try {
    const {
      period = "weekly",
      start,
      end,
      category,
      segment = "all",
      limit = "12",
    } = req.query;

    const { since, until } = getDateRange(period, start, end);
    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 12, 5), 50);
    const normalizedSegment = normalizeSegment(segment);

    const scopedFilter = {
      createdAt: { $gte: since, $lte: until },
      ...segmentFilter(normalizedSegment),
    };

    if (category && String(category).trim().toLowerCase() !== "all") {
      scopedFilter.topic = String(category).trim();
    }

    const dailySince = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const weeklySince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const monthlySince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalAll,
      totalSince,
      dailyTotal,
      weeklyTotal,
      monthlyTotal,
      uniqueUsersRaw,
      categoryBreakdownRaw,
      submissionTrend,
      moodTrendRaw,
      heatmapRaw,
      recentRaw,
      reflectionSummary,
      attachmentCount,
      anonymousCount,
    ] = await Promise.all([
      Souljar.countDocuments(),
      Souljar.countDocuments(scopedFilter),
      Souljar.countDocuments({ createdAt: { $gte: dailySince } }),
      Souljar.countDocuments({ createdAt: { $gte: weeklySince } }),
      Souljar.countDocuments({ createdAt: { $gte: monthlySince } }),
      Souljar.distinct("userId", scopedFilter),
      Souljar.aggregate([
        { $match: scopedFilter },
        { $group: { _id: "$topic", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Souljar.aggregate([
        { $match: scopedFilter },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Souljar.aggregate([
        { $match: scopedFilter },
        {
          $group: {
            _id: {
              date: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
              mood: "$mood",
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.date": 1 } },
      ]),
      Souljar.aggregate([
        { $match: scopedFilter },
        {
          $group: {
            _id: { hour: { $hour: "$createdAt" } },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.hour": 1 } },
      ]),
      Souljar.find(scopedFilter)
        .sort({ createdAt: -1 })
        .limit(parsedLimit)
        .select("topic mood anonymous wordCount reflectionSeconds createdAt userId jarCode text ocrText attachmentUrls")
        .lean(),
      Souljar.aggregate([
        { $match: scopedFilter },
        {
          $group: {
            _id: null,
            avgReflectionSeconds: { $avg: "$reflectionSeconds" },
            avgWordCount: { $avg: "$wordCount" },
          },
        },
      ]),
      Souljar.countDocuments({
        ...scopedFilter,
        $or: [
          { imagePath: { $exists: true, $nin: [null, ""] } },
          { "attachmentNames.0": { $exists: true } },
          { "attachmentUrls.0": { $exists: true } },
        ],
      }),
      Souljar.countDocuments({ ...scopedFilter, anonymous: true }),
    ]);

    const categoryBreakdown = categoryBreakdownRaw.map((c) => ({
      category: normalizeSouljarCategory(c._id),
      count: c.count,
      ratio: totalSince > 0 ? c.count / totalSince : 0,
    }));

    const moodByDay = {};
    for (const row of moodTrendRaw) {
      const date = row._id?.date;
      const mood = String(row._id?.mood || "Unknown").trim() || "Unknown";
      if (!date) continue;
      moodByDay[date] ??= { _id: date, moods: {}, total: 0 };
      moodByDay[date].moods[mood] = (moodByDay[date].moods[mood] || 0) + row.count;
      moodByDay[date].total += row.count;
    }

    const heatmap = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
    for (const row of heatmapRaw) {
      const hour = Number(row._id?.hour);
      if (Number.isInteger(hour) && hour >= 0 && hour < 24) {
        heatmap[hour].count = row.count;
      }
    }

    const uniqueUsers = uniqueUsersRaw.length;
    const avgReflectionSeconds = Math.round(reflectionSummary[0]?.avgReflectionSeconds || 0);
    const avgWordCount = Math.round(reflectionSummary[0]?.avgWordCount || 0);

    res.json({
      period,
      filters: {
        start: since.toISOString(),
        end: until.toISOString(),
        category: category ? String(category) : "All",
        segment: normalizedSegment,
      },
      summary: {
        totalAll,
        totalSince,
        dailyTotal,
        weeklyTotal,
        monthlyTotal,
      },
      participation: {
        uniqueUsers,
        entriesPerUser: uniqueUsers > 0 ? Number((totalSince / uniqueUsers).toFixed(2)) : 0,
        anonymousShare: totalSince > 0 ? Number((anonymousCount / totalSince).toFixed(4)) : 0,
        avgReflectionSeconds,
        avgWordCount,
        attachmentRate: totalSince > 0 ? Number((attachmentCount / totalSince).toFixed(4)) : 0,
      },
      categoryBreakdown,
      submissionTrend,
      moodTrend: Object.values(moodByDay),
      hourlyHeatmap: heatmap,
      recentActivity: recentRaw.map((entry) => ({
        id: entry._id,
        jarCode: entry.jarCode,
        category: normalizeSouljarCategory(entry.topic),
        mood: String(entry.mood || "Unknown").trim() || "Unknown",
        anonymous: !!entry.anonymous,
        actor: anonymizeUser(entry.userId, entry.anonymous),
        text: String(entry.text || "").trim(),
        ocrText: String(entry.ocrText || "").trim(),
        wordCount: entry.wordCount || 0,
        reflectionSeconds: entry.reflectionSeconds || 0,
        createdAt: entry.createdAt,
        attachmentUrls: entry.attachmentUrls || [],
      })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/analytics/payments ───────────────────────────────────────────────
router.get("/payments", requireAdmin, requireAnalyticsAccess, async (req, res) => {
  try {
    const [
      esewaTotal, esewaSuccess, esewaFailed,   esewaRevPipe,
      khaltiTotal, khaltiSuccess, khaltiFailure, khaltiRevPipe,
      cosTotal, cosPending, cosApproved, cosRejected, cosRevPipe,
    ] = await Promise.all([
      Payment.countDocuments({ method: "esewa" }),
      Payment.countDocuments({ method: "esewa", status: "completed" }),
      Payment.countDocuments({ method: "esewa", status: "failed" }),
      Payment.aggregate([{ $match: { method: "esewa", status: "completed" } }, { $group: { _id: null, t: { $sum: "$amount" } } }]),
      Payment.countDocuments({ method: "khalti" }),
      Payment.countDocuments({ method: "khalti", status: "completed" }),
      Payment.countDocuments({ method: "khalti", status: "failed" }),
      Payment.aggregate([{ $match: { method: "khalti", status: "completed" } }, { $group: { _id: null, t: { $sum: "$amount" } } }]),
      Payment.countDocuments({ method: "cos" }),
      Payment.countDocuments({ method: "cos", verificationStatus: "pending_verification" }),
      Payment.countDocuments({ method: "cos", verificationStatus: "verified" }),
      Payment.countDocuments({ method: "cos", verificationStatus: "rejected" }),
      Payment.aggregate([{ $match: { method: "cos", status: "completed" } }, { $group: { _id: null, t: { $sum: "$amount" } } }]),
    ]);

    const esewaRev  = esewaRevPipe[0]?.t  ?? 0;
    const khaltiRev = khaltiRevPipe[0]?.t ?? 0;
    const cosRev    = cosRevPipe[0]?.t    ?? 0;

    res.json({
      esewa: {
        total:      esewaTotal,
        successful: esewaSuccess,
        failed:     esewaFailed,
        pending:    esewaTotal - esewaSuccess - esewaFailed,
        revenue:    esewaRev,
      },
      khalti: {
        total:      khaltiTotal,
        successful: khaltiSuccess,
        failed:     khaltiFailure,
        pending:    khaltiTotal - khaltiSuccess - khaltiFailure,
        revenue:    khaltiRev,
      },
      cos: {
        total:    cosTotal,
        pending:  cosPending,
        approved: cosApproved,
        rejected: cosRejected,
        revenue:  cosRev,
      },
      totalRevenue: esewaRev + khaltiRev + cosRev,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── DELETE /api/analytics/souljar/:id ───────────────────────────────────────
router.delete("/souljar/:id", requireAdmin, requireAnalyticsAccess, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ message: "Entry id is required" });
    }

    const deleted = await Souljar.findByIdAndDelete(id).lean();
    if (!deleted) {
      return res.status(404).json({ message: "Souljar entry not found" });
    }

    // Best-effort cleanup of files in Firebase Storage.
    try {
      if (admin.apps.length && Array.isArray(deleted.attachmentUrls)) {
        const bucket = admin.storage().bucket();
        await Promise.all(
          deleted.attachmentUrls
            .map((url) => extractStoragePathFromUrl(url))
            .filter(Boolean)
            .map(async (path) => {
              try {
                await bucket.file(path).delete({ ignoreNotFound: true });
              } catch {
                // Ignore storage cleanup failures to avoid blocking DB deletion
              }
            }),
        );
      }
    } catch {
      // Ignore cleanup wrapper failure
    }

    // Best-effort admin audit trail for delete operations.
    try {
      const adminId = String(
        req.admin?.id || req.admin?._id || req.admin?.uid || req.admin?.username || "unknown"
      );
      const adminName = String(req.admin?.username || req.admin?.name || adminId);
      const adminRole = String(req.admin?.role || "analyticsAdmin");
      const ipAddress =
        req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ||
        req.socket?.remoteAddress ||
        "";

      await AuditLog.create({
        adminId,
        adminName,
        adminRole,
        action: "souljar_deleted",
        resourceType: "system",
        resourceId: String(deleted._id),
        resourceName: String(deleted.jarCode || "Souljar Entry"),
        description: `Deleted Souljar entry ${deleted.jarCode || deleted._id}`,
        metadata: {
          topic: deleted.topic || null,
          anonymous: !!deleted.anonymous,
          attachmentCount: Array.isArray(deleted.attachmentUrls)
            ? deleted.attachmentUrls.length
            : 0,
        },
        severity: "warn",
        ipAddress,
        userAgent: req.headers["user-agent"]?.toString() || "",
      });
    } catch (auditErr) {
      console.warn("Audit log write failed:", auditErr.message);
    }

    return res.json({
      message: "Souljar entry deleted",
      id: String(deleted._id),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

export default router;
