import express from "express";
import FollowUpOtp from "../models/FollowUpCode.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";
import Session from "../models/Session.js";

function generateOtp() {
  // 6-digit OTP — never starts with 0 (100000–999999)
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
        // Check if any paid session for this pair is completed (handles old sessions
        // where chatLocked was not set because our code wasn't deployed yet)
        Session.findOne({
          soulteeFirebaseUid: link.soulteeFirebaseUid,
          studentFirebaseUid: link.studentFirebaseUid,
          status: "completed",
        }).lean(),
      ]);

      // Chat is locked when ANY of these are true (and no active follow-up):
      // 1. chatLocked flag explicitly set (timer-expired sessions via new code)
      // 2. link.status === "ended" (soultee used end-session button)
      // 3. A paid session is completed but chatLocked was never set (old sessions)
      const sessionCompleted = !!completedSession;
      const isRawLocked = link.chatLocked === true
        || link.status === "ended"
        || sessionCompleted;

      // Follow-up OTP being USED overrides the lock
      const effectiveLocked = isRawLocked && !usedOtp;

      // Auto-repair: stamp chatLocked=true for old sessions so future DB checks
      // don't need the extra Session query
      if (sessionCompleted && !link.chatLocked && link.status !== "ended" && !usedOtp) {
        StudentSoulteeLink.updateOne({ _id: roomId }, { chatLocked: true }).catch(() => {});
      }

      res.json({
        chatLocked:      effectiveLocked,
        followUpActive:  !!usedOtp,
        followUpExpired: !usedOtp && !!expiredOtp,
        otpPending:      activeOtp?.otp ?? null,
        expiresAt:       usedOtp?.expiresAt ?? null,
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── POST /api/follow-up/:roomId/generate ──────────────────────────────────
  // Soultee generates a 6-digit OTP after session ends
  router.post("/:roomId/generate", async (req, res) => {
    try {
      const { soulteeUid } = req.body;
      const { roomId } = req.params;

      if (!soulteeUid) return res.status(400).json({ message: "soulteeUid is required" });

      const link = await StudentSoulteeLink.findOne({ _id: roomId }).lean();
      if (!link) return res.status(404).json({ message: "Room not found" });
      if (link.soulteeFirebaseUid !== soulteeUid) return res.status(403).json({ message: "Not authorized" });
      const isLocked = link.chatLocked === true || link.status === "ended";
      if (!isLocked) return res.status(400).json({ message: "Session is still active" });

      // Return existing ACTIVE OTP if already generated
      const existing = await FollowUpOtp.findOne({ roomId, status: "ACTIVE" }).lean();
      if (existing) return res.json({ otp: existing.otp });

      // Generate unique 6-digit OTP with collision retry
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
        studentFirebaseUid: link.studentFirebaseUid,
        soulteeFirebaseUid: link.soulteeFirebaseUid,
      });

      // Emit only to soultee's personal room — student does not get the OTP automatically
      io.to(`soultee:${soulteeUid}`).emit("followup_code_generated", { roomId, otp: record.otp });

      res.json({ otp: record.otp });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── POST /api/follow-up/:roomId/activate ──────────────────────────────────
  // Student enters OTP to unlock chat for 7 days
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

      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      record.status      = "USED";
      record.activatedAt = new Date();
      record.expiresAt   = expiresAt;
      await record.save();

      // Unlock chat — if link was "ended" (via end-session route) reactivate it so
      // messageService.getRoomLinkForParticipant() can find it and deliver messages
      const linkDoc = await StudentSoulteeLink.findOne({ _id: roomId }).lean();
      const updateFields = { chatLocked: false };
      if (linkDoc?.status === "ended") updateFields.status = "active";
      await StudentSoulteeLink.updateOne({ _id: roomId }, updateFields);

      io.to(roomId).emit("followup_activated", { roomId, expiresAt: expiresAt.toISOString() });

      res.json({ success: true, expiresAt });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── POST /api/follow-up/:roomId/request-resend ────────────────────────────
  // Student requests soultee to resend/share the OTP again
  router.post("/:roomId/request-resend", async (req, res) => {
    try {
      const { studentUid } = req.body;
      const { roomId } = req.params;

      if (!studentUid) return res.status(400).json({ message: "studentUid is required" });

      const link = await StudentSoulteeLink.findOne({ _id: roomId }).lean();
      if (!link) return res.status(404).json({ message: "Room not found" });
      if (link.studentFirebaseUid !== studentUid) return res.status(403).json({ message: "Not authorized" });

      // Get the existing ACTIVE OTP (if soultee already generated one)
      const existing = await FollowUpOtp.findOne({ roomId, status: "ACTIVE" }).lean();

      // Notify soultee — include otp so they can see it again on their screen
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
