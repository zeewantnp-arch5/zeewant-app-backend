import mongoose from "mongoose";
import Message from "../models/Message.js";
import Session from "../models/Session.js";
import Soultee from "../models/Soultee.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";
import admin from "../config/firebase.js";
import { buildPersonalRoom, createNotification } from "../services/notificationService.js";
import {
  createPersistentMessage,
  serializeMessage,
  markMessageDelivered,
  markMessageRead,
  getRoomLinkForParticipant,
  markRoomMessagesDelivered,
  markRoomMessagesRead,
  getRoomMessageMetadata,
  getUnreadMessageSummary,
} from "../services/messageService.js";
import {
  createCallEvent,
  markCallAccepted,
  markCallRejected,
  markCallEnded,
  markCallCancelled,
  listPendingMissedCallsForUser,
  markMissedCallsNotified,
  buildCallEventText,
  getCallEventById,
} from "../services/callEventService.js";
import { generateAgoraRtcToken, getAgoraAppId } from "../services/agoraRtcService.js";

function emitSocketError(socket, message, details = {}) {
  socket.emit("socket_error", { message, ...details });
}

function addSocket(registry, uid, socketId) {
  const existingSockets = registry.get(uid) || new Set();
  const wasOffline = existingSockets.size === 0;

  existingSockets.add(socketId);
  registry.set(uid, existingSockets);

  return wasOffline;
}

function removeSocket(registry, uid, socketId) {
  const existingSockets = registry.get(uid);
  if (!existingSockets) {
    return false;
  }

  existingSockets.delete(socketId);

  if (existingSockets.size === 0) {
    registry.delete(uid);
    return true;
  }

  registry.set(uid, existingSockets);
  return false;
}

function isUserOnline(registry, uid) {
  const sockets = registry.get(uid);
  return Boolean(sockets && sockets.size > 0);
}

async function logSystemCallMessage({
  io,
  roomId,
  actorId,
  actorName,
  actorRole,
  text,
}) {
  const { message } = await createPersistentMessage({
    roomId,
    senderId: actorId,
    senderName: actorName,
    senderRole: actorRole,
    text,
    type: "system",
    allowPending: true,
  });

  io.to(roomId).emit("new_message", serializeMessage(message));
}

async function flushMissedCallNotifications(io, userUid, userRole) {
  const pendingMissedCalls = await listPendingMissedCallsForUser({
    userId: userUid,
    userRole,
    limit: 50,
  });

  if (!pendingMissedCalls.length) {
    return;
  }

  for (const event of pendingMissedCalls) {
    const title = `Missed ${event.callType === "video" ? "video" : "audio"} call`;
    const body = `${event.callerName || "Someone"} tried to call you`;

    await createNotification(io, {
      recipientUid: userUid,
      recipientRole: userRole,
      type: "call_incoming",
      title,
      body,
      data: {
        roomId: String(event.roomId),
        callerId: String(event.callerId || ""),
        callerRole: String(event.callerRole || ""),
        callType: String(event.callType || "audio"),
        callEventId: String(event._id),
        missed: "true",
      },
    });
  }

  await markMissedCallsNotified(pendingMissedCalls.map((event) => event._id));
}

async function setSoulteeStatus(io, uid, status) {
  const update = { status };
  if (status === "offline") update.lastSeenAt = new Date();
  await Soultee.findOneAndUpdate({ firebaseUid: uid }, update);
  io.emit("soultee_status_changed", {
    uid,
    status,
    lastSeenAt: status === "offline" ? new Date().toISOString() : null,
  });
}

export async function resetRealtimePresenceState() {
  await Soultee.updateMany(
    { status: { $in: ["online", "busy"] } },
    { $set: { status: "offline" } }
  );
}

// In-memory last-seen for students (no MongoDB model for students)
const studentLastSeenMap = new Map(); // uid → ISO string

function setStudentStatus(io, uid, status) {
  let lastSeenAt = null;
  if (status === "offline") {
    lastSeenAt = new Date().toISOString();
    studentLastSeenMap.set(uid, lastSeenAt);
  }
  io.emit("student_status_changed", {
    uid,
    status,
    lastSeenAt,
  });
}

function resolveRole(socket, payloadRole, userId) {
  if (payloadRole) {
    return payloadRole;
  }

  if (socket.data.studentUid && socket.data.studentUid === userId) {
    return "student";
  }

  if (socket.data.soulteeUid && socket.data.soulteeUid === userId) {
    return "soultee";
  }

  return socket.data.role || null;
}

async function validateRoomAccess(roomId, userId, userRole) {
  if (!roomId || !userId || !userRole) return null;
  // Reuse the LRU-cached lookup from messageService (2-min TTL for active rooms).
  // Allows ended/pending rooms so users can re-read history after a session ends.
  return getRoomLinkForParticipant({
    roomId,
    userId,
    userRole,
    allowPending: true,
    allowEnded: true,
  });
}

function ensureJoinedRoom(socket, roomId) {
  return socket.data.joinedRooms?.has(roomId);
}

