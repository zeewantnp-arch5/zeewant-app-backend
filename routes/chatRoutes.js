import express from "express";
import { buildPersonalRoom, createNotification } from "../services/notificationService.js";
import {
  createPersistentMessage,
  getRoomLinkForParticipant,
  getUnreadMessageSummary,
  markRoomMessagesRead,
  serializeMessage,
} from "../services/messageService.js";

export default function createChatRoutes(io) {
  const router = express.Router();

  router.get("/unread-summary/:userRole/:userUid", async (req, res) => {
    try {
      const { userRole, userUid } = req.params;
      const summary = await getUnreadMessageSummary({
        userId: userUid,
        userRole,
      });

      res.json(summary);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── GET /api/chat/:roomId  — message history (newest last) ────────────────
  router.get("/:roomId", async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(100, parseInt(req.query.limit) || 50);
      const skip = (page - 1) * limit;
      const userId = req.query.userId;
      const userRole = req.query.userRole;
      const markRead = req.query.markRead !== "false";

      const link = await getRoomLinkForParticipant({
        roomId: req.params.roomId,
        userId,
        userRole,
        allowPending: true,
      });

      if (!link) {
        return res.status(403).json({ message: "Room access denied" });
      }

      const messages = await (await import("../models/Message.js")).default
        .find({ roomId: req.params.roomId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();

      if (markRead && userId && userRole) {
        await markRoomMessagesRead({ roomId: req.params.roomId, userId, userRole });
      }

      res.json({ messages: messages.reverse(), page });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── POST /api/chat/:roomId/messages — durable send path ───────────────────
  router.post("/:roomId/messages", async (req, res) => {
    try {
      const { senderId, senderName, senderRole, text, type = "text", allowPending = false } = req.body;
      if (!senderId || !senderRole || !String(text || "").trim()) {
        return res.status(400).json({ message: "senderId, senderRole, and text are required" });
      }

      const { message, recipientUid, recipientRole } = await createPersistentMessage({
        roomId: req.params.roomId,
        senderId,
        senderName,
        senderRole,
        text,
        type,
        allowPending,
      });

      const payload = serializeMessage(message);
      io.to(req.params.roomId).emit("new_message", payload);
      io.to(buildPersonalRoom(recipientRole, recipientUid)).emit("message_unread", {
        roomId: req.params.roomId,
        message: payload,
      });

      await createNotification(io, {
        recipientUid,
        recipientRole,
        type: "unread_message",
        title: "New Message",
        body: `${senderName || "Someone"} sent you a message`,
        data: {
          type: "unread_message",
          roomId: req.params.roomId,
          senderId,
          senderRole,
        },
      });

      res.status(201).json({ message: payload });
    } catch (err) {
      const statusCode = err.message === "Room access denied" ? 403 : 500;
      res.status(statusCode).json({ message: err.message });
    }
  });

  router.post("/:roomId/read", async (req, res) => {
    try {
      const { userId, userRole } = req.body;
      const link = await getRoomLinkForParticipant({
        roomId: req.params.roomId,
        userId,
        userRole,
        allowPending: true,
      });

      if (!link) {
        return res.status(403).json({ message: "Room access denied" });
      }

      const updated = await markRoomMessagesRead({
        roomId: req.params.roomId,
        userId,
        userRole,
      });

      res.json({ updated });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}
