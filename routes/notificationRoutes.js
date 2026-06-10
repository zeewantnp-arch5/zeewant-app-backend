import express from "express";
import FCMToken from "../models/FCMToken.js";
import Notification from "../models/Notification.js";
import { updateNotificationInRTDB, deleteNotificationFromRTDB } from "../config/firebase.js";
import { registerFCMToken, deactivateFCMToken } from "../services/fcmService.js";

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
//  REGISTER / UPDATE FCM TOKEN
//  Called by the app after Firebase login and whenever the token refreshes
//  POST /api/notifications/register-token
//  Body: { userUid, token } - Updated to use new schema
// ─────────────────────────────────────────────────────────────────────────────
router.post("/register-token", async (req, res) => {
  try {
    const { userUid, token } = req.body;
    if (!userUid || !token) {
      return res.status(400).json({ message: "userUid and token are required" });
    }

    const fcmToken = await registerFCMToken(userUid, token);
    res.json({ message: "Token registered", token: fcmToken });
  } catch (err) {
    console.error("[FCM] register-token failed:", err.message);
    // Non-fatal — app works without push notifications
    res.status(200).json({ message: "Token registration skipped", error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  REMOVE FCM TOKEN (on logout or device unpairing)
//  POST /api/notifications/unregister-token
//  Body: { userUid, token }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/unregister-token", async (req, res) => {
  try {
    const { userUid, token } = req.body;
    if (!userUid || !token) {
      return res.status(400).json({ message: "userUid and token are required" });
    }

    await deactivateFCMToken(userUid, token);
    res.json({ message: "Token deactivated" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET ALL NOTIFICATIONS FOR A USER
//  GET /api/notifications/:uid?limit=20&offset=0&unreadOnly=false
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:uid", async (req, res) => {
  try {
    const { uid } = req.params;
    const limit      = Math.min(parseInt(req.query.limit)  || 20, 100);
    const offset     = parseInt(req.query.offset) || 0;
    const unreadOnly = req.query.unreadOnly === "true";

    const filter = { recipientUid: uid };
    if (unreadOnly) filter.read = false;

    const [notifications, unreadCount] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      Notification.countDocuments({ recipientUid: uid, read: false }),
    ]);

    res.json({ notifications, unreadCount, total: notifications.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  UNREAD COUNT ONLY (lightweight — for badge polling)
//  GET /api/notifications/:uid/unread-count
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:uid/unread-count", async (req, res) => {
  try {
    const count = await Notification.countDocuments({
      recipientUid: req.params.uid,
      read: false,
    });
    res.json({ unreadCount: count });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  MARK A SINGLE NOTIFICATION AS READ
//  PATCH /api/notifications/:uid/:notifId/read
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/:uid/:notifId/read", async (req, res) => {
  try {
    const notif = await Notification.findOneAndUpdate(
      { _id: req.params.notifId, recipientUid: req.params.uid },
      { read: true },
      { new: true }
    );
    if (!notif) return res.status(404).json({ message: "Notification not found" });
    updateNotificationInRTDB(req.params.uid, req.params.notifId, { read: true });
    res.json({ notification: notif });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  MARK ALL NOTIFICATIONS AS READ
//  PATCH /api/notifications/:uid/read-all
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/:uid/read-all", async (req, res) => {
  try {
    const unread = await Notification.find(
      { recipientUid: req.params.uid, read: false },
      { _id: 1 }
    ).lean();
    await Notification.updateMany(
      { recipientUid: req.params.uid, read: false },
      { read: true }
    );
    // Sync each to RTDB
    unread.forEach(({ _id }) =>
      updateNotificationInRTDB(req.params.uid, String(_id), { read: true })
    );
    res.json({ message: "All notifications marked as read" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  DELETE A SINGLE NOTIFICATION
//  DELETE /api/notifications/:uid/:notifId
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:uid/:notifId", async (req, res) => {
  try {
    await Notification.findOneAndDelete({
      _id: req.params.notifId,
      recipientUid: req.params.uid,
    });
    deleteNotificationFromRTDB(req.params.uid, req.params.notifId);
    res.json({ message: "Notification deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  CLEAR ALL NOTIFICATIONS FOR A USER
//  DELETE /api/notifications/:uid/clear-all
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:uid/clear-all", async (req, res) => {
  try {
    await Notification.deleteMany({ recipientUid: req.params.uid });
    deleteNotificationFromRTDB(req.params.uid, null);
    res.json({ message: "All notifications cleared" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