// ── Helper: push all unread messages to a user who just (re)connected ────────
// This covers messages that arrived while the socket was dead.
async function flushPendingMessages(io, userId, userRole) {
  // Find rooms this user is part of
  const field = userRole === "student" ? "studentFirebaseUid" : "soulteeFirebaseUid";
  const links = await StudentSoulteeLink.find({
    [field]: userId,
    status: { $in: ["active", "pending"] },
  }).select("_id").lean();

  if (!links.length) return;

  const roomIds = links.map((l) => String(l._id));
  const personalRoom = buildPersonalRoom(userRole, userId);

  // Fetch up to 50 recent undelivered/unread messages addressed to this user
  const undelivered = await Message.find({
    roomId: { $in: roomIds },
    recipientUid: userId,
    recipientRole: userRole,
    status: "sent",
  })
    .sort({ createdAt: 1 })
    .limit(50)
    .lean();

  if (!undelivered.length) return;

  // Re-push each message to the user's personal room so Flutter receives it
  for (const msg of undelivered) {
    io.to(personalRoom).emit("new_message", serializeMessage(msg));
  }

  console.log(`[flush] pushed ${undelivered.length} pending messages to ${userRole}:${userId}`);
}

// ── Helper: push session_updated to both participants.
// When savedMsg is provided (the just-saved message), it is used directly as
// latestMessage, eliminating 1 aggregate query.  Unread counts use parallel
// countDocuments instead of 2 full aggregates — ~3x faster on large collections.
async function pushSessionUpdate(io, roomId, studentUid, soulteeUid, savedMsg = null) {
  try {
    let latestMessage = null;
    if (savedMsg) {
      // Build a lightweight preview from the message we already have in memory
      latestMessage = {
        _id: savedMsg._id,
        text: savedMsg.text,
        type: savedMsg.type,
        senderId: savedMsg.senderId,
        senderName: savedMsg.senderName,
        senderRole: savedMsg.senderRole,
        createdAt: savedMsg.createdAt,
        readAt: null,
      };
    } else {
      // Fallback: fetch from DB (e.g. after a delete operation)
      const metaMap = await getRoomMessageMetadata({
        roomIds: [String(roomId)],
        recipientUid: null,
        recipientRole: null,
      });
      latestMessage = (metaMap.get(String(roomId)) || {}).latestMessage || null;
    }

    // countDocuments is significantly faster than a group-aggregate for unread counts
    const [studentUnread, soulteeUnread] = await Promise.all([
      Message.countDocuments({
        roomId: String(roomId),
        recipientUid: studentUid,
        recipientRole: "student",
        readAt: null,
        deletedForUsers: { $nin: [studentUid] },
      }),
      Message.countDocuments({
        roomId: String(roomId),
        recipientUid: soulteeUid,
        recipientRole: "soultee",
        readAt: null,
        deletedForUsers: { $nin: [soulteeUid] },
      }),
    ]);

    const payload = { roomId: String(roomId), latestMessage };
    io.to(buildPersonalRoom("student", studentUid)).emit("session_updated", { ...payload, unreadCount: studentUnread });
    io.to(buildPersonalRoom("soultee", soulteeUid)).emit("session_updated",  { ...payload, unreadCount: soulteeUnread });
  } catch (err) {
    console.error("[session_updated] push failed:", err.message);
  }
}

