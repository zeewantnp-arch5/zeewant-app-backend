import express from "express";
import CallLog from "../models/CallLog.js";
import { createNotification } from "../services/notificationService.js";

const router = express.Router();

const TERMINAL_MISSED_STATUSES = ["missed", "rejected", "busy", "cancelled"];

// ── POST /api/call-logs ────────────────────────────────────────────────────────
// Upsert-by-callId — called when a call invitation is sent.
router.post("/", async (req, res) => {
  try {
    const {
      callId, roomId, callerUid, calleeUid, callerName, calleeName, calleeRole, callType,
    } = req.body;

    if (!callId || !callerUid || !calleeUid || !callType) {
      return res.status(400).json({ error: "callId, callerUid, calleeUid and callType are required." });
    }

    const doc = await CallLog.findOneAndUpdate(
      { callId },
      {
        $setOnInsert: {
          callId, roomId: roomId || "", callerUid, calleeUid,
          callerName: callerName || "", calleeName: calleeName || "",
          calleeRole: calleeRole === "student" ? "student" : "soultee",
          callType, status: "ringing", startedAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );

    return res.status(200).json(doc);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/call-logs/:callId ───────────────────────────────────────────────
// Updates status/timestamps as the call progresses (accepted/ended/missed/...).
router.patch("/:callId", async (req, res) => {
  try {
    const { status, missedReason } = req.body;
    const now = new Date();

    const doc = await CallLog.findOne({ callId: req.params.callId });
    if (!doc) return res.status(404).json({ error: "Call log not found." });

    if (status === "ongoing" && !doc.acceptedAt) {
      doc.acceptedAt = now;
    }
    if (status === "completed") {
      doc.endedAt = now;
      const from = doc.acceptedAt || doc.startedAt;
      doc.durationSeconds = Math.max(0, Math.round((now - from) / 1000));
    } else if (TERMINAL_MISSED_STATUSES.includes(status)) {
      doc.endedAt = now;
      if (missedReason) doc.missedReason = missedReason;
    }
    if (status) doc.status = status;
    await doc.save();

    // Notify the callee if they never picked up (missed/rejected/busy/cancelled)
    if (TERMINAL_MISSED_STATUSES.includes(status) && !doc.acceptedAt) {
      try {
        const label = doc.callType === "video" ? "video call" : "voice call";
        await createNotification({
          recipientUid: doc.calleeUid,
          recipientRole: doc.calleeRole,
          type: doc.callType === "video" ? "missed_video_call" : "missed_voice_call",
          title: doc.callType === "video" ? "Missed Video Call" : "Missed Voice Call",
          body: `${doc.callerName || "Someone"} tried to reach you with a ${label}.`,
          data: { callId: doc.callId, roomId: doc.roomId, callType: doc.callType },
        });
      } catch (notifErr) {
        console.warn("[call-logs] missed-call notification error:", notifErr.message);
      }
    }

    return res.status(200).json(doc);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/call-logs/:uid ────────────────────────────────────────────────────
// Full call history for a user, as caller or callee.
router.get("/:uid", async (req, res) => {
  try {
    const { uid } = req.params;
    const docs = await CallLog.find({ $or: [{ callerUid: uid }, { calleeUid: uid }] })
      .sort({ startedAt: -1 })
      .limit(200)
      .lean();
    return res.status(200).json({ calls: docs });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/call-logs/:uid/counts ─────────────────────────────────────────────
// Aggregated counts per callType x status + average duration, for dashboard tiles.
router.get("/:uid/counts", async (req, res) => {
  try {
    const { uid } = req.params;
    const rows = await CallLog.aggregate([
      { $match: { $or: [{ callerUid: uid }, { calleeUid: uid }] } },
      { $group: { _id: { callType: "$callType", status: "$status" }, count: { $sum: 1 } } },
    ]);

    const counts = {
      voice: { completed: 0, missed: 0, rejected: 0, busy: 0, cancelled: 0 },
      video: { completed: 0, missed: 0, rejected: 0, busy: 0, cancelled: 0 },
    };
    for (const row of rows) {
      const { callType, status } = row._id;
      if (counts[callType] && status in counts[callType]) {
        counts[callType][status] = row.count;
      }
    }

    const durationAgg = await CallLog.aggregate([
      { $match: { $or: [{ callerUid: uid }, { calleeUid: uid }], status: "completed" } },
      { $group: { _id: null, avgDurationSeconds: { $avg: "$durationSeconds" } } },
    ]);

    return res.status(200).json({
      counts,
      avgDurationSeconds: Math.round(durationAgg[0]?.avgDurationSeconds || 0),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
