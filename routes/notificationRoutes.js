import express from "express";
import FCMToken from "../models/FCMToken.js";

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
//  REGISTER / UPDATE FCM TOKEN
//  Called by the app every time it gets a new FCM token from Firebase SDK
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

export default router;
