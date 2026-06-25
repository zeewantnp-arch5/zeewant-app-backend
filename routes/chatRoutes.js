/**
 * chatRoutes.js  — Firebase-first chat API
 *
 * After the Firebase migration messages are written directly to Firestore
 * by Flutter clients.  This router now only handles:
 *   • Active sessions / pending-request list  (MongoDB metadata + Firestore lastMessage)
 *   • Unread summary                           (Firestore conversation docs)
 *   • Missed-call recording                   (backend logs CallEvent in MongoDB)
 *
 * All message CRUD endpoints (POST /messages, PATCH .../delivered, DELETE ...,
 * etc.) have been removed — Firestore Security Rules enforce access control
 * directly on the client writes.
 */

import express from "express";
import { buildPersonalRoom, createNotification } from "../services/notificationService.js";
import { getRoomLinkForParticipant } from "../services/messageService.js";
import { getConversationsMeta, sendSystemMessage } from "../services/firestoreChatService.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";
import CallEvent from "../models/CallEvent.js";

export default function createChatRoutes(io) {
  const router = express.Router();

  // ── GET /api/chat/active-sessions/:userUid ──────────────────────────────
  // Returns the list of active StudentSoulteeLinks enriched with real-time
  // lastMessage and unreadCount from Firestore conversation documents.
  router.get("/active-sessions/:userUid", async (req, res) => {
    try {
      const { userUid } = req.params;
      const userRole = req.query.userRole;

      if (!userRole || !["student", "soultee"].includes(userRole)) {
        return res.status(400).json({
          message: "userRole must be 'student' or 'soultee'",
        });
      }

      const query = { status: "active" };
      if (userRole === "student") {
        query.studentFirebaseUid = userUid;
      } else {
        query.soulteeFirebaseUid = userUid;
      }

      const links = await StudentSoulteeLink.find(query)
        .sort({ acceptedAt: -1 })
        .lean();

      const roomIds = links.map((l) => String(l._id));

      // Pull lastMessage + unreadCounts from Firestore in one batched read.
      const firestoreMeta = await getConversationsMeta(roomIds);

      const sessions = links.map((link) => {
        const roomId = String(link._id);
        const meta = firestoreMeta[roomId] || {};
        const unreadCount =
          (meta.unreadCounts?.[userUid] ?? meta.unreadCounts?.[userRole]) || 0;
        return {
          ...link,
          roomId,
          latestMessage: meta.lastMessage || null,
          unreadMessageCount: unreadCount,
          chatLocked: meta.chatLocked ?? link.chatLocked ?? false,
        };
      });

      res.json({ sessions, total: sessions.length });
    } catch (err) {
      console.error("[chat/active-sessions]", err.message);
      res.status(500).json({ message: err.message });
    }
  });

  // ── GET /api/chat/pending-requests/:userUid ──────────────────────────────
  router.get("/pending-requests/:userUid", async (req, res) => {
    try {
      const { userUid } = req.params;
      const userRole = req.query.userRole;

      if (!userRole || !["student", "soultee"].includes(userRole)) {
        return res.status(400).json({
          message: "userRole must be 'student' or 'soultee'",
        });
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

      const roomIds = requests.map((r) => String(r._id));
      const firestoreMeta = await getConversationsMeta(roomIds);

      const enriched = requests.map((req) => {
        const roomId = String(req._id);
        const meta = firestoreMeta[roomId] || {};
        return {
          ...req,
          roomId,
          latestMessage: meta.lastMessage || null,
          unreadMessageCount: meta.unreadCounts?.[userUid] || 0,
        };
      });

      res.json({ requests: enriched, total: enriched.length });
    } catch (err) {
      console.error("[chat/pending-requests]", err.message);
      res.status(500).json({ message: err.message });
    }
  });

  // ── POST /api/chat/:roomId/missed-call ────────────────────────────────────
  // Records a missed call in MongoDB (for call history / admin dashboards) and
  // writes a system message to Firestore so it appears in the chat thread.
  // Called fire-and-forget from the Flutter client after call_cancelled / timeout.
  router.post("/:roomId/missed-call", async (req, res) => {
    try {
      const { roomId } = req.params;
      const { senderId, senderName, senderRole, callType = "audio" } = req.body;

      if (!senderId || !senderRole) {
        return res.status(400).json({ message: "senderId and senderRole required" });
      }

      const link = await getRoomLinkForParticipant({
        roomId,
        userId: senderId,
        userRole: senderRole,
        allowPending: true,
        allowEnded: true,
      });
      if (!link) return res.status(403).json({ message: "Room access denied" });

      const recipientUid =
        senderRole === "student"
          ? link.soulteeFirebaseUid
          : link.studentFirebaseUid;
      const recipientRole = senderRole === "student" ? "soultee" : "student";

      // Write system message to Firestore so Flutter chat thread shows it.
      await sendSystemMessage({
        roomId,
        senderId,
        senderName,
        senderRole,
        recipientUid,
        text: callType === "video" ? "Missed video call" : "Missed voice call",
        type: "missed_call",
        callType,
      });

      // Record CallEvent in MongoDB for admin dashboard / analytics.
      await CallEvent.create({
        roomId,
        callerId: senderId,
        callerRole: senderRole,
        recipientId: recipientUid,
        recipientRole,
        callType,
        status: "missed",
        startedAt: new Date(),
      }).catch(() => {}); // non-fatal

      // Send FCM push to recipient.
      createNotification(io, {
        recipientUid,
        recipientRole,
        type: "missed_call",
        title: callType === "video" ? "Missed Video Call" : "Missed Voice Call",
        body: `${senderName || "Someone"} tried to ${callType === "video" ? "video " : ""}call you`,
        data: { type: "missed_call", roomId, callType, senderId, senderRole },
      }).catch(() => {});

      res.json({ ok: true });
    } catch (err) {
      console.error("[chat/missed-call]", err.message);
      res.status(500).json({ message: err.message });
    }
  });

  // ── GET /api/chat/unread-summary/:userRole/:userUid ──────────────────────
  // Returns aggregate unread count from Firestore conversation docs.
  router.get("/unread-summary/:userRole/:userUid", async (req, res) => {
    try {
      const { userRole, userUid } = req.params;

      const query = { status: "active" };
      if (userRole === "student") {
        query.studentFirebaseUid = userUid;
      } else {
        query.soulteeFirebaseUid = userUid;
      }

      const links = await StudentSoulteeLink.find(query).select("_id").lean();
      const roomIds = links.map((l) => String(l._id));
      const meta = await getConversationsMeta(roomIds);

      let total = 0;
      const byRoom = {};
      for (const [roomId, data] of Object.entries(meta)) {
        const count = data.unreadCounts?.[userUid] || 0;
        byRoom[roomId] = count;
        total += count;
      }

      res.json({ totalUnreadMessages: total, byRoom });
    } catch (err) {
      console.error("[chat/unread-summary]", err.message);
      res.status(500).json({ message: err.message });
    }
  });

  return router;
}
