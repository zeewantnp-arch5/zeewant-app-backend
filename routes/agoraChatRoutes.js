import express from "express";
import admin from "../config/firebase.js";
import {
  registerAgoraChatUser,
  generateAgoraChatToken,
} from "../services/agoraChatService.js";

const router = express.Router();

// POST /api/agora-chat/token
//
// Flutter calls this once on startup (and again when the token is about to
// expire) to get a signed Agora Chat user token.
//
// Body   : { firebaseToken: string }
// Returns: { token: string, uid: string, appKey: string }
//
// Flow:
//   1. Verify the Firebase ID token to authenticate the caller.
//   2. Ensure the user exists in Agora Chat (idempotent registration).
//   3. Sign a 24-hour Agora Chat user token and return it.
router.post("/token", async (req, res) => {
  try {
    const { firebaseToken } = req.body;
    if (!firebaseToken) {
      return res.status(400).json({ message: "firebaseToken is required" });
    }

    // Verify Firebase ID token — throws if invalid / expired.
    const decoded = await admin.auth().verifyIdToken(firebaseToken);
    const uid     = decoded.uid;

    // Register user in Agora Chat if not already registered (409 = already exists).
    await registerAgoraChatUser(uid);

    // Generate a signed user access token (valid 24 h).
    const token  = generateAgoraChatToken(uid);
    const appKey = process.env.AGORA_CHAT_APP_KEY || "";

    res.json({ token, uid: uid.toLowerCase(), appKey });
  } catch (err) {
    console.error("[agora-chat/token] error:", err.message);
    // Distinguish auth failures from config/server errors
    const status = err.code?.startsWith("auth/") ? 401 : 500;
    res.status(status).json({ message: err.message });
  }
});

export default router;
