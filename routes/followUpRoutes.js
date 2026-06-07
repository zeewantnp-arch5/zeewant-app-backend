import express from "express";
import FollowUpOtp from "../models/FollowUpCode.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";
import Session from "../models/Session.js";
import admin, { storeOTP, verifyOTP } from "../config/firebase.js";
import { sendFollowUpOtpEmail } from "../services/emailService.js";

const RESEND_THROTTLE = 30 * 1000; // 30 s minimum between resend requests

export default function createFollowUpRoutes(io) {
  const router = express.Router();

  // ─── GET /api/follow-up/:roomId/access-check ───────────────────────────────
  // Lightweight endpoint called before opening chat.
  // Returns { canAccess: bool, reason: string }
  router.get("/:roomId/access-check", async (req, res) => {
    try {
      const { roomId } = req.params;
      const link = await StudentSoulteeLink.findOne({ _id: roomId }).lean();
      if (!link) return res.json({ canAccess: false, reason: "no_link" });

      // Active follow-up (USED + not yet expired) always grants access
      const activeFollowUp = await FollowUpOtp.findOne({
        roomId,
        status:    "USED",
        expiresAt: { $gt: new Date() },
      }).lean();
      if (activeFollowUp) return res.json({ canAccess: true, reason: "followup_active" });

      // Chat is locked if the flag is set OR link.status is "ended"
      const isLocked = link.chatLocked === true || link.status === "ended";

      if (isLocked) {
        // Only block if the LATEST session is completed.
        // If the user already paid again (new active session), allow access.
        const latestSession = await Session.findOne({
          soulteeFirebaseUid: link.soulteeFirebaseUid,
          studentFirebaseUid: link.studentFirebaseUid,
        }).sort({ createdAt: -1 }).lean();

        if (latestSession?.status === "completed") {
          // A follow-up that was truly activated (used) and then expired has activatedAt set.
          // A superseded/re-requested OTP that was never verified has activatedAt = null.
          const trulyExpiredFollowUp = await FollowUpOtp.findOne({
            roomId,
            status:      "EXPIRED",
            activatedAt: { $ne: null },
          }).lean();

          if (trulyExpiredFollowUp) {
            // Both session AND follow-up are done — new payment required
            return res.json({ canAccess: false, reason: "followup_expired" });
          }
          // Session ended but follow-up not yet used — go to chat, show Follow-Up button
          return res.json({ canAccess: false, reason: "session_completed" });
        }
      }

      res.json({
        canAccess: !isLocked,
        reason:    isLocked ? "chat_locked" : "session_active",
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── GET /api/follow-up/:roomId/status ─────────────────────────────────────
  router.get("/:roomId/status", async (req, res) => {
    try {
      const { roomId } = req.params;
      const link = await StudentSoulteeLink.findOne({ _id: roomId }).lean();
      if (!link) return res.status(404).json({ message: "Room not found" });

      const [usedOtp, expiredOtp, latestSession] = await Promise.all([
        FollowUpOtp.findOne({ roomId, status: "USED" }).lean(),
        // Only count as "expired" if it was truly activated (activatedAt set).
        // OTPs that were requested but never verified have activatedAt=null — not a real expiry.
        FollowUpOtp.findOne({ roomId, status: "EXPIRED", activatedAt: { $ne: null } }).lean(),
        Session.findOne({
          soulteeFirebaseUid: link.soulteeFirebaseUid,
          studentFirebaseUid: link.studentFirebaseUid,
        }).sort({ createdAt: -1 }).lean(),
      ]);

      // Only treat as "session completed" if the LATEST session is completed.
      // A new payment creates a new active session → override the old completed one.
      const sessionCompleted = latestSession?.status === "completed";
      const isRawLocked = link.chatLocked === true || link.status === "ended" || sessionCompleted;
      const effectiveLocked = isRawLocked && !usedOtp;

      // Auto-repair: set chatLocked for old sessions that pre-date this feature
      if (sessionCompleted && !link.chatLocked && link.status !== "ended" && !usedOtp) {
        StudentSoulteeLink.updateOne({ _id: roomId }, { chatLocked: true }).catch(() => {});
      }

      res.json({
        chatLocked:      effectiveLocked,
        followUpActive:  !!usedOtp,
        followUpExpired: sessionCompleted && !usedOtp && !!expiredOtp,
        durationMinutes: usedOtp?.durationMinutes ?? latestSession?.durationMinutes ?? null,
        expiresAt:       usedOtp?.expiresAt   ?? null,
        activatedAt:     usedOtp?.activatedAt ?? null,
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── POST /api/follow-up/:roomId/request-otp ───────────────────────────────
  // Student OR soultee-initiated. Firebase generates + stores the OTP (5-min TTL).
  // Nodemailer delivers it to the student's registered email.
  router.post("/:roomId/request-otp", async (req, res) => {
    try {
      const { studentUid, soulteeUid } = req.body;
      const { roomId } = req.params;

      if (!studentUid && !soulteeUid)
        return res.status(400).json({ message: "studentUid or soulteeUid is required" });

      const link = await StudentSoulteeLink.findOne({ _id: roomId }).lean();
      if (!link) return res.status(404).json({ message: "Room not found" });

      // Verify caller identity: student calling for themselves, or soultee for their student
      if (studentUid && link.studentFirebaseUid !== studentUid)
        return res.status(403).json({ message: "Not authorized" });
      if (soulteeUid && link.soulteeFirebaseUid !== soulteeUid)
        return res.status(403).json({ message: "Not authorized" });

      // Always send OTP to the student regardless of who initiated
      const resolvedStudentUid = link.studentFirebaseUid;

      // Verify the session is locked / completed
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

      // Resend throttle: check MongoDB record createdAt
      const existingMeta = await FollowUpOtp.findOne({ roomId, status: "ACTIVE" }).lean();
      if (existingMeta) {
        const age = Date.now() - new Date(existingMeta.createdAt).getTime();
        if (age < RESEND_THROTTLE) {
          const remainingSeconds = Math.ceil((RESEND_THROTTLE - age) / 1000);
          return res.status(429).json({ message: `Please wait ${remainingSeconds}s before resending`, remainingSeconds });
        }
        // Expire the old metadata record; Firebase will overwrite its OTP entry
        await FollowUpOtp.updateOne({ _id: existingMeta._id }, { status: "EXPIRED" });
      }

      // Get session duration
      const session = await Session.findOne({
        soulteeFirebaseUid: link.soulteeFirebaseUid,
        studentFirebaseUid: link.studentFirebaseUid,
        status: "completed",
      }).sort({ createdAt: -1 }).lean();
      const durationMinutes = session?.durationMinutes ?? 60;

      // Firebase generates, stores, and returns a 6-digit OTP (5-min TTL)
      const otp = await storeOTP(resolvedStudentUid);

      // Store session metadata in MongoDB (no OTP validation logic — Firebase owns that)
      await FollowUpOtp.create({
        otp:                otp, // kept for audit trail only
        roomId,
        sessionId:          session?._id ?? null,
        durationMinutes,
        studentFirebaseUid: link.studentFirebaseUid,
        soulteeFirebaseUid: link.soulteeFirebaseUid,
      });

      // Get student email from Firebase Auth
      let studentEmail;
      try {
        const userRecord = await admin.auth().getUser(resolvedStudentUid);
        studentEmail = userRecord.email;
      } catch {
        return res.status(400).json({ message: "Could not retrieve student account details" });
      }
      if (!studentEmail)
        return res.status(400).json({ message: "No email address registered for this account" });

      // Send OTP via nodemailer
      await sendFollowUpOtpEmail(studentEmail, otp, durationMinutes);

      io.to(`student:${resolvedStudentUid}`).emit("otp_sent", { roomId });

      res.json({ success: true, message: "Verification code sent to your email" });
    } catch (err) {
      console.error("[followUp] request-otp error:", err.message);
      res.status(500).json({ message: err.message });
    }
  });

  // ─── POST /api/follow-up/:roomId/verify-otp ────────────────────────────────
  // Firebase validates the OTP (TTL + attempt-count). On success, follow-up
  // session starts for the original session's duration.
  router.post("/:roomId/verify-otp", async (req, res) => {
    try {
      const { studentUid, otp } = req.body;
      const { roomId } = req.params;

      if (!studentUid || !otp)
        return res.status(400).json({ message: "studentUid and otp are required" });

      // Firebase RTDB validates: TTL, attempt count, code match
      const { valid, reason } = await verifyOTP(studentUid, String(otp).trim());
      if (!valid) return res.status(400).json({ message: reason ?? "Invalid or expired code" });

      // Find the MongoDB metadata record
      const record = await FollowUpOtp.findOne({ roomId, status: "ACTIVE" });
      if (!record)
        return res.status(404).json({ message: "Session metadata not found. Please request a new code." });

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

      io.to(roomId).emit("otp_verified",       { roomId });
      io.to(roomId).emit("followup_activated", {
        roomId,
        durationMinutes: record.durationMinutes,
        expiresAt:       expiresAt.toISOString(),
        activatedAt:     activatedAt.toISOString(),
      });
      console.log(`[followUp] Follow-up started — room ${roomId}, duration ${record.durationMinutes} min`);

      // Server-side auto-expire
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
