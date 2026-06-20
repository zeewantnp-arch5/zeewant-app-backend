import crypto from "crypto";
import express from "express";
import FollowUpOtp from "../models/FollowUpCode.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";
import Session from "../models/Session.js";
import { sendFollowUpOtpEmail } from "../services/emailService.js";
import admin from "../config/firebase.js";
import PhoneAuth from "../models/PhoneAuth.js";

const OTP_TTL_MS      = 10 * 60 * 1000; // OTP valid for 10 minutes
const MAX_OTP_ATTEMPTS = 5;

function generateOtp() {
  return String(crypto.randomInt(100000, 999999));
}

const RESEND_THROTTLE = 30 * 1000; // 30 s minimum between resend requests

function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim();
  return email ? email.toLowerCase() : null;
}

async function resolveStudentEmail(studentUid) {
  // 1. Firebase Auth — covers email/password and Google sign-in
  try {
    const user = await admin.auth().getUser(studentUid);
    if (user.email) return normalizeEmail(user.email);
  } catch (_) {}

  // 2. Firestore users collection — matches Flutter's _resolveUserEmail logic
  try {
    const doc = await admin.firestore().collection("users").doc(studentUid).get();
    if (doc.exists) {
      const data = doc.data() ?? {};
      for (const key of ["email", "userEmail", "contactEmail"]) {
        const v = normalizeEmail(data[key]);
        if (v) return v;
      }
    }
  } catch (_) {}

  // 3. Most recent OTP record (repeat requests where email was already supplied)
  const recentOtp = await FollowUpOtp.findOne({ studentFirebaseUid: studentUid })
    .sort({ createdAt: -1 })
    .select("studentEmail")
    .lean();
  return normalizeEmail(recentOtp?.studentEmail);
}

async function resolveStudentPhone(studentUid) {
  try {
    const user = await admin.auth().getUser(studentUid);
    if (user.phoneNumber) return user.phoneNumber;
  } catch (_) {}
  try {
    const phoneAuth = await PhoneAuth.findOne({ firebaseUid: studentUid }).lean();
    if (phoneAuth?.phone) return phoneAuth.phone;
  } catch (_) {}
  return null;
}

