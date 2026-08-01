import express          from "express";
import jwt              from "jsonwebtoken";
import admin            from "firebase-admin";
import Campaign         from "../models/Campaign.js";
import MarketingContent from "../models/MarketingContent.js";
import PushNotificationLog from "../models/PushNotificationLog.js";
import Souljar          from "../models/souljar.js";
import Session          from "../models/Session.js";
import FCMToken         from "../models/FCMToken.js";
import JWT_SECRET from "../config/jwtSecret.js";

const router     = express.Router();

// ─── Auth middleware ───────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ message: "No token" });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
}

router.use(authMiddleware);

// ─── Date range helper ─────────────────────────────────────────────────────────

function getDateRange(period, start, end) {
  const now = new Date();
  if (period === "custom" && start && end) {
    return { $gte: new Date(start), $lte: new Date(end) };
  }
  const days = { daily: 1, weekly: 7, monthly: 30 }[period] ?? 7;
  return { $gte: new Date(now - days * 24 * 60 * 60 * 1000) };
}

// ─── GET /dashboard ────────────────────────────────────────────────────────────

router.get("/dashboard", async (req, res) => {
  try {
    const { period = "weekly", start, end } = req.query;
    const dateRange = getDateRange(period, start, end);

    const [
      activeCampaigns,
      totalContent,
      publishedContent,
      notifReach,
      contentEngagement,
      souljarEntries,
      recentCampaigns,
      recentContent,
      recentNotifs,
    ] = await Promise.all([
      Campaign.countDocuments({ status: "live" }),
      MarketingContent.countDocuments(),
      MarketingContent.countDocuments({ status: "published" }),
      PushNotificationLog.aggregate([
        { $match: { status: "sent" } },
        { $group: { _id: null, total: { $sum: "$sentCount" } } },
      ]),
      MarketingContent.aggregate([
        { $group: { _id: null, views: { $sum: "$views" }, likes: { $sum: "$likes" }, shares: { $sum: "$shares" } } },
      ]),
      Souljar.countDocuments({ createdAt: dateRange }),
      Campaign.find().sort({ updatedAt: -1 }).limit(5)
        .select("name acronym status startDate endDate reach participation").lean(),
      MarketingContent.find({ status: "published" }).sort({ createdAt: -1 }).limit(5)
        .select("title type status views likes shares createdAt").lean(),
      PushNotificationLog.find({ status: "sent" }).sort({ sentAt: -1 }).limit(5)
        .select("title type sentCount openedCount status sentAt").lean(),
    ]);

    const reach  = notifReach[0]?.total ?? 0;
    const eng    = contentEngagement[0] ?? { views: 0, likes: 0, shares: 0 };
    const engRate = eng.views > 0 ? Math.round(((eng.likes + eng.shares) / eng.views) * 100) : 0;

    res.json({
      kpi: {
        activeCampaigns,
        totalContent,
        publishedContent,
        notificationReach: reach,
        engagementRate: engRate,
        totalViews: eng.views,
        totalLikes: eng.likes,
        totalShares: eng.shares,
        souljarEntries,
      },
      recentCampaigns,
      recentContent,
      recentNotifs,
      period,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /content ──────────────────────────────────────────────────────────────

router.get("/content", async (req, res) => {
  try {
    const { type = "all", status = "all", period = "all", start, end, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (type   !== "all") filter.type   = type;
    if (status !== "all") filter.status = status;
    if (period !== "all") filter.createdAt = getDateRange(period, start, end);

    const [items, total] = await Promise.all([
      MarketingContent.find(filter).sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit)).limit(Number(limit)).lean(),
      MarketingContent.countDocuments(filter),
    ]);

    res.json({ items, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /content ─────────────────────────────────────────────────────────────

router.post("/content", async (req, res) => {
  try {
    const { title, type, body, status, scheduledAt, campaignId, tags } = req.body;
    const item = await MarketingContent.create({
      title,
      type,
      body,
      status:      status || "draft",
      scheduledAt: scheduledAt ? new Date(scheduledAt) : undefined,
      publishedAt: status === "published" ? new Date() : undefined,
      campaignId:  campaignId || undefined,
      tags:        tags || [],
      createdBy:   req.admin?.username,
    });

    res.status(201).json(item);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── PATCH /content/:id ────────────────────────────────────────────────────────

router.patch("/content/:id", async (req, res) => {
  try {
    const update = { ...req.body };
    if (update.status === "published" && !update.publishedAt) {
      update.publishedAt = new Date();
    }
    const item = await MarketingContent.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true }
    ).lean();
    if (!item) return res.status(404).json({ message: "Content not found" });

    res.json(item);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /notifications ────────────────────────────────────────────────────────

router.get("/notifications", async (req, res) => {
  try {
    const { status = "all", page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status !== "all") filter.status = status;

    const [items, total, stats] = await Promise.all([
      PushNotificationLog.find(filter).sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit)).limit(Number(limit)).lean(),
      PushNotificationLog.countDocuments(filter),
      PushNotificationLog.aggregate([
        { $match: { status: "sent" } },
        { $group: { _id: null,
          totalSent:    { $sum: "$sentCount" },
          totalOpened:  { $sum: "$openedCount" },
          totalClicked: { $sum: "$clickedCount" },
        }},
      ]),
    ]);

    const s = stats[0] ?? { totalSent: 0, totalOpened: 0, totalClicked: 0 };
    res.json({
      items, total,
      stats: {
        ...s,
        overallOpenRate: s.totalSent > 0 ? Math.round((s.totalOpened  / s.totalSent) * 100) : 0,
        overallCTR:      s.totalSent > 0 ? Math.round((s.totalClicked / s.totalSent) * 100) : 0,
      },
      page: Number(page), limit: Number(limit),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /notifications/send ──────────────────────────────────────────────────

router.post("/notifications/send", async (req, res) => {
  try {
    const { title, body, type, targetAudience, campaignId } = req.body;
    if (!title || !body) return res.status(400).json({ message: "title and body are required" });

    const tokens = await FCMToken.find({}).select("token").lean();
    const tokenList = tokens.map(t => t.token).filter(Boolean);

    let sentCount = 0;
    let logStatus = "sent";

    if (tokenList.length > 0 && admin.apps.length > 0) {
      try {
        const batchSize = 500;
        for (let i = 0; i < tokenList.length; i += batchSize) {
          const batch = tokenList.slice(i, i + batchSize);
          await admin.messaging().sendEachForMulticast({
            tokens: batch,
            notification: { title, body },
            data: { notifType: type || "motivational", campaignId: campaignId || "" },
          });
          sentCount += batch.length;
        }
      } catch (fcmErr) {
        console.warn("FCM send error:", fcmErr.message);
        logStatus = sentCount > 0 ? "sent" : "failed";
      }
    } else {
      sentCount = 0;
    }

    const log = await PushNotificationLog.create({
      title,
      body,
      type:           type          || "motivational",
      targetAudience: targetAudience || "all",
      sentCount,
      deliveredCount: sentCount,
      openedCount:    0,
      clickedCount:   0,
      status:         logStatus,
      sentAt:         new Date(),
      sentBy:         req.admin?.username,
      campaignId:     campaignId || undefined,
    });

    res.status(201).json({ log, sentCount });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /campaigns ────────────────────────────────────────────────────────────

router.get("/campaigns", async (req, res) => {
  try {
    const { status = "all", page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status !== "all") filter.status = status;

    const [items, total] = await Promise.all([
      Campaign.find(filter).sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit)).limit(Number(limit)).lean(),
      Campaign.countDocuments(filter),
    ]);

    res.json({ items, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /campaigns ───────────────────────────────────────────────────────────

router.post("/campaigns", async (req, res) => {
  try {
    const { name, acronym, description, startDate, endDate, status, targetAudience, budget, tags } = req.body;
    if (!name || !acronym) return res.status(400).json({ message: "name and acronym are required" });

    const campaign = await Campaign.create({
      name, acronym, description,
      startDate:      startDate ? new Date(startDate) : undefined,
      endDate:        endDate   ? new Date(endDate)   : undefined,
      status:         status || "planning",
      targetAudience: targetAudience || "all",
      budget:         budget || 0,
      tags:           tags   || [],
      createdBy:      req.admin?.username,
    });

    res.status(201).json(campaign);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── PATCH /campaigns/:id ──────────────────────────────────────────────────────

router.patch("/campaigns/:id", async (req, res) => {
  try {
    const campaign = await Campaign.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true }
    ).lean();
    if (!campaign) return res.status(404).json({ message: "Campaign not found" });

    res.json(campaign);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /engagement ───────────────────────────────────────────────────────────

router.get("/engagement", async (req, res) => {
  try {
    const { period = "weekly", start, end } = req.query;
    const dateRange = getDateRange(period, start, end);

    const [contentStats, notifStats, souljarMoods, topContent] = await Promise.all([
      MarketingContent.aggregate([
        { $group: { _id: null,
          totalViews:  { $sum: "$views" },
          totalLikes:  { $sum: "$likes" },
          totalShares: { $sum: "$shares" },
          totalSaves:  { $sum: "$saves" },
        }},
      ]),
      PushNotificationLog.aggregate([
        { $match: { status: "sent", createdAt: dateRange } },
        { $group: { _id: null,
          totalSent:    { $sum: "$sentCount" },
          totalOpened:  { $sum: "$openedCount" },
          totalClicked: { $sum: "$clickedCount" },
        }},
      ]),
      Souljar.aggregate([
        { $match: { createdAt: dateRange, mood: { $exists: true, $ne: null } } },
        { $group: { _id: "$mood", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ]),
      MarketingContent.find({ status: "published" })
        .sort({ views: -1 }).limit(10)
        .select("title type views likes shares saves").lean(),
    ]);

    const cs = contentStats[0] ?? { totalViews: 0, totalLikes: 0, totalShares: 0, totalSaves: 0 };
    const ns = notifStats[0]   ?? { totalSent: 0, totalOpened: 0, totalClicked: 0 };
    const engRate = cs.totalViews > 0
      ? Math.round(((cs.totalLikes + cs.totalShares) / cs.totalViews) * 100)
      : 0;

    res.json({
      kpi: {
        engagementRate:      engRate,
        totalViews:          cs.totalViews,
        totalLikes:          cs.totalLikes,
        totalShares:         cs.totalShares,
        totalSaves:          cs.totalSaves,
        notificationOpenRate: ns.totalSent > 0 ? Math.round((ns.totalOpened  / ns.totalSent) * 100) : 0,
        notificationCTR:      ns.totalSent > 0 ? Math.round((ns.totalClicked / ns.totalSent) * 100) : 0,
        totalNotifSent:      ns.totalSent,
      },
      moodBreakdown: souljarMoods,
      topContent,
      period,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /souljar-insights ─────────────────────────────────────────────────────

router.get("/souljar-insights", async (req, res) => {
  try {
    const { period = "monthly", start, end } = req.query;
    const dateRange = getDateRange(period, start, end);

    const [
      totalEntries,
      moodDistribution,
      activityBreakdown,
      topTopics,
      reflectionStats,
      wordCountStats,
      dailyTrend,
    ] = await Promise.all([
      Souljar.countDocuments({ createdAt: dateRange }),
      Souljar.aggregate([
        { $match: { createdAt: dateRange, mood: { $exists: true, $ne: null } } },
        { $group: { _id: "$mood", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
      Souljar.aggregate([
        { $match: { createdAt: dateRange, activity: { $exists: true, $ne: null } } },
        { $group: { _id: "$activity", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ]),
      Souljar.aggregate([
        { $match: { createdAt: dateRange, topic: { $exists: true, $ne: null } } },
        { $group: { _id: "$topic", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ]),
      Souljar.aggregate([
        { $match: { createdAt: dateRange, reflectionSeconds: { $exists: true } } },
        { $group: { _id: null, avg: { $avg: "$reflectionSeconds" } } },
      ]),
      Souljar.aggregate([
        { $match: { createdAt: dateRange, wordCount: { $exists: true } } },
        { $group: { _id: null, avg: { $avg: "$wordCount" }, max: { $max: "$wordCount" } } },
      ]),
      Souljar.aggregate([
        { $match: { createdAt: dateRange } },
        { $group: {
          _id:   { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 },
        }},
        { $sort: { _id: 1 } },
        { $limit: 30 },
      ]),
    ]);

    res.json({
      totalEntries,
      moodDistribution,
      activityBreakdown,
      topTopics,
      avgReflectionSeconds: Math.round(reflectionStats[0]?.avg ?? 0),
      avgWordCount:         Math.round(wordCountStats[0]?.avg  ?? 0),
      maxWordCount:         wordCountStats[0]?.max ?? 0,
      dailyTrend,
      period,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
