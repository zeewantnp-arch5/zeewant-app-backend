import express from "express";
import fs from "fs";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { buildPersonalRoom, createNotification } from "../services/notificationService.js";
import {
  createPersistentMessage,
  getRoomLinkForParticipant,
  getUnreadMessageSummary,
  markRoomMessagesRead,
  serializeMessage,
} from "../services/messageService.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const chatUploadsDir = path.join(__dirname, "../uploads/chat");
if (!fs.existsSync(chatUploadsDir)) {
  fs.mkdirSync(chatUploadsDir, { recursive: true });
}

const attachmentStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, chatUploadsDir),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

const attachmentUpload = multer({
  storage: attachmentStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
});

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
        type: "new_message",
        title: "New Message",
        body: `${senderName || "Someone"} sent you a message`,
        data: {
          type: "new_message",
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

  // ─── POST /api/chat/:roomId/attachments — upload + send media/file message ─
  router.post("/:roomId/attachments", attachmentUpload.single("file"), async (req, res) => {
    try {
      const { senderId, senderName, senderRole, type = "document", text = "", allowPending = false } =
        req.body;

      if (!senderId || !senderRole) {
        return res.status(400).json({ message: "senderId and senderRole are required" });
      }

      if (!req.file) {
        return res.status(400).json({ message: "file is required" });
      }

      const normalizedType = String(type).toLowerCase();
      if (!["image", "video", "document", "audio"].includes(normalizedType)) {
        return res.status(400).json({ message: "Invalid attachment type" });
      }

      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const fileUrl = `${baseUrl}/uploads/chat/${req.file.filename}`;

      const { message, recipientUid, recipientRole } = await createPersistentMessage({
        roomId: req.params.roomId,
        senderId,
        senderName,
        senderRole,
        text: String(text || "").trim() || req.file.originalname,
        type: normalizedType,
        attachment: {
          url: fileUrl,
          name: req.file.originalname,
          mimeType: req.file.mimetype,
          size: req.file.size,
        },
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
        type: "new_message",
        title: "New Attachment",
        body: `${senderName || "Someone"} sent a ${normalizedType}`,
        data: {
          type: "new_message",
          roomId: req.params.roomId,
          senderId,
          senderRole,
          messageType: normalizedType,
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
