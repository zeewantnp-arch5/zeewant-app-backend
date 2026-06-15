import express from "express";
import CallEvent from "../models/CallEvent.js";
import {
  getCallHistory,
  getMissedCallsForUser,
  getCallHistoryForRoom,
  markCallsSeen,
} from "../services/callEventService.js";
import { generateJitsiToken, buildJitsiServerUrl } from "../services/jitsiService.js";

const router = express.Router();

// ── GET /api/calls/history/:userUid  — full call log for a user ──────────────
// Query: ?limit=20&skip=0
router.get("/history/:userUid", async (req, res) => {
  try {
    const { userUid } = req.params;
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip = Math.max(0, parseInt(req.query.skip) || 0);

    const calls = await getCallHistory({ userId: userUid, limit, skip });
    res.json({ calls });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/calls/missed/:userUid  — missed calls for a user ────────────────
// Query: ?limit=50
router.get("/missed/:userUid", async (req, res) => {
  try {
    const { userUid } = req.params;
    const limit = Math.min(100, parseInt(req.query.limit) || 50);

    const calls = await getMissedCallsForUser({ userId: userUid, limit });
    res.json({ calls });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/calls/room/:roomId  — call history for a chat room ──────────────
// Query: ?limit=20
router.get("/room/:roomId", async (req, res) => {
  try {
    const { roomId } = req.params;
    const limit = Math.min(100, parseInt(req.query.limit) || 20);

    const calls = await getCallHistoryForRoom({ roomId, limit });
    res.json({ calls });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── PATCH /api/calls/:callId/seen  — mark a call log entry as seen ───────────
// Body: { userId }
router.patch("/:callId/seen", async (req, res) => {
  try {
    const { callId } = req.params;
    await markCallsSeen([callId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── PATCH /api/calls/seen/bulk  — mark multiple call log entries as seen ─────
// Body: { callIds: string[] }
router.patch("/seen/bulk", async (req, res) => {
  try {
    const { callIds } = req.body;
    if (!Array.isArray(callIds) || callIds.length === 0) {
      return res.status(400).json({ message: "callIds array is required" });
    }
    await markCallsSeen(callIds);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/calls/jitsi-token  — generate a Jitsi JWT for the calling user ──
// Query: ?room=jitsiRoomName&userId=uid&userName=Display+Name
// Returns: { token, serverUrl } — Flutter passes token to JitsiMeetConferenceOptions
router.get("/jitsi-token", async (req, res) => {
  try {
    const { room, userId, userName } = req.query;

    if (!room || !userId) {
      return res.status(400).json({ message: "room and userId are required" });
    }

    const token = generateJitsiToken({
      userId,
      userName: userName || userId,
      roomName: room,
      isModerator: true,
    });

    res.json({
      token,
      serverUrl: buildJitsiServerUrl(),
      room,
      expiresInSeconds: 7200,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/calls/:callId  — single call log entry ─────────────────────────
router.get("/:callId", async (req, res) => {
  try {
    const call = await CallEvent.findById(req.params.callId).lean();
    if (!call) {
      return res.status(404).json({ message: "Call not found" });
    }
    res.json({ call });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
