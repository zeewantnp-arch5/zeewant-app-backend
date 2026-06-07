import express from "express";
import FollowUpOtp from "../models/FollowUpCode.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";

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

      const usedOtp    = await FollowUpOtp.findOne({ roomId, status: "USED"    }).lean();
      const expiredOtp = await FollowUpOtp.findOne({ roomId, status: "EXPIRED" }).lean();
      const activeOtp  = await FollowUpOtp.findOne({ roomId, status: "ACTIVE"  }).lean();

      // Chat is locked if:
      // 1. chatLocked flag is explicitly set (new sessions via timer/manual complete), OR
      // 2. link status is "ended" (soultee used end-session button — old + new sessions)
      const effectiveLocked = (link.chatLocked === true) || (link.status === "ended");

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

      // Unlock chat
      await StudentSoulteeLink.updateOne({ _id: roomId }, { chatLocked: false });

      io.to(roomId).emit("followup_activated", { roomId, expiresAt: expiresAt.toISOString() });

      res.json({ success: true, expiresAt });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}
