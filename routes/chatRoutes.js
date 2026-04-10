import express from "express";
import Message from "../models/Message.js";

const router = express.Router();

// ─── GET /api/chat/:roomId  — message history (newest last) ──────────────────
router.get("/:roomId", async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const skip  = (page - 1) * limit;

    const messages = await Message.find({ roomId: req.params.roomId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json({ messages: messages.reverse(), page });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
