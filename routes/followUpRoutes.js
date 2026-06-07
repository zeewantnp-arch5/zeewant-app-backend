import express from "express";
import FollowUpOtp from "../models/FollowUpCode.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";
import Session from "../models/Session.js";

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export default function createFollowUpRoutes(io) {
  const router = express.Router();

  // ─── GET /api/follow-up/:roomId/status ─────────────────────────────────────
  router.get("/:roomId/status", async (req, res) => {
    try {
      const { roomId } = req.params;
      const link = await StudentSoulteeLink.findOne({ _id: roomId }).lean();
      if (!link) return res.status(404).json({ message: "Room not found" });

      const [usedOtp, expiredOtp, activeOtp, completedSession] = await Promise.all([
        FollowUpOtp.findOne({ roomId, status: "USED"    }).lean(),
        FollowUpOtp.findOne({ roomId, status: "EXPIRED" }).lean(),
        FollowUpOtp.findOne({ roomId, status: "ACTIVE"  }).lean(),
        Session.findOne({
          soulteeFirebaseUid: link.soulteeFirebaseUid,
          studentFirebaseUid: link.studentFirebaseUid,
          status: "completed",
        }).sort({ createdAt: -1 }).lean(),
      ]);

      const sessionCompleted = !!completedSession;
      const isRawLocked = link.chatLocked === true
        || link.status === "ended"
        || sessionCompleted;
      const effectiveLocked = isRawLocked && !usedOtp;

      // Auto-repair chatLocked for old sessions
      if (sessionCompleted && !link.chatLocked && link.status !== "ended" && !usedOtp) {
        StudentSoulteeLink.updateOne({ _id: roomId }, { chatLocked: true }).catch(() => {});
      }

      res.json({
        chatLocked:      effectiveLocked,
        followUpActive:  !!usedOtp,
        followUpExpired: !usedOtp && !!expiredOtp,
        otpPending:      activeOtp?.otp ?? null,
        durationMinutes: usedOtp?.durationMinutes ?? completedSession?.durationMinutes ?? null,
        expiresAt:       usedOtp?.expiresAt ?? null,
        activatedAt:     usedOtp?.activatedAt ?? null,
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── POST /api/follow-up/:roomId/generate ──────────────────────────────────
  router.post("/:roomId/generate", async (req, res) => {
    try {
      const { soulteeUid } = req.body;
      const { roomId } = req.params;

      if (!soulteeUid) return res.status(400).json({ message: "soulteeUid is required" });

      const link = await StudentSoulteeLink.findOne({ _id: roomId }).lean();
      if (!link) return res.status(404).json({ message: "Room not found" });
      if (link.soulteeFirebaseUid !== soulteeUid) return res.status(403).json({ message: "Not authorized" });

      const isLocked = link.chatLocked === true || link.status === "ended";
      if (!isLocked) {
        // Also check if session is completed (old sessions)
        const sess = await Session.findOne({
          soulteeFirebaseUid: link.soulteeFirebaseUid,
          studentFirebaseUid: link.studentFirebaseUid,
          status: "completed",
        }).lean();
        if (!sess) return res.status(400).json({ message: "Session is still active" });
      }

      // Return existing ACTIVE OTP if already generated
      const existing = await FollowUpOtp.findOne({ roomId, status: "ACTIVE" }).lean();
      if (existing) return res.json({ otp: existing.otp, durationMinutes: existing.durationMinutes });

      // Get duration from the most recent completed session
      const session = await Session.findOne({
        soulteeFirebaseUid: link.soulteeFirebaseUid,
        studentFirebaseUid: link.studentFirebaseUid,
        status: "completed",
      }).sort({ createdAt: -1 }).lean();
      const durationMinutes = session?.durationMinutes ?? 60;

      // Generate unique OTP
      let otp;
      for (let i = 0; i < 10; i++) {
        const candidate = generateOtp();
        const clash = await FollowUpOtp.exists({ otp: candidate, status: "ACTIVE" });
        if (!clash) { otp = candidate; break; }
      }
      if (!otp) return res.status(500).json({ message: "Failed to generate OTP. Please retry." });

      const record = await FollowUpOtp.create({
        otp,
        roomId,
        sessionId: session?._id ?? null,
        durationMinutes,
        studentFirebaseUid: link.studentFirebaseUid,
        soulteeFirebaseUid: link.soulteeFirebaseUid,
      });

      io.to(`soultee:${soulteeUid}`).emit("followup_code_generated", {
        roomId,
        otp: record.otp,
        durationMinutes,
      });

      res.json({ otp: record.otp, durationMinutes });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── POST /api/follow-up/:roomId/activate ──────────────────────────────────
  router.post("/:roomId/activate", async (req, res) => {
    try {
      const { studentUid, otp } = req.body;
      const { roomId } = req.params;

      if (!studentUid || !otp) return res.status(400).json({ message: "studentUid and otp are required" });

      const record = await FollowUpOtp.findOne({
        roomId,
        otp: String(otp).trim(),
        status: "ACTIVE",
      });
      if (!record) return res.status(404).json({ message: "Invalid or already used OTP" });
      if (record.studentFirebaseUid !== studentUid) return res.status(403).json({ message: "OTP is not valid for this student" });

      const durationMs = record.durationMinutes * 60 * 1000;
      const activatedAt = new Date();
      const expiresAt   = new Date(activatedAt.getTime() + durationMs);

      record.status      = "USED";
      record.activatedAt = activatedAt;
      record.expiresAt   = expiresAt;
      await record.save();

      // Unlock chat — reactivate "ended" link so messageService can find it
      const linkDoc = await StudentSoulteeLink.findOne({ _id: roomId }).lean();
      const updateFields = { chatLocked: false };
      if (linkDoc?.status === "ended") updateFields.status = "active";
      await StudentSoulteeLink.updateOne({ _id: roomId }, updateFields);

      io.to(roomId).emit("followup_activated", {
        roomId,
        durationMinutes: record.durationMinutes,
        expiresAt: expiresAt.toISOString(),
        activatedAt: activatedAt.toISOString(),
      });

      // Server-side auto-expire when follow-up duration ends
      setTimeout(async () => {
        try {
          const r = await FollowUpOtp.findById(record._id);
          if (!r || r.status !== "USED") return;
          r.status = "EXPIRED";
          await r.save();
          await StudentSoulteeLink.updateOne({ _id: roomId }, { chatLocked: true });
          io.to(roomId).emit("followup_expired",  { roomId });
          io.to(roomId).emit("chat_relocked",      { roomId });
          console.log(`[followUp] Auto-expired OTP ${record.otp} after ${record.durationMinutes} min — room ${roomId} relocked`);
        } catch (autoErr) {
          console.error("[followUp] Auto-expire error:", autoErr.message);
        }
      }, durationMs);

      res.json({ success: true, durationMinutes: record.durationMinutes, expiresAt, activatedAt });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── POST /api/follow-up/:roomId/request-resend ────────────────────────────
  router.post("/:roomId/request-resend", async (req, res) => {
    try {
      const { studentUid } = req.body;
      const { roomId } = req.params;

      if (!studentUid) return res.status(400).json({ message: "studentUid is required" });

      const link = await StudentSoulteeLink.findOne({ _id: roomId }).lean();
      if (!link) return res.status(404).json({ message: "Room not found" });
      if (link.studentFirebaseUid !== studentUid) return res.status(403).json({ message: "Not authorized" });

      const existing = await FollowUpOtp.findOne({ roomId, status: "ACTIVE" }).lean();

      io.to(`soultee:${link.soulteeFirebaseUid}`).emit("followup_resend_requested", {
        roomId,
        otp: existing?.otp ?? null,
      });

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}
