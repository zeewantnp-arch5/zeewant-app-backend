import express from "express";
import FCMToken from "../models/FCMToken.js";
import Notification from "../models/Notification.js";

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
//  REGISTER / UPDATE FCM TOKEN
//  Called by the app after Firebase login and whenever the token refreshes
//  POST /api/notifications/register-token
//  Body: { uid, role, token }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/register-token", async (req, res) => {
  try {
    const { uid, role, token } = req.body;
    if (!uid || !role || !token) {
      return res.status(400).json({ message: "uid, role, and token are required" });
    }

    await FCMToken.findOneAndUpdate(
      { uid },
      { uid, role, token },
      { upsert: true, new: true }
    );

    res.json({ message: "Token registered" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  REMOVE FCM TOKEN (on logout)
//  DELETE /api/notifications/token/:uid
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/token/:uid", async (req, res) => {
  try {
    await FCMToken.deleteOne({ uid: req.params.uid });
    res.json({ message: "Token removed" });
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
    await Notification.updateMany(
      { recipientUid: req.params.uid, read: false },
      { read: true }
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
    res.json({ message: "All notifications cleared" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
