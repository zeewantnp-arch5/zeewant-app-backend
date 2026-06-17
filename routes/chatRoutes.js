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
  deleteMessageForMe,
  deleteMessageForEveryone,
  bulkDeleteMessages,
} from "../services/messageService.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";
import Message from "../models/Message.js";
import Session from "../models/Session.js";
import FollowUpOtp from "../models/FollowUpCode.js";

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

// Returns true when messages must be blocked for this room.
// Checks (cheapest first):
//   1. chatLocked flag explicitly set (timer-expired sessions)
//   2. link.status === "ended" (manual end-session route)
//   3. Any paid session completed for this pair (old sessions before chatLocked existed)
// An active follow-up OTP (status=USED, not expired) overrides all of the above.
async function isChatLocked(roomId) {
  const link = await StudentSoulteeLink.findOne({ _id: roomId }).lean();
  if (!link) return false; // unknown room — let messageService handle access

  // Fast path: explicit lock flags
  const rawLocked = link.chatLocked === true || link.status === "ended";

  // If locked, check whether an active follow-up OTP overrides it
  if (rawLocked) {
    const activeFollowUp = await FollowUpOtp.exists({
      roomId: String(roomId),
      status: "USED",
      expiresAt: { $gt: new Date() },
    });
    return !activeFollowUp;
  }

  // Slow path: old sessions where chatLocked was never set.
  // Only lock if the LATEST session is completed — a new payment creates a new
  // active session which must override the old completed one.
  const latestSession = await Session.findOne({
    soulteeFirebaseUid: link.soulteeFirebaseUid,
    studentFirebaseUid: link.studentFirebaseUid,
  }).sort({ createdAt: -1 }).lean();
  if (!latestSession || latestSession.status !== "completed") return false;

  const activeFollowUp = await FollowUpOtp.exists({
    roomId: String(roomId),
    status: "USED",
    expiresAt: { $gt: new Date() },
  });
  return !activeFollowUp;
}

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
  // No subscription gate here — participants can always read their own history
  // regardless of whether the subscription is active or the session has ended.
  router.get("/:roomId", async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(100, parseInt(req.query.limit) || 50);
      const skip = (page - 1) * limit;
      const userId = req.query.userId;
      const userRole = req.query.userRole;
      const markRead = req.query.markRead !== "false";

      if (!userId || !userRole) {
        return res.status(400).json({ message: "userId and userRole query params are required" });
      }

      // Allow reading history even when session is ended or pending
      const link = await getRoomLinkForParticipant({
        roomId: req.params.roomId,
        userId,
        userRole,
        allowPending: true,
        allowEnded: true,
      });

      if (!link) {
        console.warn(`[chat/history] room access denied — roomId=${req.params.roomId} userId=${userId} role=${userRole}`);
        return res.status(403).json({ message: "Room access denied" });
      }

      const messages = await Message
        .find({ roomId: req.params.roomId, deletedForUsers: { $nin: [userId] } })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();

      if (markRead && userId && userRole) {
        markRoomMessagesRead({ roomId: req.params.roomId, userId, userRole })
          .then((updatedCount) => {
            if (updatedCount > 0) {
              // Tell room members messages were read (sender sees double-tick)
              io.to(req.params.roomId).emit("room_messages_read", {
                roomId: req.params.roomId,
                readerUid: userId,
                readerRole: userRole,
                count: updatedCount,
              });
              // Reset badge on chat list
              io.to(`${userRole}:${userId}`).emit("session_updated", {
                roomId: req.params.roomId,
                unreadCount: 0,
              });
            }
          })
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
      if (await isChatLocked(req.params.roomId)) {
        return res.status(403).json({ message: "Session has ended. Chat is locked." });
      }

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
      // Push session list refresh to both sides (new preview + updated badge count)
      getRoomMessageMetadata({
        roomIds: [req.params.roomId],
        recipientUid,
        recipientRole,
      }).then((metaMap) => {
        const meta = metaMap.get(req.params.roomId) || {};
        const base = { roomId: req.params.roomId, latestMessage: meta.latestMessage || payload };
        io.to(buildPersonalRoom(recipientRole, recipientUid)).emit("session_updated", {
          ...base,
          unreadCount: meta.unreadCount || 0,
        });
        io.to(buildPersonalRoom(senderRole, senderId)).emit("session_updated", {
          ...base,
          unreadCount: 0, // sender has no unread for their own message
        });
      }).catch(() => {});

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
      if (await isChatLocked(req.params.roomId)) {
        return res.status(403).json({ message: "Session has ended. Chat is locked." });
      }

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

  // ─── DELETE /api/chat/:roomId/messages/:messageId — single delete ───────────
  router.delete("/:roomId/messages/:messageId", async (req, res) => {
    try {
      const { userId, userRole, deleteFor } = req.body;
      const { roomId, messageId } = req.params;

      if (!userId || !userRole) {
        return res.status(400).json({ message: "userId and userRole are required" });
      }

      const link = await getRoomLinkForParticipant({
        roomId,
        userId,
        userRole,
        allowPending: true,
        allowEnded: true,
      });
      if (!link) return res.status(403).json({ message: "Room access denied" });

      const studentUid  = link.studentFirebaseUid;
      const soulteeUid  = link.soulteeFirebaseUid;
      const otherUid    = userId === studentUid ? soulteeUid : studentUid;
      const otherRole   = userId === studentUid ? "soultee"  : "student";

      let message;
      if (deleteFor === "everyone") {
        message = await deleteMessageForEveryone({ messageId, userId });
        if (!message) {
          return res.status(403).json({ message: "Only the message sender can delete for everyone" });
        }
        const payload = {
          messageId,
          roomId,
          deletedForEveryone: true,
          deletedBy: userId,
          deletedAt: message.deletedAt,
        };
        io.to(roomId).emit("message_deleted", payload);
        io.to(`${otherRole}:${otherUid}`).emit("message_deleted", payload);
      } else {
        message = await deleteMessageForMe({ messageId, userId });
        if (!message) return res.status(404).json({ message: "Message not found" });
        // Only the requester needs to update their UI
        io.to(`${userRole}:${userId}`).emit("message_deleted", {
          messageId,
          roomId,
          deletedForEveryone: false,
        });
      }

      res.json({ message: serializeMessage(message) });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // ─── DELETE /api/chat/:roomId/messages — bulk delete ────────────────────────
  router.delete("/:roomId/messages", async (req, res) => {
    try {
      const { userId, userRole, messageIds, deleteFor } = req.body;
      const { roomId } = req.params;

      if (!userId || !userRole || !Array.isArray(messageIds) || messageIds.length === 0) {
        return res.status(400).json({ message: "userId, userRole, and messageIds[] are required" });
      }

      const link = await getRoomLinkForParticipant({
        roomId,
        userId,
        userRole,
        allowPending: true,
        allowEnded: true,
      });
      if (!link) return res.status(403).json({ message: "Room access denied" });

      const studentUid = link.studentFirebaseUid;
      const soulteeUid = link.soulteeFirebaseUid;
      const otherUid   = userId === studentUid ? soulteeUid : studentUid;
      const otherRole  = userId === studentUid ? "soultee"  : "student";

      const { deletedCount, affectedIds } = await bulkDeleteMessages({ messageIds, userId, deleteFor });

      if (deleteFor === "everyone") {
        const payload = {
          messageIds: affectedIds,
          roomId,
          deletedForEveryone: true,
          deletedBy: userId,
          deletedAt: new Date(),
        };
        io.to(roomId).emit("bulk_messages_deleted", payload);
        io.to(`${otherRole}:${otherUid}`).emit("bulk_messages_deleted", payload);
      } else {
        io.to(`${userRole}:${userId}`).emit("bulk_messages_deleted", {
          messageIds: affectedIds,
          roomId,
          deletedForEveryone: false,
        });
      }

      res.json({ deletedCount, affectedIds });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}
