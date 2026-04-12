import Message from "../models/Message.js";
import Soultee from "../models/Soultee.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";
import { buildPersonalRoom } from "../services/notificationService.js";
import { createPersistentMessage, serializeMessage } from "../services/messageService.js";

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

async function setSoulteeStatus(io, uid, status) {
  await Soultee.findOneAndUpdate({ firebaseUid: uid }, { status });
  io.emit("soultee_status_changed", { uid, status });
}

export async function resetRealtimePresenceState() {
  await Soultee.updateMany(
    { status: { $in: ["online", "busy"] } },
    { $set: { status: "offline" } }
  );
}

function setStudentStatus(io, uid, status) {
  io.emit("student_status_changed", { uid, status });
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
      socket.join(buildPersonalRoom("student", uid));
      console.log(`🎓 Student online: ${name || uid} (${uid})`);

      if (becameOnline) {
        setStudentStatus(io, uid, "online");
      }
    });

    socket.on("soultee_go_online", async ({ uid, name }) => {
      if (!uid) {
        return emitSocketError(socket, "uid is required for soultee presence");
      }

      const becameOnline = addSocket(soulteeSocketsByUid, uid, socket.id);
      socket.data.soulteeUid = uid;
      socket.data.userId = uid;
      socket.data.role = "soultee";
      socket.join(buildPersonalRoom("soultee", uid));
      console.log(`🟢 Soultee online: ${name || uid} (${uid})`);

      if (becameOnline) {
        try {
          await setSoulteeStatus(io, uid, "online");
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

    socket.on("call_offer", ({ roomId, offer, callType }) => {
      if (!ensureJoinedRoom(socket, roomId)) {
        return emitSocketError(socket, "Join the room before starting a call", { roomId });
      }

      socket.to(roomId).emit("call_offer", {
        offer,
        callType,
        callerId: socket.data.userId,
        callerRole: socket.data.role,
      });
    });

    socket.on("call_answer", ({ roomId, answer }) => {
      if (!ensureJoinedRoom(socket, roomId)) {
        return emitSocketError(socket, "Join the room before answering a call", { roomId });
      }

      socket.to(roomId).emit("call_answer", { answer, responderId: socket.data.userId });
    });

    socket.on("ice_candidate", ({ roomId, candidate }) => {
      if (!ensureJoinedRoom(socket, roomId)) {
        return emitSocketError(socket, "Join the room before sharing ICE candidates", { roomId });
      }

      socket.to(roomId).emit("ice_candidate", { candidate });
    });

    socket.on("end_call", ({ roomId }) => {
      if (!ensureJoinedRoom(socket, roomId)) {
        return emitSocketError(socket, "Join the room before ending a call", { roomId });
      }

      io.to(roomId).emit("call_ended", { endedBy: socket.data.userId });
    });

    socket.on("reject_call", ({ roomId }) => {
      if (!ensureJoinedRoom(socket, roomId)) {
        return emitSocketError(socket, "Join the room before rejecting a call", { roomId });
      }

      socket.to(roomId).emit("call_rejected", { rejectedBy: socket.data.userId });
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