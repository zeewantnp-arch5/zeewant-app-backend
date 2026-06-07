import express from "express";
import FollowUpOtp from "../models/FollowUpCode.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";
import Session from "../models/Session.js";
import admin from "../config/firebase.js";
import { sendFollowUpOtpEmail } from "../services/emailService.js";

const OTP_EXPIRY_MS    = 10 * 60 * 1000; // 10 min to enter OTP after receiving
const RESEND_THROTTLE  = 30 * 1000;       // 30 s minimum between resend requests

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

      const [usedOtp, expiredOtp, completedSession] = await Promise.all([
        FollowUpOtp.findOne({ roomId, status: "USED"    }).lean(),
        FollowUpOtp.findOne({ roomId, status: "EXPIRED" }).lean(),
        Session.findOne({
          soulteeFirebaseUid: link.soulteeFirebaseUid,
          studentFirebaseUid: link.studentFirebaseUid,
          status: "completed",
        }).sort({ createdAt: -1 }).lean(),
      ]);

      const sessionCompleted = !!completedSession;
      const isRawLocked = link.chatLocked === true || link.status === "ended" || sessionCompleted;
      const effectiveLocked = isRawLocked && !usedOtp;

      // Auto-repair chatLocked for old sessions that pre-date this feature
      if (sessionCompleted && !link.chatLocked && link.status !== "ended" && !usedOtp) {
        StudentSoulteeLink.updateOne({ _id: roomId }, { chatLocked: true }).catch(() => {});
      }

      res.json({
        chatLocked:      effectiveLocked,
        followUpActive:  !!usedOtp,
        followUpExpired: !usedOtp && !!expiredOtp,
        durationMinutes: usedOtp?.durationMinutes ?? completedSession?.durationMinutes ?? null,
        expiresAt:       usedOtp?.expiresAt   ?? null,
        activatedAt:     usedOtp?.activatedAt ?? null,
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── POST /api/follow-up/:roomId/request-otp ───────────────────────────────
  // Student-initiated: generate OTP and send to student's registered email.
  // No SoulTee action required.
  router.post("/:roomId/request-otp", async (req, res) => {
    try {
      const { studentUid } = req.body;
      const { roomId } = req.params;

      if (!studentUid) return res.status(400).json({ message: "studentUid is required" });

      const link = await StudentSoulteeLink.findOne({ _id: roomId }).lean();
      if (!link) return res.status(404).json({ message: "Room not found" });
      if (link.studentFirebaseUid !== studentUid)
        return res.status(403).json({ message: "Not authorized" });

      // Verify the session is actually completed / locked
      const isLocked = link.chatLocked === true || link.status === "ended";
      if (!isLocked) {
        const sess = await Session.findOne({
          soulteeFirebaseUid: link.soulteeFirebaseUid,
          studentFirebaseUid: link.studentFirebaseUid,
          status: "completed",
        }).lean();
        if (!sess) return res.status(400).json({ message: "Session is still active" });
      }

      // Refuse if a follow-up is already running
      const activeFollowUp = await FollowUpOtp.exists({ roomId, status: "USED" });
      if (activeFollowUp)
        return res.status(409).json({ message: "A follow-up session is already active" });

      // Resend throttle: reject if an ACTIVE OTP was created less than 30 s ago
      const existingActive = await FollowUpOtp.findOne({ roomId, status: "ACTIVE" }).lean();
      if (existingActive) {
        const age = Date.now() - new Date(existingActive.createdAt).getTime();
        if (age < RESEND_THROTTLE) {
          const remainingSeconds = Math.ceil((RESEND_THROTTLE - age) / 1000);
          return res.status(429).json({
            message: `Please wait ${remainingSeconds}s before resending`,
            remainingSeconds,
          });
        }
        // Expire old OTP before issuing a new one
        await FollowUpOtp.updateOne({ _id: existingActive._id }, { status: "EXPIRED" });
      }

      // Get session duration from the most recent completed session
      const session = await Session.findOne({
        soulteeFirebaseUid: link.soulteeFirebaseUid,
        studentFirebaseUid: link.studentFirebaseUid,
        status: "completed",
      }).sort({ createdAt: -1 }).lean();
      const durationMinutes = session?.durationMinutes ?? 60;

      // Generate a unique 6-digit OTP
      let otp;
      for (let i = 0; i < 10; i++) {
        const candidate = generateOtp();
        const clash = await FollowUpOtp.exists({ otp: candidate, status: "ACTIVE" });
        if (!clash) { otp = candidate; break; }
      }
      if (!otp) return res.status(500).json({ message: "Failed to generate OTP. Please retry." });

      await FollowUpOtp.create({
        otp,
        roomId,
        sessionId:          session?._id ?? null,
        durationMinutes,
        studentFirebaseUid: link.studentFirebaseUid,
        soulteeFirebaseUid: link.soulteeFirebaseUid,
      });

      // Get student's email from Firebase Auth
      let studentEmail;
      try {
        const userRecord = await admin.auth().getUser(studentUid);
        studentEmail = userRecord.email;
      } catch {
        return res.status(400).json({ message: "Could not retrieve student account details" });
      }
      if (!studentEmail)
        return res.status(400).json({ message: "No email address registered for this account" });

      // Send OTP via email
      await sendFollowUpOtpEmail(studentEmail, otp, durationMinutes);

      // Notify student's personal socket room
      io.to(`student:${studentUid}`).emit("otp_sent", { roomId });

      res.json({ success: true, message: "Verification code sent to your email" });
    } catch (err) {
      console.error("[followUp] request-otp error:", err.message);
      res.status(500).json({ message: err.message });
    }
  });

  // ─── POST /api/follow-up/:roomId/verify-otp ────────────────────────────────
  // Student submits the OTP received by email. On success the follow-up session
  // starts and chat is unlocked for the original session's duration.
  router.post("/:roomId/verify-otp", async (req, res) => {
    try {
      const { studentUid, otp } = req.body;
      const { roomId } = req.params;

      if (!studentUid || !otp)
        return res.status(400).json({ message: "studentUid and otp are required" });

      const record = await FollowUpOtp.findOne({
        roomId,
        otp:    String(otp).trim(),
        status: "ACTIVE",
      });
      if (!record) return res.status(404).json({ message: "Invalid or already used code" });
      if (record.studentFirebaseUid !== studentUid)
        return res.status(403).json({ message: "Code is not valid for this account" });

      // OTP TTL check (10 minutes from creation)
      const otpAge = Date.now() - record.createdAt.getTime();
      if (otpAge > OTP_EXPIRY_MS) {
        record.status = "EXPIRED";
        await record.save();
        return res.status(410).json({ message: "Code has expired. Please request a new one." });
      }

      const durationMs  = record.durationMinutes * 60 * 1000;
      const activatedAt = new Date();
      const expiresAt   = new Date(activatedAt.getTime() + durationMs);

      record.status      = "USED";
      record.activatedAt = activatedAt;
      record.expiresAt   = expiresAt;
      await record.save();

      // Unlock chat — reactivate "ended" links so messageService can find them
      const linkDoc = await StudentSoulteeLink.findOne({ _id: roomId }).lean();
      const updateFields = { chatLocked: false };
      if (linkDoc?.status === "ended") updateFields.status = "active";
      await StudentSoulteeLink.updateOne({ _id: roomId }, updateFields);

      // Notify both participants
      io.to(roomId).emit("otp_verified",       { roomId });
      io.to(roomId).emit("followup_activated", {
        roomId,
        durationMinutes: record.durationMinutes,
        expiresAt:       expiresAt.toISOString(),
        activatedAt:     activatedAt.toISOString(),
      });
      console.log(`[followUp] Follow-up started — room ${roomId}, duration ${record.durationMinutes} min`);

      // Server-side auto-expire when follow-up duration ends
      setTimeout(async () => {
        try {
          const r = await FollowUpOtp.findById(record._id);
          if (!r || r.status !== "USED") return;
          r.status = "EXPIRED";
          await r.save();
          await StudentSoulteeLink.updateOne({ _id: roomId }, { chatLocked: true });
          io.to(roomId).emit("followup_expired", { roomId });
          io.to(roomId).emit("chat_relocked",    { roomId });
          console.log(`[followUp] Auto-expired after ${record.durationMinutes} min — room ${roomId} relocked`);
        } catch (autoErr) {
          console.error("[followUp] Auto-expire error:", autoErr.message);
        }
      }, durationMs);

      res.json({ success: true, durationMinutes: record.durationMinutes, expiresAt, activatedAt });
    } catch (err) {
      console.error("[followUp] verify-otp error:", err.message);
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}