function maskPhone(phone) {
  if (!phone || phone.length <= 4) return phone || "";
  return phone.slice(0, -4) + "****";
}

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

  // ─── GET /api/follow-up/:roomId/contact-info?studentUid=... ──────────────────
  // Returns masked email + phone so the Flutter dialog can show available methods.
  router.get("/:roomId/contact-info", async (req, res) => {
    try {
      const { roomId } = req.params;
      const { studentUid } = req.query;
      if (!studentUid) return res.status(400).json({ message: "studentUid is required" });

      const link = await StudentSoulteeLink.findOne({ _id: roomId }).lean();
      if (!link) return res.status(404).json({ message: "Room not found" });
      if (link.studentFirebaseUid !== studentUid)
        return res.status(403).json({ message: "Not authorized" });

      // Resolve email
      const emailFromLink    = normalizeEmail(link.studentEmail);
      const emailFromHistory = await resolveStudentEmail(studentUid);
      const resolvedEmail    = emailFromLink || emailFromHistory;

      // Resolve phone (Firebase Auth → PhoneAuth model)
      const resolvedPhone = await resolveStudentPhone(studentUid);

      const maskEmail = (e) => {
        if (!e) return null;
        const [local, domain] = e.split("@");
        if (!local || !domain) return e;
        if (local.length <= 2) return `${"*".repeat(local.length)}@${domain}`;
        return `${local[0]}${"*".repeat(local.length - 2)}${local[local.length - 1]}@${domain}`;
      };

      res.json({
        email:       resolvedEmail   ? maskEmail(resolvedEmail)  : null,
        phone:       resolvedPhone   ? maskPhone(resolvedPhone)  : null,
        hasEmail:    !!resolvedEmail,
        hasPhone:    !!resolvedPhone,
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── POST /api/follow-up/:roomId/request-otp ───────────────────────────────
  router.post("/:roomId/request-otp", async (req, res) => {
    try {
      const { studentUid, soulteeUid, studentEmail, email, userEmail, contactEmail } = req.body;
      const { roomId } = req.params;
      // 'mobile' only accepted for student-initiated requests (soultee always uses email)
      const method = (req.body.method === "mobile" && studentUid) ? "mobile" : "email";

      if (!studentUid && !soulteeUid)
        return res.status(400).json({ message: "studentUid or soulteeUid is required" });

      const link = await StudentSoulteeLink.findOne({ _id: roomId }).lean();
      if (!link) return res.status(404).json({ message: "Room not found" });

      if (studentUid && link.studentFirebaseUid !== studentUid)
        return res.status(403).json({ message: "Not authorized" });
      if (soulteeUid && link.soulteeFirebaseUid !== soulteeUid)
        return res.status(403).json({ message: "Not authorized" });

      const resolvedStudentUid = link.studentFirebaseUid;

      const isLocked = link.chatLocked === true || link.status === "ended";
      if (!isLocked) {
        const sess = await Session.findOne({
          soulteeFirebaseUid: link.soulteeFirebaseUid,
          studentFirebaseUid: link.studentFirebaseUid,
          status: "completed",
        }).lean();
        if (!sess) return res.status(400).json({ message: "Session is still active" });
      }

      const activeFollowUp = await FollowUpOtp.exists({ roomId, status: "USED" });
      if (activeFollowUp)
        return res.status(409).json({ message: "A follow-up session is already active" });

      // Resend throttle
      const existingMeta = await FollowUpOtp.findOne({ roomId, status: "ACTIVE" }).lean();
      if (existingMeta) {
        const age = Date.now() - new Date(existingMeta.createdAt).getTime();
        if (age < RESEND_THROTTLE) {
          const remainingSeconds = Math.ceil((RESEND_THROTTLE - age) / 1000);
          return res.status(429).json({ message: `Please wait ${remainingSeconds}s before resending`, remainingSeconds });
        }
        await FollowUpOtp.updateOne({ _id: existingMeta._id }, { status: "EXPIRED" });
      }

      const session = await Session.findOne({
        soulteeFirebaseUid: link.soulteeFirebaseUid,
        studentFirebaseUid: link.studentFirebaseUid,
        status: "completed",
      }).sort({ createdAt: -1 }).lean();
      const durationMinutes = session?.durationMinutes ?? 60;

      // ── Mobile flow ─────────────────────────────────────────────────────────
      if (method === "mobile") {
        const studentPhone = await resolveStudentPhone(resolvedStudentUid);
        if (!studentPhone) {
          return res.status(400).json({
            message: "No phone number found in your profile. Please use email verification.",
          });
        }

        // Placeholder OTP — never validated; Firebase handles the actual SMS code
        const mobilePlaceholder = "__m_" + crypto.randomBytes(16).toString("hex");
        const otpExpiresAt = new Date(Date.now() + OTP_TTL_MS);

        await FollowUpOtp.create({
          otp:                mobilePlaceholder,
          roomId,
          sessionId:          session?._id ?? null,
          durationMinutes,
          otpExpiresAt,
          studentPhone,
          studentFirebaseUid: link.studentFirebaseUid,
          soulteeFirebaseUid: link.soulteeFirebaseUid,
          verificationMethod: "mobile",
        });

        io.to(`student:${resolvedStudentUid}`).emit("otp_sent", { roomId, method: "mobile" });

        return res.json({
          success: true,
          message: "Please verify your mobile number",
          sentTo:  maskPhone(studentPhone),
          phone:   studentPhone,
          method:  "mobile",
        });
      }

      // ── Email flow ──────────────────────────────────────────────────────────
      const otp          = generateOtp();
      const otpExpiresAt = new Date(Date.now() + OTP_TTL_MS);

      const emailFromBody =
        normalizeEmail(studentEmail) ||
        normalizeEmail(email) ||
        normalizeEmail(userEmail) ||
        normalizeEmail(contactEmail);
      const emailFromLink    = normalizeEmail(link.studentEmail);
      const emailFromHistory = await resolveStudentEmail(resolvedStudentUid);
      const resolvedStudentEmail = emailFromBody || emailFromLink || emailFromHistory;

      if (!resolvedStudentEmail) {
        return res.status(400).json({
          message: "No email address found in profile. Please update student email first.",
        });
      }

      if (resolvedStudentEmail !== emailFromLink) {
        await StudentSoulteeLink.updateOne(
          { _id: roomId },
          { $set: { studentEmail: resolvedStudentEmail } }
        ).catch(() => {});
      }

      // Send email FIRST — if it fails, return error immediately (no silent failure).
      // OTP is only saved after email succeeds so the user never gets an expired OTP.
      console.log(`[followUp] sending OTP email to ${resolvedStudentEmail} — room ${roomId}`);
      try {
        await sendFollowUpOtpEmail(resolvedStudentEmail, otp, durationMinutes);
      } catch (mailErr) {
        console.error(`[followUp] email failed for room ${roomId}:`, mailErr.message);
        return res.status(500).json({
          message: `Failed to send OTP email: ${mailErr.message}`,
        });
      }

      const otpRecord = await FollowUpOtp.create({
        otp,
        roomId,
        sessionId:          session?._id ?? null,
        durationMinutes,
        otpExpiresAt,
        studentEmail:       resolvedStudentEmail,
        studentFirebaseUid: link.studentFirebaseUid,
        soulteeFirebaseUid: link.soulteeFirebaseUid,
        verificationMethod: "email",
      });

      console.log(`[followUp] OTP saved & email sent for room ${roomId} → (to: ${resolvedStudentEmail})`);

      io.to(`student:${resolvedStudentUid}`).emit("otp_sent", { roomId, method: "email" });

      res.json({
        success: true,
        message: "Verification code sent to your email",
        sentTo:  resolvedStudentEmail,
        method:  "email",
      });
    } catch (err) {
      console.error("[followUp] request-otp error:", err.message);
      res.status(500).json({ message: err.message });
    }
  });

  // ─── PATCH /api/follow-up/:roomId/end ──────────────────────────────────────
  // Soultee can end the follow-up session early
  router.patch("/:roomId/end", async (req, res) => {
    try {
      const { soulteeUid } = req.body;
      const { roomId } = req.params;

      if (!soulteeUid)
        return res.status(400).json({ message: "soulteeUid is required" });

      const link = await StudentSoulteeLink.findOne({ _id: roomId }).lean();
      if (!link) return res.status(404).json({ message: "Room not found" });
      if (link.soulteeFirebaseUid !== soulteeUid)
        return res.status(403).json({ message: "Not authorized" });

      const record = await FollowUpOtp.findOne({ roomId, status: "USED" });
      if (!record)
        return res.status(404).json({ message: "No active follow-up session found" });

      record.status = "EXPIRED";
      await record.save();

      await StudentSoulteeLink.updateOne({ _id: roomId }, { chatLocked: true });

      io.to(roomId).emit("followup_expired", { roomId });
      io.to(roomId).emit("chat_relocked",    { roomId });

      console.log(`[followUp] Soultee ended follow-up early — room ${roomId}`);
      res.json({ success: true });
    } catch (err) {
      console.error("[followUp] end error:", err.message);
      res.status(500).json({ message: err.message });
    }
  });

  // ─── POST /api/follow-up/:roomId/verify-otp ────────────────────────────────
  router.post("/:roomId/verify-otp", async (req, res) => {
    try {
      const { studentUid, otp, firebaseIdToken } = req.body;
      const { roomId } = req.params;

      if (!studentUid)
        return res.status(400).json({ message: "studentUid is required" });

      const record = await FollowUpOtp.findOne({ roomId, status: "ACTIVE" });
      if (!record)
        return res.status(404).json({ message: "No active code found. Please request a new one." });

      if (record.otpExpiresAt && new Date() > record.otpExpiresAt) {
        await FollowUpOtp.updateOne({ _id: record._id }, { status: "EXPIRED" });
        return res.status(400).json({ message: "Code has expired. Please request a new one." });
      }

      // ── Mobile: verify Firebase ID token ────────────────────────────────────
      if (record.verificationMethod === "mobile") {
        if (!firebaseIdToken)
          return res.status(400).json({ message: "Firebase ID token required for mobile verification." });

        let decoded;
        try {
          decoded = await admin.auth().verifyIdToken(firebaseIdToken);
        } catch {
          return res.status(400).json({ message: "Invalid or expired verification token. Please try again." });
        }

        if (!decoded.phone_number)
          return res.status(400).json({ message: "Phone number not found in verification token." });

        if (decoded.phone_number !== record.studentPhone)
          return res.status(400).json({ message: "Phone number does not match the registered number." });
      } else {
        // ── Email: validate 6-digit code ─────────────────────────────────────
        if (!otp)
          return res.status(400).json({ message: "otp is required" });

        const enteredOtp = String(otp).trim();
        const attempts   = (record.attempts ?? 0) + 1;

        if (attempts > MAX_OTP_ATTEMPTS) {
          await FollowUpOtp.updateOne({ _id: record._id }, { status: "EXPIRED" });
          return res.status(400).json({ message: "Too many attempts. Please request a new code." });
        }

        if (record.otp !== enteredOtp) {
          await FollowUpOtp.updateOne({ _id: record._id }, { attempts });
          const remaining = MAX_OTP_ATTEMPTS - attempts;
          return res.status(400).json({
            message: remaining > 0
              ? `Incorrect code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`
              : "Too many attempts. Please request a new code.",
          });
        }
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
