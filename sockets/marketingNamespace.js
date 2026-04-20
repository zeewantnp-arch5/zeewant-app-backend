import jwt              from "jsonwebtoken";
import Campaign         from "../models/Campaign.js";
import MarketingContent from "../models/MarketingContent.js";
import PushNotificationLog from "../models/PushNotificationLog.js";
import Souljar          from "../models/souljar.js";

const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret";

// ── Snapshot builder ──────────────────────────────────────────────────────────

async function buildMarketingSnapshot() {
  const now     = new Date();
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

  const [
    activeCampaigns,
    totalContent,
    publishedContent,
    notifReach,
    contentEngagement,
    souljarEntries,
    recentCampaigns,
    recentContent,
  ] = await Promise.all([
    Campaign.countDocuments({ status: "live" }),
    MarketingContent.countDocuments(),
    MarketingContent.countDocuments({ status: "published" }),
    PushNotificationLog.aggregate([
      { $match: { status: "sent" } },
      { $group: { _id: null, total: { $sum: "$sentCount" } } },
    ]),
    MarketingContent.aggregate([
      { $group: { _id: null,
        views:  { $sum: "$views" },
        likes:  { $sum: "$likes" },
        shares: { $sum: "$shares" },
      }},
    ]),
    Souljar.countDocuments({ createdAt: { $gte: weekAgo } }),
    Campaign.find({ status: { $in: ["live", "upcoming"] } })
      .sort({ updatedAt: -1 }).limit(5)
      .select("name acronym status startDate endDate reach participation").lean(),
    MarketingContent.find({ status: "published" })
      .sort({ createdAt: -1 }).limit(5)
      .select("title type status views likes shares createdAt").lean(),
  ]);

  const reach  = notifReach[0]?.total ?? 0;
  const eng    = contentEngagement[0] ?? { views: 0, likes: 0, shares: 0 };
  const engRate = eng.views > 0
    ? Math.round(((eng.likes + eng.shares) / eng.views) * 100)
    : 0;

  return {
    type:              "marketing_snapshot",
    ts:                Date.now(),
    activeCampaigns,
    totalContent,
    publishedContent,
    notificationReach: reach,
    engagementRate:    engRate,
    totalViews:        eng.views,
    totalLikes:        eng.likes,
    totalShares:       eng.shares,
    souljarEntries,
    recentCampaigns,
    recentContent,
  };
}

// ── Namespace registration ────────────────────────────────────────────────────

export function registerMarketingNamespace(io) {
  const ns = io.of("/marketing");

  // JWT auth guard
  ns.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.query?.token;
    if (!token) return next(new Error("No marketing token"));
    try {
      socket.data.admin = jwt.verify(token, JWT_SECRET);
      next();
    } catch {
      next(new Error("Unauthorized marketing token"));
    }
  });

  ns.on("connection", async (socket) => {
    socket.join("marketing_room");
    const who = socket.data.admin?.username || socket.id;
    console.log(`📣 Marketing connected: ${who}`);

    // Immediate initial snapshot
    try {
      const snap = await buildMarketingSnapshot();
      socket.emit("marketing_snapshot", snap);
    } catch (err) {
      console.error("Marketing initial snapshot error:", err.message);
    }

    socket.on("disconnect", () => {
      console.log(`📣 Marketing disconnected: ${who}`);
    });
  });

  // ── 30-second periodic push ───────────────────────────────────────────────
  const pushInterval = setInterval(async () => {
    if (ns.sockets.size === 0) return;
    try {
      const snap = await buildMarketingSnapshot();
      ns.to("marketing_room").emit("marketing_snapshot", snap);
    } catch (err) {
      console.error("Marketing periodic push error:", err.message);
    }
  }, 30_000);

  // ── MongoDB Change Streams ────────────────────────────────────────────────
  let contentStream  = null;
  let campaignStream = null;
  let notifStream    = null;

  const setupChangeStreams = () => {
    try {
      // Watch MarketingContent inserts and updates
      contentStream = MarketingContent.watch(
        [{ $match: { operationType: { $in: ["insert", "update"] } } }],
        { fullDocument: "updateLookup" }
      );

      contentStream.on("change", async (change) => {
        if (ns.sockets.size === 0) return;
        const doc = change.fullDocument;
        if (!doc) return;

        ns.to("marketing_room").emit("content_event", {
          type:      "content_event",
          operation: change.operationType,
          ts:        Date.now(),
          item: {
            id:          doc._id,
            title:       doc.title,
            contentType: doc.type,
            status:      doc.status,
            views:       doc.views,
            likes:       doc.likes,
            shares:      doc.shares,
            saves:       doc.saves,
            createdAt:   doc.createdAt,
          },
        });
      });

      contentStream.on("error", (err) => {
        console.warn("Marketing content stream error:", err.message);
        contentStream?.close();
        contentStream = null;
      });

      // Watch Campaign changes — also triggers a full snapshot refresh
      campaignStream = Campaign.watch(
        [{ $match: { operationType: { $in: ["insert", "update"] } } }],
        { fullDocument: "updateLookup" }
      );

      campaignStream.on("change", async (change) => {
        if (ns.sockets.size === 0) return;
        const doc = change.fullDocument;
        if (!doc) return;

        ns.to("marketing_room").emit("campaign_event", {
          type:      "campaign_event",
          operation: change.operationType,
          ts:        Date.now(),
          campaign: {
            id:            doc._id,
            name:          doc.name,
            acronym:       doc.acronym,
            status:        doc.status,
            startDate:     doc.startDate,
            endDate:       doc.endDate,
            reach:         doc.reach,
            participation: doc.participation,
            conversions:   doc.conversions,
          },
        });

        // Push updated KPI snapshot on every campaign change
        try {
          const snap = await buildMarketingSnapshot();
          ns.to("marketing_room").emit("marketing_snapshot", snap);
        } catch { /* suppress */ }
      });

      campaignStream.on("error", (err) => {
        console.warn("Marketing campaign stream error:", err.message);
        campaignStream?.close();
        campaignStream = null;
      });

      // Watch PushNotificationLog inserts
      notifStream = PushNotificationLog.watch(
        [{ $match: { operationType: "insert" } }],
        { fullDocument: "updateLookup" }
      );

      notifStream.on("change", async (change) => {
        if (ns.sockets.size === 0) return;
        const doc = change.fullDocument;
        if (!doc) return;

        ns.to("marketing_room").emit("notification_event", {
          type: "notification_event",
          ts:   Date.now(),
          log: {
            id:        doc._id,
            title:     doc.title,
            notifType: doc.type,
            sentCount: doc.sentCount,
            status:    doc.status,
            sentAt:    doc.sentAt,
          },
        });
      });

      notifStream.on("error", (err) => {
        console.warn("Marketing notif stream error:", err.message);
        notifStream?.close();
        notifStream = null;
      });

      console.log("📣 Marketing change streams active");
    } catch (err) {
      console.log("📣 Marketing change streams unavailable — polling only:", err.message);
    }
  };

  setTimeout(setupChangeStreams, 3000);

  return () => {
    clearInterval(pushInterval);
    contentStream?.close();
    campaignStream?.close();
    notifStream?.close();
  };
}
