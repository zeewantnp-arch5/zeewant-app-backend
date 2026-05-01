import Message from "../models/Message.js";
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
} from "../services/callEventService.js";

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
  await Soultee.findOneAndUpdate({ firebaseUid: uid }, { status });
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

function setStudentStatus(io, uid, status) {
  io.emit("student_status_changed", {
    uid,
    status,
    lastSeenAt: status === "offline" ? new Date().toISOString() : null,
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
  if (!roomId || !userId || !userRole) {
    return null;
  }

  const link = await StudentSoulteeLink.findOne({
    _id: roomId,
    status: "active",
  })
    .select("studentFirebaseUid soulteeFirebaseUid status")
    .lean();

  if (!link) {
    return null;
  }

  if (userRole === "student" && link.studentFirebaseUid === userId) {
    return link;
  }

  if (userRole === "soultee" && link.soulteeFirebaseUid === userId) {
    return link;
  }

  return null;
}

function ensureJoinedRoom(socket, roomId) {
  return socket.data.joinedRooms?.has(roomId);
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
    });

    socket.on("send_message", async ({ roomId, senderId, senderName, senderRole, text, type = "text" }) => {
      if (!ensureJoinedRoom(socket, roomId)) {
        return emitSocketError(socket, "Join the room before sending messages", { roomId });
      }

      if (type === "text" && !String(text || "").trim()) {
        return emitSocketError(socket, "Message text is required", { roomId });
      }

      try {
        const { message } = await createPersistentMessage({
          roomId,
          senderId,
          senderName,
          senderRole: senderRole || socket.data.role,
          text,
          type,
        });

        io.to(roomId).emit("new_message", serializeMessage(message));
      } catch (err) {
        emitSocketError(socket, err.message, { roomId });
      }
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
        await markCallEnded(callEventId);
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

    // ── Jitsi Call Lifecycle ───────────────────────────────────────────────────
    // Emitted by caller when they tap the call button and peer is online.
    // Backend creates a CallEvent, checks actual online state, then routes
    // the call_incoming event to the receiver's personal room.
    socket.on("call_initiate", async ({ to, roomId, callerName, callerImage, isVideo, jitsiRoom }) => {
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
      const normalizedCallType = isVideo ? "video" : "audio";

      try {
        const callEvent = await createCallEvent({
          roomId,
          callerId,
          callerRole,
          callerName: callerName || socket.data.userName || callerId,
          receiverId: to,
          receiverRole,
          callType: normalizedCallType,
          status: isReceiverOnline ? "incoming" : "missed",
          jitsiRoom: jitsiRoom || null,
        });

        if (!isReceiverOnline) {
          // Race condition: caller's app showed peer as online but they went offline.
          // Emit call_unavailable so CallingScreen can handle it.
          return socket.emit("call_unavailable", {
            roomId,
            callType: normalizedCallType,
            reason: "receiver_offline",
            callEventId: String(callEvent._id),
          });
        }

        io.to(buildPersonalRoom(receiverRole, to)).emit("call_incoming", {
          roomId,
          callerId,
          callerName: callerName || socket.data.userName || callerId,
          callerImage: callerImage || null,
          callerRole,
          isVideo,
          jitsiRoom,
          callEventId: String(callEvent._id),
        });

        socket.emit("call_initiated", {
          callEventId: String(callEvent._id),
        });
      } catch (err) {
        emitSocketError(socket, err.message);
      }
    });

    // Emitted by the receiver when they tap Accept in the incoming call dialog.
    socket.on("call_accepted", async ({ to, jitsiRoom, callEventId }) => {
      const receiverRole = socket.data.role;
      const callerRole = receiverRole === "student" ? "soultee" : "student";

      try {
        if (callEventId) await markCallAccepted(callEventId);
      } catch (_) { /* non-fatal */ }

      if (to) {
        io.to(buildPersonalRoom(callerRole, to)).emit("call_accepted", {
          from: socket.data.userId,
          jitsiRoom,
          callEventId,
        });
      }
    });

    // Emitted by the receiver when they tap Decline.
    socket.on("call_rejected", async ({ to, jitsiRoom, callEventId }) => {
      const receiverRole = socket.data.role;
      const callerRole = receiverRole === "student" ? "soultee" : "student";

      try {
        if (callEventId) await markCallRejected(callEventId);
      } catch (_) { /* non-fatal */ }

      if (to) {
        io.to(buildPersonalRoom(callerRole, to)).emit("call_rejected", {
          from: socket.data.userId,
          jitsiRoom,
          callEventId,
        });
      }
    });

    // Emitted by the caller when they cancel from CallingScreen (or 30 s timeout).
    socket.on("call_cancelled", async ({ to, jitsiRoom, callEventId }) => {
      const callerRole = socket.data.role;
      const receiverRole = callerRole === "student" ? "soultee" : "student";

      try {
        if (callEventId) await markCallCancelled(callEventId);
      } catch (_) { /* non-fatal */ }

      if (to) {
        io.to(buildPersonalRoom(receiverRole, to)).emit("call_cancelled", {
          from: socket.data.userId,
          jitsiRoom,
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