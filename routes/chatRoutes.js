import express from "express";
import fs from "fs";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { buildPersonalRoom, createNotification } from "../services/notificationService.js";
import { requireSubscription } from "../middleware/subscriptionMiddleware.js";
import {
  createPersistentMessage,
  getRoomLinkForParticipant,
  getUnreadMessageSummary,
  markRoomMessagesRead,
  markMessageDelivered,
  markMessageRead,
  getMessageStatus,
  markRoomMessagesDelivered,
  serializeMessage,
  getRoomMessageMetadata,
} from "../services/messageService.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";
import Message from "../models/Message.js";

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
  router.get("/:roomId", requireSubscription, async (req, res) => {
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
        console.warn(`[chat/history] room access denied — roomId=${req.params.roomId} userId=${userId} role=${userRole}`);
        return res.status(403).json({ message: "Room access denied" });
      }

      const messages = await Message
        .find({ roomId: req.params.roomId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();

      if (markRead && userId && userRole) {
        markRoomMessagesRead({ roomId: req.params.roomId, userId, userRole })
          .catch(err => console.error("[chat/markRead] failed:", err.message));
      }

      res.json({ messages: messages.reverse().map(m => serializeMessage(m)), page });
    } catch (err) {
      console.error(`[chat/history] error — roomId=${req.params.roomId}:`, err.message);
      res.status(500).json({ message: err.message });
    }
  });

  // ─── POST /api/chat/:roomId/messages — durable send path ───────────────────
  router.post("/:roomId/messages", requireSubscription, async (req, res) => {
    try {
      const {
        senderId,
        senderName,
        senderRole,
        text,
        type = "text",
        callType = null,
        allowPending = false,
        attachmentUrl = null,
        attachmentName = null,
        attachmentMimeType = null,
      } = req.body;

      // For attachment messages the text may be the filename, so only require
      // non-empty text when there is also no attachment URL.
      const hasText = String(text || "").trim().length > 0;
      const hasAttachment = attachmentUrl && String(attachmentUrl).trim().length > 0;
      if (!senderId || !senderRole || (!hasText && !hasAttachment)) {
        return res.status(400).json({ message: "senderId, senderRole, and text or attachmentUrl are required" });
      }

      const attachment = hasAttachment
        ? { url: attachmentUrl, name: attachmentName || null, mimeType: attachmentMimeType || null }
        : null;

      const { message, recipientUid, recipientRole } = await createPersistentMessage({
        roomId: req.params.roomId,
        senderId,
        senderName,
        senderRole,
        text: hasText ? text : (attachmentName || type),
        type,
        callType: callType || null,
        attachment,
        allowPending,
      });

      console.log(`[chat/save] ✓ msgId=${message._id} room=${req.params.roomId} from=${senderId}(${senderRole})`);
      const payload = serializeMessage(message);
      // 1. Deliver to anyone currently in the chat room (both sides if open).
      io.to(req.params.roomId).emit("new_message", payload);
      // 2. Push to recipient's personal room so their global socket refreshes
      //    the session list even when they are not in the chat screen.
      io.to(buildPersonalRoom(recipientRole, recipientUid)).emit("new_message", payload);
      // 3. Push to sender's personal room as well — ensures the sender's socket
      //    gets the echo even if join_room hasn't been confirmed yet (race condition).
      io.to(buildPersonalRoom(senderRole, senderId)).emit("new_message", payload);
      // Legacy badge/unread event kept for any listeners that still use it.
      io.to(buildPersonalRoom(recipientRole, recipientUid)).emit("message_unread", {
        roomId: req.params.roomId,
        message: payload,
      });

      // Skip standard "New Message" push for missed-call entries — the caller
      // already sends a dedicated FCM missed-call notification separately.
      if (type !== "missed_call") {
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
      }

      res.status(201).json({ message: payload });
    } catch (err) {
      const statusCode = err.message === "Room access denied" ? 403 : 500;
      res.status(statusCode).json({ message: err.message });
    }
  });

  // ─── POST /api/chat/:roomId/attachments — upload + send media/file message ─
  router.post("/:roomId/attachments", requireSubscription, attachmentUpload.single("file"), async (req, res) => {
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
      io.to(buildPersonalRoom(recipientRole, recipientUid)).emit("new_message", payload);
      io.to(buildPersonalRoom(senderRole, senderId)).emit("new_message", payload);
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

  // ─── PATCH /api/chat/:roomId/messages/:messageId/delivered ────────────────────
  router.patch("/:roomId/messages/:messageId/delivered", async (req, res) => {
    try {
      const { userId, userRole } = req.body;
      const { roomId, messageId } = req.params;

      const link = await getRoomLinkForParticipant({
        roomId,
        userId,
        userRole,
        allowPending: true,
      });

      if (!link) {
        return res.status(403).json({ message: "Room access denied" });
      }

      const message = await markMessageDelivered(messageId);
      if (!message) {
        return res.status(404).json({ message: "Message not found" });
      }

      const payload = serializeMessage(message);
      io.to(roomId).emit("message_updated", {
        messageId: message._id,
        status: "delivered",
        deliveredAt: message.deliveredAt,
      });

      res.json({ message: payload });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── PATCH /api/chat/:roomId/messages/:messageId/read ────────────────────
  router.patch("/:roomId/messages/:messageId/read", async (req, res) => {
    try {
      const { userId, userRole } = req.body;
      const { roomId, messageId } = req.params;

      const link = await getRoomLinkForParticipant({
        roomId,
        userId,
        userRole,
        allowPending: true,
      });

      if (!link) {
        return res.status(403).json({ message: "Room access denied" });
      }

      const message = await markMessageRead(messageId);
      if (!message) {
        return res.status(404).json({ message: "Message not found" });
      }

      const payload = serializeMessage(message);
      io.to(roomId).emit("message_updated", {
        messageId: message._id,
        status: "read",
        readAt: message.readAt,
      });

      res.json({ message: payload });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── POST /api/chat/:roomId/read — mark all as read ─────────────────────────
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

      io.to(req.params.roomId).emit("room_messages_read", {
        roomId: req.params.roomId,
        userId,
        userRole,
      });

      res.json({ updated });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── GET /api/chat/active-sessions/:userUid ──────────────────────────────────
  router.get("/active-sessions/:userUid", async (req, res) => {
    try {
      const { userUid } = req.params;
      const userRole = req.query.userRole;

      if (!userRole || !["student", "soultee"].includes(userRole)) {
        return res.status(400).json({ message: "userRole query parameter is required and must be 'student' or 'soultee'" });
      }

      const query = { status: "active" };
      if (userRole === "student") {
        query.studentFirebaseUid = userUid;
      } else {
        query.soulteeFirebaseUid = userUid;
      }

      const sessions = await StudentSoulteeLink.find(query)
        .sort({ acceptedAt: -1 })
        .lean();

      // Enrich with message metadata
      const roomIds = sessions.map(s => String(s._id));
      const metadataByRoom = await getRoomMessageMetadata({
        roomIds,
        recipientUid: userUid,
        recipientRole: userRole,
      });

      const enrichedSessions = sessions.map(session => {
        const roomId = String(session._id);
        const metadata = metadataByRoom.get(roomId) || {};
        return {
          ...session,
          roomId,
          latestMessage: metadata.latestMessage || null,
          unreadMessageCount: metadata.unreadCount || 0,
        };
      });

      res.json({ sessions: enrichedSessions, total: enrichedSessions.length });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── GET /api/chat/pending-requests/:userUid ──────────────────────────────────
  router.get("/pending-requests/:userUid", async (req, res) => {
    try {
      const { userUid } = req.params;
      const userRole = req.query.userRole;

      if (!userRole || !["student", "soultee"].includes(userRole)) {
        return res.status(400).json({ message: "userRole query parameter is required and must be 'student' or 'soultee'" });
      }

      const query = { status: "pending" };
      if (userRole === "student") {
        query.studentFirebaseUid = userUid;
      } else {
        query.soulteeFirebaseUid = userUid;
      }

      const requests = await StudentSoulteeLink.find(query)
        .sort({ requestedAt: -1 })
        .lean();

      // Enrich with message metadata
      const roomIds = requests.map(r => String(r._id));
      const metadataByRoom = await getRoomMessageMetadata({
        roomIds,
        recipientUid: userUid,
        recipientRole: userRole,
      });

      const enrichedRequests = requests.map(request => {
        const roomId = String(request._id);
        const metadata = metadataByRoom.get(roomId) || {};
        return {
          ...request,
          roomId,
          latestMessage: metadata.latestMessage || null,
          unreadMessageCount: metadata.unreadCount || 0,
        };
      });

      res.json({ requests: enrichedRequests, total: enrichedRequests.length });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}