export function registerRealtimeServer(io) {
  const soulteeSocketsByUid = new Map();
  const studentSocketsByUid = new Map();

  io.on("connection", (socket) => {
    socket.data.joinedRooms = new Set();

    socket.on("student_go_online", ({ uid, name }) => {
      if (!uid) {
        return emitSocketError(socket, "uid is required for student presence");
      }

      const becameOnline = addSocket(studentSocketsByUid, uid, socket.id);
      socket.data.studentUid = uid;
      socket.data.userId = uid;
      socket.data.role = "student";
      socket.data.userName = name || uid;
      socket.join(buildPersonalRoom("student", uid));
      console.log(`🎓 Student online: ${name || uid} (${uid})`);

      if (becameOnline) {
        setStudentStatus(io, uid, "online");
        flushMissedCallNotifications(io, uid, "student").catch((err) => {
          console.error("Missed-call notification flush error:", err.message);
        });
      }

      // On every (re)connect: push any messages sent while this socket was offline
      flushPendingMessages(io, uid, "student").catch((err) => {
        console.error("[student_go_online] pending-message flush error:", err.message);
      });
    });

    socket.on("soultee_go_online", async ({ uid, name }) => {
      if (!uid) {
        return emitSocketError(socket, "uid is required for soultee presence");
      }

       const soultee = await Soultee.findOne({ firebaseUid: uid }).select("firebaseUid").lean();
       if (!soultee) {
         return emitSocketError(socket, "Soultee profile is not approved yet");
       }

       if (admin.apps.length) {
         const userSnap = await admin.firestore().collection("users").doc(uid).get();
         const userData = userSnap.data() || {};
         const isApproved = (userData.soulteeStatus || "").toString().toLowerCase() === "active" &&
           userData.rolePending !== true;
         if (!isApproved) {
           return emitSocketError(socket, "Admin approval is required before going online");
         }
       }

      const becameOnline = addSocket(soulteeSocketsByUid, uid, socket.id);
      socket.data.soulteeUid = uid;
      socket.data.userId = uid;
      socket.data.role = "soultee";
      socket.data.userName = name || uid;
      socket.join(buildPersonalRoom("soultee", uid));
      console.log(`🟢 Soultee online: ${name || uid} (${uid})`);

      if (becameOnline) {
        try {
          await setSoulteeStatus(io, uid, "online");
          await flushMissedCallNotifications(io, uid, "soultee");
        } catch (err) {
          console.error("Presence update error:", err.message);
        }
      }

      // On every (re)connect: push any messages sent while this socket was offline
      flushPendingMessages(io, uid, "soultee").catch((err) => {
        console.error("[soultee_go_online] pending-message flush error:", err.message);
      });
    });

    socket.on("soultee_set_busy", async ({ uid }) => {
      if (!uid) {
        return emitSocketError(socket, "uid is required to set soultee busy");
      }

      try {
        await setSoulteeStatus(io, uid, "busy");
      } catch (err) {
        console.error("Presence update error:", err.message);
      }
    });

    socket.on("soultee_go_offline", async ({ uid }) => {
      if (!uid) {
        return emitSocketError(socket, "uid is required to set soultee offline");
      }

      const wentOffline = removeSocket(soulteeSocketsByUid, uid, socket.id);
      if (!wentOffline) {
        return;
      }

      try {
        await setSoulteeStatus(io, uid, "offline");
      } catch (err) {
        console.error("Presence update error:", err.message);
      }
    });

    socket.on("student_go_offline", ({ uid }) => {
      if (!uid) {
        return emitSocketError(socket, "uid is required to set student offline");
      }

      const wentOffline = removeSocket(studentSocketsByUid, uid, socket.id);
      if (wentOffline) {
        setStudentStatus(io, uid, "offline");
      }
    });

    socket.on("join_room", async ({ roomId, userId, userName, userRole }) => {
      const resolvedRole = resolveRole(socket, userRole, userId);
      const link = await validateRoomAccess(roomId, userId, resolvedRole);

      if (!link) {
        return emitSocketError(socket, "Room access denied", { roomId });
      }

      socket.join(roomId);
      socket.data.userId = userId;
      socket.data.userName = userName;
      socket.data.role = resolvedRole;
      socket.data.joinedRooms.add(roomId);

      socket.emit("room_joined", { roomId, role: resolvedRole });
      console.log(`👥 ${userName || userId} joined room ${roomId}`);

      // Push peer's CURRENT status to the joining user so the AppBar shows the
      // correct Online / Last seen label even if the peer was already online when
      // the chat screen opened (no status-change event would fire in that case).
      try {
        const peerRole = resolvedRole === "student" ? "soultee" : "student";
        const peerUid  = resolvedRole === "student"
          ? link.soulteeFirebaseUid
          : link.studentFirebaseUid;

        let peerStatus    = "offline";
        let peerLastSeen  = null;

        if (peerRole === "soultee") {
          const soulteeDoc = await Soultee.findOne({ firebaseUid: peerUid })
            .select("status lastSeenAt")
            .lean();
          if (soulteeDoc) {
            peerStatus   = soulteeDoc.status || "offline";
            peerLastSeen = soulteeDoc.lastSeenAt
              ? soulteeDoc.lastSeenAt.toISOString()
              : null;
          }
        } else {
          peerStatus   = isUserOnline(studentSocketsByUid, peerUid) ? "online" : "offline";
          peerLastSeen = studentLastSeenMap.get(peerUid) || null;
        }

        const statusEvent = peerRole === "soultee"
          ? "soultee_status_changed"
          : "student_status_changed";
        socket.emit(statusEvent, {
          uid:        peerUid,
          status:     peerStatus,
          lastSeenAt: peerStatus === "offline" ? peerLastSeen : null,
        });
      } catch (err) {
        console.error("[join_room] peer-status lookup failed:", err.message);
      }

      // Auto-deliver all queued "sent" messages for this user when they open the chat
      try {
        const deliveredCount = await markRoomMessagesDelivered({
          roomId,
          recipientUid: userId,
          recipientRole: resolvedRole,
        });
        if (deliveredCount > 0) {
          // Notify the sender their messages were delivered
          io.to(roomId).emit("messages_bulk_delivered", {
            roomId,
            recipientUid: userId,
            count: deliveredCount,
          });
        }
      } catch (err) {
        console.error("[join_room] auto-deliver failed:", err.message);
      }
    });

    socket.on("send_message", async ({
      roomId, senderId, senderName, senderRole, text, type = "text",
      replyToMessageId = null, replyToText = null, replyToSenderName = null,
    }) => {
      if (!ensureJoinedRoom(socket, roomId)) {
        return emitSocketError(socket, "Join the room before sending messages", { roomId });
      }
      if (type === "text" && !String(text || "").trim()) {
        return emitSocketError(socket, "Message text is required", { roomId });
      }

      const resolvedRole = senderRole || socket.data.role;

      // Validate room access — uses LRU cache after first lookup (~1 ms on repeat)
      const link = await getRoomLinkForParticipant({
        roomId, userId: senderId, userRole: resolvedRole,
      });
      if (!link) return emitSocketError(socket, "Room access denied", { roomId });

      const recipientUid = resolvedRole === "student" ? link.soulteeFirebaseUid : link.studentFirebaseUid;
      const recipientRole = resolvedRole === "student" ? "soultee" : "student";
      const now = new Date();
      const msgId = new mongoose.Types.ObjectId();

      // Broadcast IMMEDIATELY — both sides see the message before DB write completes.
      // The _id is pre-generated so Flutter can deduplicate on the echo.
      const payload = {
        _id: msgId,
        roomId, senderId, senderName,
        senderRole: resolvedRole,
        recipientUid, recipientRole,
        text: text || "",
        type,
        callType: null,
        attachmentUrl: null, attachmentName: null,
        attachmentMimeType: null, attachmentSize: null,
        replyToMessageId: replyToMessageId || null,
        replyToText: replyToText || null,
        replyToSenderName: replyToSenderName || null,
        status: "sent",
        deliveredAt: null, readAt: null,
        createdAt: now, updatedAt: now,
        isDeleted: false, deletedForEveryone: false,
        deletedBy: null, deletedAt: null,
        reactions: {},
      };
      io.to(roomId).emit("new_message", payload);
      io.to(buildPersonalRoom(recipientRole, recipientUid)).emit("new_message", payload);
      io.to(buildPersonalRoom(resolvedRole, senderId)).emit("new_message", payload);
      io.to(buildPersonalRoom(recipientRole, recipientUid)).emit("message_unread", { roomId, message: payload });

      // Persist to DB and fire FCM in the background — does not block the emit
      Message.create({
        _id: msgId,
        roomId, senderId,
        senderName: senderName || "",
        senderRole: resolvedRole,
        recipientUid, recipientRole,
        text: text || "",
        type,
        replyToMessageId: replyToMessageId || null,
        replyToText: replyToText || null,
        replyToSenderName: replyToSenderName || null,
      }).then((savedMsg) => {
        // Pass savedMsg so pushSessionUpdate skips the latestMessage DB query
        pushSessionUpdate(io, roomId, link.studentFirebaseUid, link.soulteeFirebaseUid, savedMsg);
        createNotification(io, {
          recipientUid, recipientRole,
          type: "new_message",
          title: "New Message",
          body: senderName
            ? `${senderName}: ${String(text || "").substring(0, 80)}`
            : String(text || "").substring(0, 80),
          data: { roomId, messageId: String(savedMsg._id), senderId, type: "new_message" },
        }).catch(() => {});
      }).catch((err) => {
        console.error("[send_message] DB save failed:", err.message);
        // Notify the sender so their bubble can show a failure indicator
        socket.emit("socket_error", { message: "Message could not be saved. Please retry.", roomId });
      });
    });

    socket.on("typing", ({ roomId, senderId }) => {
      if (!ensureJoinedRoom(socket, roomId)) {
        return emitSocketError(socket, "Join the room before sending typing events", { roomId });
      }

      socket.to(roomId).emit("user_typing", senderId);
    });

    socket.on("stop_typing", ({ roomId, senderId }) => {
      if (!ensureJoinedRoom(socket, roomId)) {
        return emitSocketError(socket, "Join the room before sending typing events", { roomId });
      }

      socket.to(roomId).emit("user_stop_typing", senderId);
    });

    // ── Voice-recording indicator (relayed; not persisted) ────────────────────
    socket.on("voice_recording_start", ({ roomId, userId }) => {
      if (!roomId) return;
      socket.to(roomId).emit("voice_recording_start", { userId: userId || socket.data.userId });
    });

    socket.on("voice_recording_stop", ({ roomId, userId }) => {
      if (!roomId) return;
      socket.to(roomId).emit("voice_recording_stop", { userId: userId || socket.data.userId });
    });

    // ── Message emoji reactions (persisted) ───────────────────────────────────
    // Client emits: { roomId, messageId, userId, emoji }
    // Toggle: first reaction adds it, second reaction with same emoji removes it.
    // Server emits back: { messageId, reactions: { emoji: [userId, …] } }
    socket.on("message_react", async ({ roomId, messageId, userId, emoji }) => {
      if (!ensureJoinedRoom(socket, roomId)) {
        return emitSocketError(socket, "Join the room before reacting", { roomId });
      }
      if (!messageId || !emoji) {
        return emitSocketError(socket, "messageId and emoji are required", { roomId });
      }
      const resolvedUid = userId || socket.data.userId;
      if (!resolvedUid) return;

      try {
        const msg = await Message.findById(messageId).select("roomId reactions");
        if (!msg || String(msg.roomId) !== String(roomId)) {
          return emitSocketError(socket, "Message not found", { roomId, messageId });
        }

        // Toggle: if same user + same emoji already exists → remove, else add
        const existingIdx = msg.reactions.findIndex(
          (r) => r.userId === resolvedUid && r.emoji === emoji
        );
        if (existingIdx >= 0) {
          msg.reactions.splice(existingIdx, 1);
        } else {
          msg.reactions.push({ userId: resolvedUid, emoji, reactedAt: new Date() });
        }
        await msg.save();

        // Flatten to { emoji: [userId, …] } for Flutter
        const reactionMap = {};
        for (const r of msg.reactions) {
          if (!reactionMap[r.emoji]) reactionMap[r.emoji] = [];
          reactionMap[r.emoji].push(r.userId);
        }

        io.to(roomId).emit("message_reaction", { messageId, reactions: reactionMap });
      } catch (err) {
        emitSocketError(socket, err.message, { roomId });
      }
    });

    // ── In-call emoji reactions ────────────────────────────────────────────────
    // Broadcast a live emoji reaction to all other participants in the room.
    // No DB persistence — reactions are ephemeral and only visible during the call.
    socket.on("call_reaction", ({ roomId, senderId, senderName, reaction }) => {
      if (!roomId || !reaction) return;
      socket.to(roomId).emit("call_reaction", {
        senderId: senderId || socket.data.userId,
        senderName: senderName || socket.data.userName,
        reaction,
        timestamp: Date.now(),
      });
    });

    // ── Raise / lower hand ────────────────────────────────────────────────────
    // Broadcasts the hand-raise state to all other participants in the room.
    socket.on("raise_hand", ({ roomId, userId, userName, raised }) => {
      if (!roomId) return;
      socket.to(roomId).emit("raise_hand", {
        userId: userId || socket.data.userId,
        userName: userName || socket.data.userName,
        raised: raised === true,
      });
    });

    // Mark all messages in a room as read — replaces the HTTP PATCH round-trip.
    // Emits room_messages_read to the room (so sender sees tick update) and
    // session_updated to both personal rooms (so chat list badge resets).
    socket.on("mark_room_read", async ({ roomId, userId, userRole }) => {
      if (!ensureJoinedRoom(socket, roomId)) {
        return emitSocketError(socket, "Join the room before marking messages read", { roomId });
      }

      const resolvedUid = userId || socket.data.userId;
      const resolvedRole = userRole || socket.data.role;

      if (!resolvedUid || !resolvedRole) {
        return emitSocketError(socket, "userId and userRole are required for mark_room_read", { roomId });
      }

      try {
        const updatedCount = await markRoomMessagesRead({
          roomId,
          userId: resolvedUid,
          userRole: resolvedRole,
        });

        if (updatedCount > 0) {
          // Tell the sender their messages were read (double-tick)
          io.to(roomId).emit("room_messages_read", {
            roomId,
            readerUid: resolvedUid,
            readerRole: resolvedRole,
            count: updatedCount,
          });

          // Zero the unread badge on this user's session list
          const link = await StudentSoulteeLink.findById(roomId).lean();
          if (link) {
            pushSessionUpdate(io, roomId, link.studentFirebaseUid, link.soulteeFirebaseUid);
          }
        }

        // Emit updated total unread summary so app badge refreshes
        const summary = await getUnreadMessageSummary({ userId: resolvedUid, userRole: resolvedRole });
        socket.emit("unread_summary_updated", summary);
      } catch (err) {
        emitSocketError(socket, err.message, { roomId });
      }
    });

    // Fetch messages missed during a socket outage.
    // Flutter calls this on reconnect with the timestamp of the last message it
    // successfully received. The server responds with everything newer, so the
    // chat list fills in the gap without a full page reload.
    socket.on("sync_room_messages", async ({ roomId, since, userId, userRole }) => {
      const resolvedUid = userId || socket.data.userId;
      const resolvedRole = userRole || socket.data.role;

      if (!roomId || !resolvedUid || !resolvedRole) {
        return emitSocketError(socket, "roomId, userId, and userRole are required for sync_room_messages");
      }

      try {
        const sinceDate = since ? new Date(since) : new Date(Date.now() - 24 * 60 * 60 * 1000);

        const messages = await Message.find({
          roomId,
          createdAt: { $gt: sinceDate },
        })
          .sort({ createdAt: 1 })
          .limit(100)
          .lean();

        socket.emit("sync_room_messages_result", {
          roomId,
          messages: messages.map(serializeMessage),
          since: sinceDate.toISOString(),
        });

        // Auto-deliver any that were addressed to this user
        const toDeliver = messages.filter(
          (m) => m.recipientUid === resolvedUid && m.status === "sent"
        );
        if (toDeliver.length > 0) {
          await markRoomMessagesDelivered({
            roomId,
            recipientUid: resolvedUid,
            recipientRole: resolvedRole,
          });
          io.to(roomId).emit("messages_bulk_delivered", {
            roomId,
            recipientUid: resolvedUid,
            count: toDeliver.length,
          });
        }
      } catch (err) {
        emitSocketError(socket, err.message, { roomId });
      }
    });

    // ── Message Status Updates ──────────────────────────────────────────────────
    socket.on("message_delivered", async ({ roomId, messageId }) => {
      if (!ensureJoinedRoom(socket, roomId)) {
        return emitSocketError(socket, "Join the room before sending message status", { roomId });
      }

      try {
        const message = await markMessageDelivered(messageId);
        if (message) {
          io.to(roomId).emit("message_updated", {
            messageId: message._id,
            status: "delivered",
            deliveredAt: message.deliveredAt,
          });
        }
      } catch (err) {
        emitSocketError(socket, err.message, { roomId });
      }
    });

    socket.on("message_read", async ({ roomId, messageId }) => {
      if (!ensureJoinedRoom(socket, roomId)) {
        return emitSocketError(socket, "Join the room before sending message status", { roomId });
      }

      try {
        const message = await markMessageRead(messageId);
        if (message) {
          io.to(roomId).emit("message_updated", {
            messageId: message._id,
            status: "read",
            readAt: message.readAt,
          });
        }
      } catch (err) {
        emitSocketError(socket, err.message, { roomId });
      }
    });

    socket.on("call_offer", async ({ roomId, offer, callType, agoraChannel }) => {
      if (!ensureJoinedRoom(socket, roomId)) {
        return emitSocketError(socket, "Join the room before starting a call", { roomId });
      }

      try {
        const callerId = socket.data.userId;
        const callerRole = socket.data.role;
        const callerName = socket.data.userName || callerId || "Someone";

        const link = await getRoomLinkForParticipant({
          roomId,
          userId: callerId,
          userRole: callerRole,
          allowPending: true,
        });

        if (!link) {
          return emitSocketError(socket, "Room access denied", { roomId });
        }

        const recipientUid =
          callerRole === "student" ? link.soulteeFirebaseUid : link.studentFirebaseUid;
        const recipientRole = callerRole === "student" ? "soultee" : "student";
        const recipientRegistry =
          recipientRole === "student" ? studentSocketsByUid : soulteeSocketsByUid;

        const isRecipientOnline = isUserOnline(recipientRegistry, recipientUid);
        const normalizedCallType = callType === "video" ? "video" : "audio";

        const callEvent = await createCallEvent({
          roomId,
          callerId,
          callerRole,
          callerName,
          receiverId: recipientUid,
          receiverRole: recipientRole,
          callType: normalizedCallType,
          status: isRecipientOnline ? "incoming" : "missed",
          agoraChannel,
        });

        if (!isRecipientOnline) {
          await logSystemCallMessage({
            io,
            roomId,
            actorId: callerId,
            actorName: callerName,
            actorRole: callerRole,
            text: buildCallEventText({
              status: "missed",
              callType: normalizedCallType,
              actorName: callerName,
            }),
          });

          return socket.emit("call_unavailable", {
            roomId,
            callType: normalizedCallType,
            reason: "recipient_offline",
            callEventId: String(callEvent._id),
          });
        }

        io.to(buildPersonalRoom(recipientRole, recipientUid)).emit("call_offer", {
          roomId,
          offer,
          callType: normalizedCallType,
          agoraChannel,
          callerId,
          callerRole,
          callerName,
          callEventId: String(callEvent._id),
        });
      } catch (err) {
        emitSocketError(socket, err.message, { roomId });
      }
    });

    socket.on("call_answer", async ({ roomId, answer, agoraChannel, callEventId, callType = "audio" }) => {
      if (!ensureJoinedRoom(socket, roomId)) {
        return emitSocketError(socket, "Join the room before answering a call", { roomId });
      }

      try {
        const normalizedAnswer = String(answer || "").toLowerCase();

        if (normalizedAnswer === "accepted") {
          await markCallAccepted(callEventId);
          await logSystemCallMessage({
            io,
            roomId,
            actorId: socket.data.userId,
            actorName: socket.data.userName || socket.data.userId,
            actorRole: socket.data.role,
            text: buildCallEventText({
              status: "accepted",
              callType,
              actorName: socket.data.userName,
            }),
          });
        }
      } catch (err) {
        emitSocketError(socket, err.message, { roomId });
      }

      socket.to(roomId).emit("call_answer", {
        answer,
        responderId: socket.data.userId,
        agoraChannel,
        callEventId,
      });
    });

    socket.on("ice_candidate", ({ roomId, candidate }) => {
      if (!ensureJoinedRoom(socket, roomId)) {
        return emitSocketError(socket, "Join the room before sharing ICE candidates", { roomId });
      }

      socket.to(roomId).emit("ice_candidate", { candidate });
    });

    socket.on("end_call", async ({ roomId, callEventId, callType = "audio" }) => {
      if (!ensureJoinedRoom(socket, roomId)) {
        return emitSocketError(socket, "Join the room before ending a call", { roomId });
      }

      try {
        const callEvent = await markCallEnded(callEventId);
        await logSystemCallMessage({
          io,
          roomId,
          actorId: socket.data.userId,
          actorName: socket.data.userName || socket.data.userId,
          actorRole: socket.data.role,
          text: buildCallEventText({
            status: "ended",
            callType,
            actorName: socket.data.userName,
          }),
        });

        // Complete session record when call ends
        if (callEvent && callEvent.answeredAt) {
          const soulteeId = callEvent.callerRole === "soultee"
            ? callEvent.callerId
            : callEvent.receiverId;
          const studentId = callEvent.callerRole === "student"
            ? callEvent.callerId
            : callEvent.receiverId;
          const sessionType = callEvent.callType === "video" ? "video" : "voice";
          const durationMinutes = Math.max(1, Math.round((callEvent.durationSec || 0) / 60));

          StudentSoulteeLink.findById(roomId).lean()
            .then(async (link) => {
              const studentName = link?.studentName
                || (callEvent.callerRole === "student" ? callEvent.callerName : null)
                || "Student";

              // Reuse existing payment session if one exists so earningsToBeReceived → 0
              const updated = await Session.findOneAndUpdate(
                {
                  soulteeFirebaseUid: soulteeId,
                  studentFirebaseUid: studentId,
                  status: { $in: ["upcoming", "ongoing"] },
                  sessionFee: { $gt: 0 },
                },
                { $set: { status: "completed", sessionType, durationMinutes, scheduledAt: callEvent.answeredAt } },
                { new: true, sort: { createdAt: -1 } }
              );

              if (!updated) {
                // No payment session — create new record with soultee's current fee
                const slt = await Soultee.findOne({ firebaseUid: soulteeId }).select("feePerSession").lean();
                await Session.create({
                  soulteeFirebaseUid: soulteeId,
                  studentFirebaseUid: studentId,
                  studentName,
                  scheduledAt: callEvent.answeredAt,
                  durationMinutes,
                  sessionType,
                  sessionFee: slt?.feePerSession || 0,
                  status: "completed",
                });
              }

              io.to(`soultee:${soulteeId}`).emit("stats:updated");
            })
            .catch(() => {});
        }
      } catch (err) {
        emitSocketError(socket, err.message, { roomId });
      }

      io.to(roomId).emit("call_ended", { endedBy: socket.data.userId });
    });

    socket.on("reject_call", async ({ roomId, callEventId, callType = "audio" }) => {
      if (!ensureJoinedRoom(socket, roomId)) {
        return emitSocketError(socket, "Join the room before rejecting a call", { roomId });
      }

      try {
        await markCallRejected(callEventId);
        await logSystemCallMessage({
          io,
          roomId,
          actorId: socket.data.userId,
          actorName: socket.data.userName || socket.data.userId,
          actorRole: socket.data.role,
          text: buildCallEventText({
            status: "rejected",
            callType,
            actorName: socket.data.userName,
          }),
        });
      } catch (err) {
        emitSocketError(socket, err.message, { roomId });
      }

      socket.to(roomId).emit("call_rejected", { rejectedBy: socket.data.userId });
    });

    // ── Agora Call Lifecycle (voice + video) ─────────────────────────────────
    // Emitted by caller when they tap the call button and the peer is online.
    // Backend creates a CallEvent, checks actual online state, generates Agora RTC
    // tokens for both parties, then routes call_incoming to the receiver.
    socket.on("call_initiate", async ({ to, roomId, callerName, callerImage, isVideo = false, agoraChannel }) => {
      const callerId = socket.data.userId;
      const callerRole = socket.data.role;

      if (!callerId || !callerRole) {
        return emitSocketError(socket, "Not authenticated. Call student_go_online or soultee_go_online first.");
      }

      if (!to || !roomId) {
        return emitSocketError(socket, "to and roomId are required for call_initiate");
      }

      const receiverRole = callerRole === "student" ? "soultee" : "student";
      const receiverRegistry = receiverRole === "student" ? studentSocketsByUid : soulteeSocketsByUid;
      const isReceiverOnline = isUserOnline(receiverRegistry, to);
      const resolvedCallerName = callerName || socket.data.userName || callerId;
      const agoraAppId = getAgoraAppId();

      console.log(
        `📞 call_initiate: ${resolvedCallerName}(${callerId}) → ${to} ` +
        `channel=${agoraChannel} receiverOnline=${isReceiverOnline}`
      );

      try {
        const _t0 = Date.now();
        const callEvent = await createCallEvent({
          roomId,
          callerId,
          callerRole,
          callerName: resolvedCallerName,
          receiverId: to,
          receiverRole,
          callType: isVideo ? "video" : "audio",
          status: isReceiverOnline ? "incoming" : "missed",
          livekitRoom: agoraChannel || null,
        });
        console.log(`[CallPerf] call_initiate: callEvent created in ${Date.now() - _t0}ms`);

        const callEventId = String(callEvent._id);

        if (!isReceiverOnline) {
          // System message in the chat room so both parties see the missed call
          logSystemCallMessage({
            io,
            roomId,
            actorId: callerId,
            actorName: resolvedCallerName,
            actorRole: callerRole,
            text: buildCallEventText({
              status: "missed",
              callType: isVideo ? "video" : "audio",
              actorName: resolvedCallerName,
            }),
          }).catch((err) =>
            console.error(`[call] missed-call system message failed: ${err.message}`)
          );

          createNotification(io, {
            recipientUid: to,
            recipientRole: receiverRole,
            type: "call_incoming",
            title: isVideo ? "Missed video call" : "Missed voice call",
            body: `${resolvedCallerName} tried to call you`,
            data: {
              roomId: String(roomId),
              callerId: String(callerId),
              callerRole: String(callerRole),
              callerName: String(resolvedCallerName),
              callerImage: String(callerImage || ""),
              callType: isVideo ? "video" : "audio",
              isVideo: String(isVideo),
              agoraChannel: String(agoraChannel || ""),
              callEventId,
              missed: "true",
            },
          }).catch((err) =>
            console.error(`[call] FCM missed-call notification failed: ${err.message}`)
          );

          console.log(`📵 call_unavailable: receiver ${to} is offline — missed-call system message + FCM sent`);

          return socket.emit("call_unavailable", {
            roomId,
            callType: isVideo ? "video" : "audio",
            reason: "receiver_offline",
            callEventId,
          });
        }

        // Generate Agora RTC tokens for both parties (uid=0 → Agora auto-assigns).
        const _t1 = Date.now();
        const callerRtc   = generateAgoraRtcToken(agoraChannel, 0, 3600);
        const receiverRtc = generateAgoraRtcToken(agoraChannel, 0, 3600);
        console.log(`[CallPerf] call_initiate: tokens generated in ${Date.now() - _t1}ms`);

        if (!callerRtc || !receiverRtc) {
          console.error("[call_initiate] Agora RTC token generation failed — check AGORA_APP_ID/AGORA_APP_CERTIFICATE env vars");
          return emitSocketError(socket, "Call server not configured. Contact support.", { roomId });
        }

        const personalRoom = buildPersonalRoom(receiverRole, to);
        io.to(personalRoom).emit("call_incoming", {
          roomId,
          callerId,
          callerName: resolvedCallerName,
          callerImage: callerImage || null,
          callerRole,
          isVideo,
          agoraChannel,
          agoraToken: receiverRtc.token,
          agoraAppId,
          callEventId,
        });

        console.log(`📲 call_incoming sent to room="${personalRoom}" callEventId=${callEvent._id}`);

        socket.emit("call_initiated", {
          callEventId,
          agoraChannel,
          agoraToken: callerRtc.token,
          agoraAppId,
        });
        console.log(`[CallPerf] call_initiate: total flow ${Date.now() - _t0}ms`);
      } catch (err) {
        console.error(`[call_initiate] error: ${err.message}`);
        emitSocketError(socket, err.message);
      }
    });

    // Emitted by the receiver when they tap Accept in the incoming call dialog.
    socket.on("call_accepted", async ({ to, agoraChannel, callEventId }) => {
      const receiverRole = socket.data.role;
      const callerRole = receiverRole === "student" ? "soultee" : "student";
      const receiverId = socket.data.userId;
      console.log(`✅ call_accepted: receiver=${receiverId} → caller=${to} channel=${agoraChannel}`);

      try {
        if (callEventId) await markCallAccepted(callEventId);
      } catch (_) { /* non-fatal */ }

      if (to) {
        const targetRoom = buildPersonalRoom(callerRole, to);
        io.to(targetRoom).emit("call_accepted", {
          from: receiverId,
          agoraChannel,
          callEventId,
        });
        console.log(`📤 call_accepted relayed to room="${targetRoom}"`);
      }

      // Notify both parties the call is now live
      io.to(buildPersonalRoom(callerRole, to)).emit("call_state_changed", {
        state: "in_progress",
        callEventId,
        agoraChannel,
      });
      socket.emit("call_state_changed", {
        state: "in_progress",
        callEventId,
        agoraChannel,
      });
    });

    // Emitted by the receiver when they tap Decline.
    socket.on("call_rejected", async ({ to, agoraChannel, callEventId }) => {
      const receiverRole = socket.data.role;
      const callerRole = receiverRole === "student" ? "soultee" : "student";
      console.log(`❌ call_rejected: receiver=${socket.data.userId} → caller=${to} callEventId=${callEventId}`);

      // Fetch callEvent before updating to get roomId and callType for system message.
      let callEventDoc = null;
      try {
        if (callEventId) {
          callEventDoc = await getCallEventById(callEventId);
          await markCallRejected(callEventId);
        }
      } catch (_) { /* non-fatal */ }

      // Create a "call declined" system message in the chat.
      if (callEventDoc?.roomId) {
        logSystemCallMessage({
          io,
          roomId: callEventDoc.roomId,
          actorId: socket.data.userId,
          actorName: socket.data.userName || socket.data.userId || "User",
          actorRole: socket.data.role,
          text: buildCallEventText({
            status: "rejected",
            callType: callEventDoc.callType || "audio",
            actorName: socket.data.userName || socket.data.userId,
          }),
        }).catch((err) =>
          console.error(`[call] rejected system message failed: ${err.message}`)
        );
      }

      if (to) {
        io.to(buildPersonalRoom(callerRole, to)).emit("call_rejected", {
          from: socket.data.userId,
          agoraChannel,
          callEventId,
        });
        io.to(buildPersonalRoom(callerRole, to)).emit("call_state_changed", {
          state: "rejected",
          callEventId,
        });
      }
    });

    // Emitted by the caller when they cancel from CallingScreen (or 30 s timeout).
    socket.on("call_cancelled", async ({ to, agoraChannel, callEventId }) => {
      const callerRole = socket.data.role;
      const receiverRole = callerRole === "student" ? "soultee" : "student";
      const callerName = socket.data.userName || socket.data.userId || "Caller";
      console.log(`🚫 call_cancelled: caller=${socket.data.userId}(${callerName}) → receiver=${to} callEventId=${callEventId}`);

      // Fetch callEvent before updating — we need roomId and callType for the system message.
      let callEventDoc = null;
      try {
        if (callEventId) {
          callEventDoc = await getCallEventById(callEventId);
          await markCallCancelled(callEventId);
        }
      } catch (_) { /* non-fatal */ }

      // Create a "Missed call" system message in the chat (receiver was online but didn't answer).
      if (callEventDoc?.roomId) {
        logSystemCallMessage({
          io,
          roomId: callEventDoc.roomId,
          actorId: callEventDoc.callerId || socket.data.userId,
          actorName: callEventDoc.callerName || callerName,
          actorRole: callEventDoc.callerRole || callerRole,
          text: buildCallEventText({
            status: "missed",
            callType: callEventDoc.callType || "audio",
            actorName: callEventDoc.callerName || callerName,
          }),
        }).catch((err) =>
          console.error(`[call] cancelled system message failed: ${err.message}`)
        );
      }

      if (to) {
        io.to(buildPersonalRoom(receiverRole, to)).emit("call_cancelled", {
          from: socket.data.userId,
          agoraChannel,
        });
        io.to(buildPersonalRoom(receiverRole, to)).emit("call_state_changed", {
          state: "cancelled",
          callEventId,
        });
      }
    });

    // ── Question thread room — both student & soultee join to get live comments
    socket.on("join_question", ({ questionId }) => {
      if (!questionId) return;
      socket.join(`question:${questionId}`);
    });

    socket.on("leave_question", ({ questionId }) => {
      if (!questionId) return;
      socket.leave(`question:${questionId}`);
    });

    // ── Request Lifecycle Events ────────────────────────────────────────────────
    socket.on("request_declined", async ({ linkId, soulteeUid, studentUid }) => {
      try {
        const link = await StudentSoulteeLink.findByIdAndUpdate(
          linkId,
          { status: "declined" },
          { new: true }
        );

        if (link) {
          // Notify both users in real-time
          io.to(`student:${studentUid}`).emit("connection_declined", {
            linkId: link._id,
            soulteeUid,
          });

          io.to(`soultee:${soulteeUid}`).emit("request_removed", {
            linkId: link._id,
            studentUid,
          });
        }
      } catch (err) {
        emitSocketError(socket, err.message);
      }
    });

    socket.on("disconnect", async () => {
      const soulteeUid = socket.data.soulteeUid;
      if (soulteeUid && removeSocket(soulteeSocketsByUid, soulteeUid, socket.id)) {
        try {
          await setSoulteeStatus(io, soulteeUid, "offline");
        } catch (err) {
          console.error("Presence update error:", err.message);
        }
      }

      const studentUid = socket.data.studentUid;
      if (studentUid && removeSocket(studentSocketsByUid, studentUid, socket.id)) {
        setStudentStatus(io, studentUid, "offline");
      }

      console.log(`❌ Socket disconnected: ${socket.id}`);
    });
  });
}