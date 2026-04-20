import jwt          from "jsonwebtoken";
import SupportTicket from "../models/SupportTicket.js";
import UserComplaint from "../models/UserComplaint.js";
import UserFeedback  from "../models/UserFeedback.js";

const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret";

// ── Snapshot builder ──────────────────────────────────────────────────────────

async function buildSupportSnapshot() {
  const now     = new Date();
  const weekAgo = new Date(now - 7  * 24 * 60 * 60 * 1000);
  const dayAgo  = new Date(now - 24 * 60 * 60 * 1000);

  const [
    totalTickets,
    openTickets,
    inProgressTickets,
    resolvedTickets,
    criticalTickets,
    newTicketsToday,
    totalComplaints,
    pendingComplaints,
    escalatedComplaints,
    totalFeedback,
    feedbackThisWeek,
    satisfactionAgg,
    csatAgg,
    recentTickets,
    recentComplaints,
  ] = await Promise.all([
    SupportTicket.countDocuments(),
    SupportTicket.countDocuments({ status: "Open" }),
    SupportTicket.countDocuments({ status: "In Progress" }),
    SupportTicket.countDocuments({ status: "Resolved" }),
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
    UserFeedback.aggregate([
      { $group: {
        _id: null,
        satisfied: { $sum: { $cond: [{ $gte: ["$rating", 4] }, 1, 0] } },
        total:     { $sum: 1 },
      }},
    ]),
    SupportTicket.find()
      .sort({ createdAt: -1 }).limit(5)
      .select("ticketId subject category priority status userName createdAt").lean(),
    UserComplaint.find()
      .sort({ createdAt: -1 }).limit(5)
      .select("complaintId category severity status userName createdAt").lean(),
  ]);

  const avgRating = satisfactionAgg[0]?.avgRating ?? 0;
  const csatScore = csatAgg[0]?.total > 0
    ? Math.round((csatAgg[0].satisfied / csatAgg[0].total) * 100)
    : 0;

  return {
    type: "support_snapshot",
    ts:   Date.now(),
    totalTickets, openTickets, inProgressTickets, resolvedTickets,
    criticalTickets, newTicketsToday,
    totalComplaints, pendingComplaints, escalatedComplaints,
    totalFeedback, feedbackThisWeek,
    avgRating: Math.round(avgRating * 10) / 10,
    csatScore,
    recentTickets,
    recentComplaints,
  };
}

// ── Namespace registration ────────────────────────────────────────────────────

export function registerSupportNamespace(io) {
  const ns = io.of("/support");

  // JWT auth guard
  ns.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.query?.token;
    if (!token) return next(new Error("No support token"));
    try {
      socket.data.admin = jwt.verify(token, JWT_SECRET);
      next();
    } catch {
      next(new Error("Unauthorized support token"));
    }
  });

  ns.on("connection", async (socket) => {
    socket.join("support_room");
    const who = socket.data.admin?.username || socket.id;
    console.log(`🎫 Support connected: ${who}`);

    try {
      const snap = await buildSupportSnapshot();
      socket.emit("support_snapshot", snap);
    } catch (err) {
      console.error("Support initial snapshot error:", err.message);
    }

    socket.on("disconnect", () => {
      console.log(`🎫 Support disconnected: ${who}`);
    });
  });

  // ── 30-second periodic push ───────────────────────────────────────────────
  const pushInterval = setInterval(async () => {
    if (ns.sockets.size === 0) return;
    try {
      const snap = await buildSupportSnapshot();
      ns.to("support_room").emit("support_snapshot", snap);
    } catch (err) {
      console.error("Support periodic push error:", err.message);
    }
  }, 30_000);

  // ── MongoDB Change Streams ────────────────────────────────────────────────
  let ticketStream    = null;
  let complaintStream = null;
  let feedbackStream  = null;

  const setupChangeStreams = () => {
    try {
      // Watch SupportTicket
      ticketStream = SupportTicket.watch(
        [{ $match: { operationType: { $in: ["insert", "update"] } } }],
        { fullDocument: "updateLookup" }
      );

      ticketStream.on("change", async (change) => {
        if (ns.sockets.size === 0) return;
        const doc = change.fullDocument;
        if (!doc) return;

        ns.to("support_room").emit("ticket_event", {
          type:      "ticket_event",
          operation: change.operationType,
          ts:        Date.now(),
          ticket: {
            id:         doc._id,
            ticketId:   doc.ticketId,
            subject:    doc.subject,
            category:   doc.category,
            priority:   doc.priority,
            status:     doc.status,
            userName:   doc.userName,
            userEmail:  doc.userEmail,
            assignedTo: doc.assignedTo,
            createdAt:  doc.createdAt,
          },
        });

        // Push updated snapshot when ticket changes
        try {
          const snap = await buildSupportSnapshot();
          ns.to("support_room").emit("support_snapshot", snap);
        } catch { /* suppress */ }
      });

      ticketStream.on("error", (err) => {
        console.warn("Support ticket stream error:", err.message);
        ticketStream?.close();
        ticketStream = null;
      });

      // Watch UserComplaint
      complaintStream = UserComplaint.watch(
        [{ $match: { operationType: { $in: ["insert", "update"] } } }],
        { fullDocument: "updateLookup" }
      );

      complaintStream.on("change", async (change) => {
        if (ns.sockets.size === 0) return;
        const doc = change.fullDocument;
        if (!doc) return;

        ns.to("support_room").emit("complaint_event", {
          type:      "complaint_event",
          operation: change.operationType,
          ts:        Date.now(),
          complaint: {
            id:          doc._id,
            complaintId: doc.complaintId,
            category:    doc.category,
            severity:    doc.severity,
            status:      doc.status,
            userName:    doc.userName,
            againstType: doc.againstType,
            createdAt:   doc.createdAt,
          },
        });

        try {
          const snap = await buildSupportSnapshot();
          ns.to("support_room").emit("support_snapshot", snap);
        } catch { /* suppress */ }
      });

      complaintStream.on("error", (err) => {
        console.warn("Support complaint stream error:", err.message);
        complaintStream?.close();
        complaintStream = null;
      });

      // Watch UserFeedback
      feedbackStream = UserFeedback.watch(
        [{ $match: { operationType: "insert" } }],
        { fullDocument: "updateLookup" }
      );

      feedbackStream.on("change", async (change) => {
        if (ns.sockets.size === 0) return;
        const doc = change.fullDocument;
        if (!doc) return;

        ns.to("support_room").emit("feedback_event", {
          type: "feedback_event",
          ts:   Date.now(),
          feedback: {
            id:        doc._id,
            rating:    doc.rating,
            sentiment: doc.sentiment,
            feedbackType: doc.type,
            userName:  doc.userName,
            comment:   doc.comment,
            createdAt: doc.createdAt,
          },
        });

        try {
          const snap = await buildSupportSnapshot();
          ns.to("support_room").emit("support_snapshot", snap);
        } catch { /* suppress */ }
      });

      feedbackStream.on("error", (err) => {
        console.warn("Support feedback stream error:", err.message);
        feedbackStream?.close();
        feedbackStream = null;
      });

      console.log("🎫 Support change streams active");
    } catch (err) {
      console.log("🎫 Support change streams unavailable — polling only:", err.message);
    }
  };

  setTimeout(setupChangeStreams, 3000);

  return () => {
    clearInterval(pushInterval);
    ticketStream?.close();
    complaintStream?.close();
    feedbackStream?.close();
  };
}
