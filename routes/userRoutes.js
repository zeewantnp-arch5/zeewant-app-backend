import express from "express";
import admin from "../config/firebase.js";
import BiometricDevice from "../models/BiometricDevice.js";
import FCMToken from "../models/FCMToken.js";
import Souljar from "../models/souljar.js";
import SoulMeterReading from "../models/SoulMeterReading.js";
import Soulpana from "../models/Soulpana.js";
import SoulpanaComment from "../models/SoulpanaComment.js";
import Post from "../models/Post.js";
import PostComment from "../models/PostComment.js";
import Session from "../models/Session.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";
import Notification from "../models/Notification.js";
import UserSettings from "../models/UserSettings.js";
import UserSubscription from "../models/UserSubscription.js";
import Payment from "../models/Payment.js";
import FeaturePayment from "../models/FeaturePayment.js";
import FeatureSubscription from "../models/FeatureSubscription.js";
import SoulwayReport from "../models/SoulwayReport.js";
import EmotionalPrescription from "../models/EmotionalPrescription.js";
import PhoneAuth from "../models/PhoneAuth.js";
import SoulteeFeedback from "../models/SoulteeFeedback.js";
import FollowUpCode from "../models/FollowUpCode.js";
import SessionAccessCode from "../models/SessionAccessCode.js";
import SupportTicket from "../models/SupportTicket.js";
import UserComplaint from "../models/UserComplaint.js";
import UserFeedback from "../models/UserFeedback.js";
import Soultee from "../models/Soultee.js";
import SoulteeApplication from "../models/SoulteeApplication.js";
import SessionWallet from "../models/SessionWallet.js";
import SessionWithdrawal from "../models/SessionWithdrawal.js";

const router = express.Router();

// DELETE /api/users/delete-account
// Body: { uid: string, role: "student" | "soultee" }
// Permanently deletes all user data across MongoDB, Firebase RTDB, and Firebase Auth.
router.delete("/delete-account", async (req, res) => {
  const { uid, role } = req.body;
  if (!uid || !role) {
    return res.status(400).json({ error: "uid and role are required" });
  }

  try {
    // ── Collections shared by all roles ──────────────────────────────────────
    await Promise.all([
      BiometricDevice.deleteMany({ firebaseUid: uid }),
      FCMToken.deleteMany({ userUid: uid }),
      Souljar.deleteMany({ userId: uid }),
      SoulMeterReading.deleteMany({ userId: uid }),
      Soulpana.deleteMany({ userId: uid }),
      SoulpanaComment.deleteMany({ authorId: uid }),
      Post.deleteMany({ userId: uid }),
      PostComment.deleteMany({ authorId: uid }),
      Session.deleteMany({ studentFirebaseUid: uid }),
      StudentSoulteeLink.deleteMany({ studentFirebaseUid: uid }),
      Notification.deleteMany({ recipientUid: uid }),
      UserSettings.deleteMany({ userId: uid }),
      UserSubscription.deleteMany({ userId: uid }),
      Payment.deleteMany({ userId: uid }),
      FeaturePayment.deleteMany({ userId: uid }),
      FeatureSubscription.deleteMany({ userId: uid }),
      SoulwayReport.deleteMany({ userId: uid }),
      EmotionalPrescription.deleteMany({ userId: uid }),
      PhoneAuth.deleteMany({ firebaseUid: uid }),
      SoulteeFeedback.deleteMany({ studentUid: uid }),
      FollowUpCode.deleteMany({ studentFirebaseUid: uid }),
      SessionAccessCode.deleteMany({ userId: uid }),
      SupportTicket.deleteMany({ $or: [{ senderId: uid }, { userId: uid }] }),
      UserComplaint.deleteMany({ userId: uid }),
      UserFeedback.deleteMany({ userId: uid }),
    ]);

    // ── Soultee-only collections ──────────────────────────────────────────────
    if (role === "soultee") {
      await Promise.all([
        Soultee.deleteMany({ firebaseUid: uid }),
        SoulteeApplication.deleteMany({ firebaseUid: uid }),
        SessionWallet.deleteMany({ soulteeFirebaseUid: uid }),
        SessionWithdrawal.deleteMany({ soulteeFirebaseUid: uid }),
        Session.deleteMany({ soulteeFirebaseUid: uid }),
        StudentSoulteeLink.deleteMany({ soulteeFirebaseUid: uid }),
        FollowUpCode.deleteMany({ soulteeFirebaseUid: uid }),
        SoulteeFeedback.deleteMany({ soulteeUid: uid }),
      ]);
    }

    // ── Firebase RTDB cleanup ─────────────────────────────────────────────────
    if (admin.apps.length) {
      try {
        const db = admin.database();
        await Promise.all([
          db.ref(`profiles/${uid}`).remove(),
          db.ref(`notifications/${uid}`).remove(),
          db.ref(`otps/${uid}`).remove(),
        ]);
      } catch (rtdbErr) {
        console.warn("RTDB cleanup error (non-fatal):", rtdbErr.message);
      }
    }

    // ── Firebase Auth deletion ────────────────────────────────────────────────
    try {
      await admin.auth().deleteUser(uid);
    } catch (authErr) {
      if (authErr.code !== "auth/user-not-found") throw authErr;
    }

    return res.json({ success: true, message: "Account permanently deleted" });
  } catch (err) {
    console.error("delete-account error:", err);
    return res.status(500).json({ error: "Failed to delete account", detail: err.message });
  }
});

export default router;
