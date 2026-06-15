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
} from "../services/callEventService.js";
import { generateJitsiToken, buildJitsiServerUrl } from "../services/jitsiService.js";

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

  // Allow both "active" and "pending" links — consistent with the HTTP chat
  // routes that use allowPending: true.
  const link = await StudentSoulteeLink.findOne({
    _id: roomId,
    status: { $in: ["active", "pending"] },
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

// ── Helper: fetch latest-message + unread count for a room, then push
//           a session_updated event to both participants ─────────────────────
async function pushSessionUpdate(io, roomId, studentUid, soulteeUid) {
  try {
    const metaMap = await getRoomMessageMetadata({
      roomIds: [String(roomId)],
      recipientUid: null, // fetch for both sides below
      recipientRole: null,
    });
    const base = metaMap.get(String(roomId)) || {};

    // Unread counts per participant
    const [studentMeta, soulteeeMeta] = await Promise.all([
      getRoomMessageMetadata({
        roomIds: [String(roomId)],
        recipientUid: studentUid,
        recipientRole: "student",
      }),
      getRoomMessageMetadata({
        roomIds: [String(roomId)],
        recipientUid: soulteeUid,
        recipientRole: "soultee",
      }),
    ]);

    const payload = {
      roomId: String(roomId),
      latestMessage: base.latestMessage || null,
    };

    io.to(buildPersonalRoom("student", studentUid)).emit("session_updated", {
      ...payload,
      unreadCount: (studentMeta.get(String(roomId)) || {}).unreadCount || 0,
    });
    io.to(buildPersonalRoom("soultee", soulteeUid)).emit("session_updated", {
      ...payload,
      unreadCount: (soulteeeMeta.get(String(roomId)) || {}).unreadCount || 0,
    });
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

    socket.on("send_message", async ({ roomId, senderId, senderName, senderRole, text, type = "text" }) => {
      if (!ensureJoinedRoom(socket, roomId)) {
        return emitSocketError(socket, "Join the room before sending messages", { roomId });
      }

      if (type === "text" && !String(text || "").trim()) {
        return emitSocketError(socket, "Message text is required", { roomId });
      }

      try {
        const resolvedRole = senderRole || socket.data.role;
        const { message, recipientUid, recipientRole, link } = await createPersistentMessage({
          roomId,
          senderId,
          senderName,
          senderRole: resolvedRole,
          text,
          type,
        });

        const payload = serializeMessage(message);

        // 1. Deliver to everyone currently in the chat room
        io.to(roomId).emit("new_message", payload);
        // 2. Deliver to recipient's personal room (catches them when not in chat screen)
        io.to(buildPersonalRoom(recipientRole, recipientUid)).emit("new_message", payload);
        // 3. Echo to sender's personal room (multi-device / race condition safety)
        io.to(buildPersonalRoom(resolvedRole, senderId)).emit("new_message", payload);
        // 4. Legacy unread badge event
        io.to(buildPersonalRoom(recipientRole, recipientUid)).emit("message_unread", {
          roomId,
          message: payload,
        });

        // 5. Push session list update so chat list refreshes with new preview + badge
        pushSessionUpdate(
          io,
          roomId,
          link.studentFirebaseUid,
          link.soulteeFirebaseUid
        );
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

    // ── Jitsi Call Lifecycle ───────────────────────────────────────────────────
    // Emitted by caller when they tap the call button and peer is online.
    // Backend creates a CallEvent, checks actual online state, generates Jitsi
    // JWT tokens for both parties (bypasses lobby), then routes call_incoming
    // to the receiver's personal room.
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
      const resolvedCallerName = callerName || socket.data.userName || callerId;
      const jitsiServerUrl = buildJitsiServerUrl();

      console.log(
        `📞 call_initiate: ${resolvedCallerName}(${callerId}) → ${to} ` +
        `type=${normalizedCallType} receiverOnline=${isReceiverOnline}`
      );

      try {
        const callEvent = await createCallEvent({
          roomId,
          callerId,
          callerRole,
          callerName: resolvedCallerName,
          receiverId: to,
          receiverRole,
          callType: normalizedCallType,
          status: isReceiverOnline ? "incoming" : "missed",
          jitsiRoom: jitsiRoom || null,
        });

        const callEventId = String(callEvent._id);

        if (!isReceiverOnline) {
          createNotification(io, {
            recipientUid: to,
            recipientRole: receiverRole,
            type: "call_incoming",
            title: `Missed ${normalizedCallType === "video" ? "video" : "voice"} call`,
            body: `${resolvedCallerName} tried to call you`,
            data: {
              roomId: String(roomId),
              callerId: String(callerId),
              callerRole: String(callerRole),
              callerName: String(resolvedCallerName),
              callerImage: String(callerImage || ""),
              callType: normalizedCallType,
              jitsiRoom: String(jitsiRoom || ""),
              callEventId,
              missed: "true",
            },
          }).catch((err) =>
            console.error(`[call] FCM missed-call notification failed: ${err.message}`)
          );

          console.log(`📵 call_unavailable: receiver ${to} is offline, missed-call FCM sent`);

          return socket.emit("call_unavailable", {
            roomId,
            callType: normalizedCallType,
            reason: "receiver_offline",
            callEventId,
          });
        }

        // Generate JWT tokens — moderator:true means both parties skip the lobby
        const callerToken = generateJitsiToken({
          userId: callerId,
          userName: resolvedCallerName,
          roomName: jitsiRoom,
          isModerator: true,
        });

        const receiverToken = generateJitsiToken({
          userId: to,
          userName: null, // receiver name unknown here; Flutter fills displayName separately
          roomName: jitsiRoom,
          isModerator: true,
        });

        const personalRoom = buildPersonalRoom(receiverRole, to);
        io.to(personalRoom).emit("call_incoming", {
          roomId,
          callerId,
          callerName: resolvedCallerName,
          callerImage: callerImage || null,
          callerRole,
          isVideo,
          jitsiRoom,
          jitsiServerUrl,
          jitsiToken: receiverToken,   // receiver uses this when joining
          callEventId,
        });

        console.log(`📲 call_incoming sent to room="${personalRoom}" callEventId=${callEvent._id}`);

        socket.emit("call_initiated", {
          callEventId,
          jitsiToken: callerToken,     // caller uses this when joining
          jitsiServerUrl,
        });
      } catch (err) {
        console.error(`[call_initiate] error: ${err.message}`);
        emitSocketError(socket, err.message);
      }
    });

    // Emitted by the receiver when they tap Accept in the incoming call dialog.
    socket.on("call_accepted", async ({ to, jitsiRoom, callEventId }) => {
      const receiverRole = socket.data.role;
      const callerRole = receiverRole === "student" ? "soultee" : "student";
      const receiverId = socket.data.userId;
      console.log(`✅ call_accepted: receiver=${receiverId} → caller=${to} room=${jitsiRoom}`);

      try {
        if (callEventId) await markCallAccepted(callEventId);
      } catch (_) { /* non-fatal */ }

      if (to) {
        const targetRoom = buildPersonalRoom(callerRole, to);
        io.to(targetRoom).emit("call_accepted", {
          from: receiverId,
          jitsiRoom,
          callEventId,
        });
        console.log(`📤 call_accepted relayed to room="${targetRoom}"`);
      }

      // Notify both parties the call is now live
      io.to(buildPersonalRoom(callerRole, to)).emit("call_state_changed", {
        state: "in_progress",
        callEventId,
        jitsiRoom,
      });
      socket.emit("call_state_changed", {
        state: "in_progress",
        callEventId,
        jitsiRoom,
      });
    });

    // Emitted by the receiver when they tap Decline.
    socket.on("call_rejected", async ({ to, jitsiRoom, callEventId }) => {
      const receiverRole = socket.data.role;
      const callerRole = receiverRole === "student" ? "soultee" : "student";
      console.log(`❌ call_rejected: receiver=${socket.data.userId} → caller=${to}`);

      try {
        if (callEventId) await markCallRejected(callEventId);
      } catch (_) { /* non-fatal */ }

      if (to) {
        io.to(buildPersonalRoom(callerRole, to)).emit("call_rejected", {
          from: socket.data.userId,
          jitsiRoom,
          callEventId,
        });
        io.to(buildPersonalRoom(callerRole, to)).emit("call_state_changed", {
          state: "rejected",
          callEventId,
        });
      }
    });

    // Emitted by the caller when they cancel from CallingScreen (or 30 s timeout).
    socket.on("call_cancelled", async ({ to, jitsiRoom, callEventId }) => {
      const callerRole = socket.data.role;
      const receiverRole = callerRole === "student" ? "soultee" : "student";
      console.log(`🚫 call_cancelled: caller=${socket.data.userId} → receiver=${to}`);

      try {
        if (callEventId) await markCallCancelled(callEventId);
      } catch (_) { /* non-fatal */ }

      if (to) {
        io.to(buildPersonalRoom(receiverRole, to)).emit("call_cancelled", {
          from: socket.data.userId,
          jitsiRoom,
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