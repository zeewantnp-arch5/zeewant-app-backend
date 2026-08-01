import express from "express";
import jwt from "jsonwebtoken";
import SupportTicket  from "../models/SupportTicket.js";
import UserComplaint  from "../models/UserComplaint.js";
import UserFeedback   from "../models/UserFeedback.js";

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret";

// ── Auth middleware ────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: "No token" });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: "Unauthorized" });
  }
}

router.use(requireAdmin);

// ── Dashboard KPIs ────────────────────────────────────────────────────────────
router.get("/dashboard", async (req, res) => {
  try {
    const now     = new Date();
    const weekAgo = new Date(now - 7  * 24 * 60 * 60 * 1000);
    const dayAgo  = new Date(now - 24 * 60 * 60 * 1000);

    const [
      totalTickets,
      openTickets,
      inProgressTickets,
      resolvedTickets,
      closedTickets,
      criticalTickets,
      newTicketsToday,
      totalComplaints,
      pendingComplaints,
      escalatedComplaints,
      totalFeedback,
      feedbackThisWeek,
      satisfactionAgg,
      recentTickets,
      recentComplaints,
    ] = await Promise.all([
      SupportTicket.countDocuments(),
      SupportTicket.countDocuments({ status: "Open" }),
      SupportTicket.countDocuments({ status: "In Progress" }),
      SupportTicket.countDocuments({ status: "Resolved" }),
      SupportTicket.countDocuments({ status: "Closed" }),
      SupportTicket.countDocuments({ priority: "Critical", status: { $in: ["Open", "In Progress"] } }),
      SupportTicket.countDocuments({ createdAt: { $gte: dayAgo } }),
      UserComplaint.countDocuments(),
      UserComplaint.countDocuments({ status: "Pending" }),
      UserComplaint.countDocuments({ status: "Escalated" }),
      UserFeedback.countDocuments(),
      UserFeedback.countDocuments({ createdAt: { $gte: weekAgo } }),
      UserFeedback.aggregate([
        { $group: { _id: null, avgRating: { $avg: "$rating" }, total: { $sum: 1 } } },
      ]),
      SupportTicket.find()
        .sort({ createdAt: -1 }).limit(5)
        .select("ticketId subject category priority status userName createdAt").lean(),
      UserComplaint.find()
        .sort({ createdAt: -1 }).limit(5)
        .select("complaintId category severity status userName createdAt").lean(),
    ]);

    const avgRating = satisfactionAgg[0]?.avgRating ?? 0;
    // CSAT: % of ratings >= 4
    const csatAgg = await UserFeedback.aggregate([
      { $group: {
        _id: null,
        satisfied: { $sum: { $cond: [{ $gte: ["$rating", 4] }, 1, 0] } },
        total: { $sum: 1 },
      }},
    ]);
    const csatScore = csatAgg[0]?.total > 0
      ? Math.round((csatAgg[0].satisfied / csatAgg[0].total) * 100)
      : 0;

    res.json({
      totalTickets, openTickets, inProgressTickets, resolvedTickets, closedTickets,
      criticalTickets, newTicketsToday,
      totalComplaints, pendingComplaints, escalatedComplaints,
      totalFeedback, feedbackThisWeek,
      avgRating: Math.round(avgRating * 10) / 10,
      csatScore,
      recentTickets,
      recentComplaints,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Support Tickets ───────────────────────────────────────────────────────────
router.get("/tickets", async (req, res) => {
  try {
    const { status = "all", priority = "all", category = "all",
            page = 1, limit = 20, start, end } = req.query;

    const filter = {};
    if (status   !== "all") filter.status   = status;
    if (priority !== "all") filter.priority = priority;
    if (category !== "all") filter.category = category;
    if (start || end) {
      filter.createdAt = {};
      if (start) filter.createdAt.$gte = new Date(start);
      if (end)   filter.createdAt.$lte = new Date(end);
    }

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await SupportTicket.countDocuments(filter);
    const items = await SupportTicket.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    res.json({ total, page: parseInt(page), limit: parseInt(limit), items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/tickets", async (req, res) => {
  try {
    const ticket = await SupportTicket.create(req.body);
    res.status(201).json(ticket);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.patch("/tickets/:id", async (req, res) => {
  try {
    const { id }  = req.params;
    const updates = req.body;
    if (updates.status === "Resolved" && !updates.resolvedAt) {
      updates.resolvedAt = new Date();
    }
    const ticket = await SupportTicket.findByIdAndUpdate(id, updates, { new: true });
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });
    res.json(ticket);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.post("/tickets/:id/messages", async (req, res) => {
  try {
    const { id } = req.params;
    const ticket = await SupportTicket.findByIdAndUpdate(
      id,
      { $push: { messages: req.body } },
      { new: true }
    );
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });
    res.json(ticket);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// ── User Complaints ───────────────────────────────────────────────────────────
router.get("/complaints", async (req, res) => {
  try {
    const { status = "all", severity = "all", category = "all",
            page = 1, limit = 20, start, end } = req.query;

    const filter = {};
    if (status   !== "all") filter.status   = status;
    if (severity !== "all") filter.severity = severity;
    if (category !== "all") filter.category = category;
    if (start || end) {
      filter.createdAt = {};
      if (start) filter.createdAt.$gte = new Date(start);
      if (end)   filter.createdAt.$lte = new Date(end);
    }

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await UserComplaint.countDocuments(filter);
    const items = await UserComplaint.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    res.json({ total, page: parseInt(page), limit: parseInt(limit), items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/complaints", async (req, res) => {
  try {
    const complaint = await UserComplaint.create(req.body);
    res.status(201).json(complaint);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.patch("/complaints/:id", async (req, res) => {
  try {
    const { id }  = req.params;
    const updates = req.body;
    if (updates.status === "Escalated" && !updates.escalatedAt) updates.escalatedAt = new Date();
    if (updates.status === "Resolved"  && !updates.resolvedAt)  updates.resolvedAt  = new Date();
    const complaint = await UserComplaint.findByIdAndUpdate(id, updates, { new: true });
    if (!complaint) return res.status(404).json({ message: "Complaint not found" });
    res.json(complaint);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// ── Feedback & Surveys ────────────────────────────────────────────────────────
router.get("/feedback", async (req, res) => {
  try {
    const { type = "all", sentiment = "all", page = 1, limit = 20, start, end } = req.query;

    const filter = {};
    if (type      !== "all") filter.type      = type;
    if (sentiment !== "all") filter.sentiment = sentiment;
    if (start || end) {
      filter.createdAt = {};
      if (start) filter.createdAt.$gte = new Date(start);
      if (end)   filter.createdAt.$lte = new Date(end);
    }

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await UserFeedback.countDocuments(filter);
    const items = await UserFeedback.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    // Rating distribution
    const dist = await UserFeedback.aggregate([
      { $group: { _id: "$rating", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    res.json({ total, page: parseInt(page), limit: parseInt(limit), items, ratingDistribution: dist });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/feedback", async (req, res) => {
  try {
    const feedback = await UserFeedback.create(req.body);
    res.status(201).json(feedback);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// ── Satisfaction Analytics ────────────────────────────────────────────────────
router.get("/satisfaction", async (req, res) => {
  try {
    const { period = "monthly" } = req.query;
    const now = new Date();

    let groupExpr;
    if (period === "weekly") {
      groupExpr = {
        year: { $year: "$createdAt" },
        week: { $isoWeek: "$createdAt" },
      };
    } else {
      groupExpr = {
        year:  { $year: "$createdAt" },
        month: { $month: "$createdAt" },
      };
    }

    const [overallAgg, csatAgg, sentimentAgg, trendAgg, typeBreakdown] = await Promise.all([
      UserFeedback.aggregate([
        { $group: { _id: null, avgRating: { $avg: "$rating" }, total: { $sum: 1 } } },
      ]),
      UserFeedback.aggregate([
        { $group: {
          _id: null,
          satisfied: { $sum: { $cond: [{ $gte: ["$rating", 4] }, 1, 0] } },
          total:     { $sum: 1 },
        }},
      ]),
      UserFeedback.aggregate([
        { $group: { _id: "$sentiment", count: { $sum: 1 } } },
      ]),
      UserFeedback.aggregate([
        { $group: {
          _id: groupExpr,
          avgRating: { $avg: "$rating" },
          count:     { $sum: 1 },
        }},
        { $sort: { "_id.year": 1, "_id.month": 1, "_id.week": 1 } },
        { $limit: 12 },
      ]),
      UserFeedback.aggregate([
        { $group: { _id: "$type", count: { $sum: 1 }, avgRating: { $avg: "$rating" } } },
      ]),
    ]);

    const avgRating  = overallAgg[0]?.avgRating ?? 0;
    const csatScore  = csatAgg[0]?.total > 0
      ? Math.round((csatAgg[0].satisfied / csatAgg[0].total) * 100)
      : 0;

    // NPS: promoters (5) - detractors (1-2) as %
    const npsAgg = await UserFeedback.aggregate([
      { $group: {
        _id: null,
        promoters:  { $sum: { $cond: [{ $eq: ["$rating", 5] }, 1, 0] } },
        detractors: { $sum: { $cond: [{ $lte: ["$rating", 2] }, 1, 0] } },
        total:      { $sum: 1 },
      }},
    ]);
    const npsScore = npsAgg[0]?.total > 0
      ? Math.round(((npsAgg[0].promoters - npsAgg[0].detractors) / npsAgg[0].total) * 100)
      : 0;

    res.json({
      avgRating: Math.round(avgRating * 10) / 10,
      csatScore,
      npsScore,
      totalFeedback: overallAgg[0]?.total ?? 0,
      sentimentBreakdown: sentimentAgg,
      trend: trendAgg,
      typeBreakdown,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
