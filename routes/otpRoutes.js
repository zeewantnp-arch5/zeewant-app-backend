import express from "express";
import FCMToken from "../models/FCMToken.js";
import { storeOTP, verifyOTP, sendPushNotification } from "../config/firebase.js";

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
//  SEND OTP
//  Generates a 6-digit OTP, stores it in Firebase RTDB (/otps/{uid}),
//  and delivers it as a FCM push notification to the user's device.
//
//  POST /api/otp/send
//  Body: { uid, purpose? }   purpose e.g. "login", "profile_update" (optional label)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/send", async (req, res) => {
  try {
    const { uid, purpose = "verification" } = req.body;
    if (!uid) return res.status(400).json({ message: "uid is required" });

    // Generate and store OTP in RTDB (TTL: 5 min)
    const otp = await storeOTP(uid);

    // Deliver OTP via FCM push notification if device token exists
    const tokenRecord = await FCMToken.findOne({ uid }).lean();
    if (tokenRecord) {
      await sendPushNotification(
        tokenRecord.token,
        "Your Verification Code",
        `Your Zeewant OTP is ${otp}. Valid for 5 minutes.`,
        { type: "otp", purpose, uid }
      );
    }

    // In production never send OTP in the response body.
    // Return success only; the OTP is delivered via push notification.
    res.json({
      message: "OTP sent successfully",
      deliveredVia: tokenRecord ? "push_notification" : "none",
      // DEV ONLY — remove before going live:
      ...(process.env.NODE_ENV !== "production" && { otp }),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  VERIFY OTP
//  Checks the code against what is stored in Firebase RTDB.
//  Deletes the record on success (one-time use).
//
//  POST /api/otp/verify
//  Body: { uid, otp }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/verify", async (req, res) => {
  try {
    const { uid, otp } = req.body;
    if (!uid || !otp) return res.status(400).json({ message: "uid and otp are required" });

    const result = await verifyOTP(uid, otp);

    if (!result.valid) {
      return res.status(400).json({ message: result.reason });
    }

    res.json({ message: "OTP verified successfully", verified: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
