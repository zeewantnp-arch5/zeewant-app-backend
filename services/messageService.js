import Message from "../models/Message.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";

// In-memory LRU-style cache for room link lookups.
// Avoids 1 extra MongoDB read per message for the same room.
const _roomCache = new Map();
const _ROOM_TTL = 120_000; // 2 minutes

function _getCached(roomId) {
  const e = _roomCache.get(roomId);
  if (!e) return null;
  if (Date.now() - e.ts > _ROOM_TTL) { _roomCache.delete(roomId); return null; }
  return e.link;
}
function _setCache(roomId, link) {
  _roomCache.set(roomId, { link, ts: Date.now() });
  if (_roomCache.size > 1000) _roomCache.delete(_roomCache.keys().next().value);
}
// Call this when a room's state changes (accept, end session) to prevent stale reads.
export function invalidateRoomCache(roomId) { _roomCache.delete(roomId); }

function allowedStatuses(allowPending, allowEnded) {
  const statuses = ["active"];
  if (allowPending) statuses.push("pending");
  if (allowEnded)  statuses.push("ended");
  return statuses;
}

export function serializeMessage(message) {
  const deletedForEveryone = message.deletedForEveryone === true;
  return {
    _id: message._id,
    roomId: message.roomId,
    senderId: message.senderId,
    senderName: message.senderName,
    senderRole: message.senderRole,
    recipientUid: message.recipientUid,
    recipientRole: message.recipientRole,
    text: deletedForEveryone ? "This message was deleted" : (message.text ?? ""),
    type: message.type,
    callType: message.callType || null,
    attachmentUrl: deletedForEveryone ? null : (message.attachmentUrl || null),
    attachmentName: deletedForEveryone ? null : (message.attachmentName || null),
    attachmentMimeType: deletedForEveryone ? null : (message.attachmentMimeType || null),
    attachmentSize: deletedForEveryone ? null : (message.attachmentSize || null),
    replyToMessageId: deletedForEveryone ? null : (message.replyToMessageId || null),
    replyToText: deletedForEveryone ? null : (message.replyToText || null),
    replyToSenderName: deletedForEveryone ? null : (message.replyToSenderName || null),
    status: message.status || "sent",
    deliveredAt: message.deliveredAt || null,
    readAt: message.readAt || null,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    isDeleted: message.isDeleted || false,
    deletedForEveryone,
    deletedBy: message.deletedBy || null,
    deletedAt: message.deletedAt || null,
    reactions: buildReactionMap(message.reactions),
  };
}

// Flatten reactions array [{userId,emoji}] → { emoji: [userId, …] }
function buildReactionMap(reactions) {
  if (!reactions || !reactions.length) return {};
  const map = {};
  for (const r of reactions) {
    if (!map[r.emoji]) map[r.emoji] = [];
    map[r.emoji].push(r.userId);
  }
  return map;
}

export async function getRoomLinkForParticipant({
  roomId,
  userId,
  userRole,
  allowPending = false,
  allowEnded = false,
}) {
  if (!roomId || !userId || !userRole) return null;

  // Only cache the standard active-only path (no pending/ended overrides)
  // so we don't accidentally serve stale state for edge-case lookups.
  const cacheable = !allowPending && !allowEnded;
  if (cacheable) {
    const cached = _getCached(roomId);
    if (cached) {
      if (userRole === "student" && cached.studentFirebaseUid === userId) return cached;
      if (userRole === "soultee" && cached.soulteeFirebaseUid === userId) return cached;
      return null; // cached but not a participant
    }
  }

  const link = await StudentSoulteeLink.findOne({
    _id: roomId,
    status: { $in: allowedStatuses(allowPending, allowEnded) },
  }).lean();

  if (!link) return null;
  if (cacheable) _setCache(roomId, link);

  if (userRole === "student" && link.studentFirebaseUid === userId) return link;
  if (userRole === "soultee" && link.soulteeFirebaseUid === userId) return link;
  return null;
}

export async function createPersistentMessage({
  roomId,
  senderId,
  senderName,
  senderRole,
  text,
  type = "text",
  callType = null,
  attachment = null,
  allowPending = false,
  replyToMessageId = null,
  replyToText = null,
  replyToSenderName = null,
}) {
  const link = await getRoomLinkForParticipant({
    roomId,
    userId: senderId,
    userRole: senderRole,
    allowPending,
  });

  if (!link) {
    throw new Error("Room access denied");
  }

  const recipientUid =
    senderRole === "student" ? link.soulteeFirebaseUid : link.studentFirebaseUid;
  const recipientRole = senderRole === "student" ? "soultee" : "student";

  const message = await Message.create({
    roomId,
    senderId,
    senderName: senderName || "",
    senderRole,
    recipientUid,
    recipientRole,
    text: text || "",
    type,
    callType: callType || null,
    attachmentUrl: attachment?.url || null,
    attachmentName: attachment?.name || null,
    attachmentMimeType: attachment?.mimeType || null,
    attachmentSize: attachment?.size || null,
    replyToMessageId: replyToMessageId || null,
    replyToText: replyToText || null,
    replyToSenderName: replyToSenderName || null,
  });

  return {
    link,
    message,
    recipientUid,
    recipientRole,
  };
}

export async function markRoomMessagesRead({ roomId, userId, userRole }) {
  if (!roomId || !userId || !userRole) {
    return 0;
  }

  const now = new Date();
  const result = await Message.updateMany(
    {
      roomId,
      recipientUid: userId,
      recipientRole: userRole,
      readAt: null,
    },
    {
      $set: { status: "read", readAt: now },
    }
  );

  return result.modifiedCount || 0;
}

export async function getUnreadMessageSummary({ userId, userRole }) {
  if (!userId || !userRole) {
    return { totalUnreadMessages: 0, byRoom: {} };
  }

  const unread = await Message.aggregate([
    {
      $match: {
        recipientUid: userId,
        recipientRole: userRole,
        readAt: null,
        deletedForUsers: { $nin: [userId] },
      },
    },
    {
      $group: {
        _id: "$roomId",
        unreadCount: { $sum: 1 },
      },
    },
  ]);

  const byRoom = Object.fromEntries(
    unread.map((entry) => [String(entry._id), entry.unreadCount])
  );
  const totalUnreadMessages = unread.reduce(
    (sum, entry) => sum + entry.unreadCount,
    0
  );

  return { totalUnreadMessages, byRoom };
}

export async function getRoomMessageMetadata({
  roomIds,
  recipientUid,
  recipientRole,
}) {
  if (!roomIds?.length) {
    return new Map();
  }

  const normalizedRoomIds = roomIds.map(String);

  const [latestMessages, unreadCounts] = await Promise.all([
    Message.aggregate([
      { $match: { roomId: { $in: normalizedRoomIds } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$roomId",
          latestMessage: {
            $first: {
              _id: "$_id",
              text: "$text",
              type: "$type",
              senderId: "$senderId",
              senderName: "$senderName",
              senderRole: "$senderRole",
              createdAt: "$createdAt",
              readAt: "$readAt",
            },
          },
        },
      },
    ]),
    recipientUid && recipientRole
      ? Message.aggregate([
          {
            $match: {
              roomId: { $in: normalizedRoomIds },
              recipientUid,
              recipientRole,
              readAt: null,
              deletedForUsers: { $nin: [recipientUid] },
            },
          },
          {
            $group: {
              _id: "$roomId",
              unreadCount: { $sum: 1 },
            },
          },
        ])
      : [],
  ]);

  const latestByRoom = new Map(
    latestMessages.map((entry) => [String(entry._id), entry.latestMessage])
  );
  const unreadByRoom = new Map(
    unreadCounts.map((entry) => [String(entry._id), entry.unreadCount])
  );

  return new Map(
    normalizedRoomIds.map((roomId) => [
      roomId,
      {
        latestMessage: latestByRoom.get(roomId) || null,
        unreadCount: unreadByRoom.get(roomId) || 0,
      },
    ])
  );
}

// ──── Message Status Tracking ─────────────────────────────────────────────────

export async function markMessageDelivered(messageId) {
  if (!messageId) return null;

  const message = await Message.findByIdAndUpdate(
    messageId,
    {
      status: "delivered",
      deliveredAt: new Date(),
    },
    { new: true }
  );

  return message;
}

export async function markMessageRead(messageId) {
  if (!messageId) return null;

  const message = await Message.findByIdAndUpdate(
    messageId,
    {
      status: "read",
      readAt: new Date(),
    },
    { new: true }
  );

  return message;
}

export async function getMessageStatus(messageId) {
  if (!messageId) return null;

  const message = await Message.findById(messageId).select(
    "_id status deliveredAt readAt createdAt"
  );

  return message;
}

export async function markRoomMessagesDelivered({ roomId, recipientUid, recipientRole }) {
  if (!roomId || !recipientUid || !recipientRole) {
    return 0;
  }

  const result = await Message.updateMany(
    {
      roomId,
      recipientUid,
      recipientRole,
      status: "sent",
    },
    {
      $set: {
        status: "delivered",
        deliveredAt: new Date(),
      },
    }
  );

  return result.modifiedCount || 0;
}

// ──── Message Deletion ────────────────────────────────────────────────────────

export async function deleteMessageForMe({ messageId, userId }) {
  if (!messageId || !userId) return null;
  return Message.findByIdAndUpdate(
    messageId,
    { $addToSet: { deletedForUsers: userId } },
    { new: true }
  );
}

export async function deleteMessageForEveryone({ messageId, userId }) {
  if (!messageId || !userId) return null;
  return Message.findOneAndUpdate(
    { _id: messageId, senderId: userId },
    {
      $set: {
        isDeleted: true,
        deletedForEveryone: true,
        deletedBy: userId,
        deletedAt: new Date(),
        text: "This message was deleted",
        attachmentUrl: null,
        attachmentName: null,
        attachmentMimeType: null,
        attachmentSize: null,
      },
    },
    { new: true }
  );
}

export async function bulkDeleteMessages({ messageIds, userId, deleteFor }) {
  if (!messageIds?.length || !userId) return { deletedCount: 0, affectedIds: [] };

  const now = new Date();
  let result;

  if (deleteFor === "everyone") {
    result = await Message.updateMany(
      { _id: { $in: messageIds }, senderId: userId },
      {
        $set: {
          isDeleted: true,
          deletedForEveryone: true,
          deletedBy: userId,
          deletedAt: now,
          text: "This message was deleted",
          attachmentUrl: null,
          attachmentName: null,
          attachmentMimeType: null,
          attachmentSize: null,
        },
      }
    );
    // Return only the IDs that were actually owned by this user and updated
    const updated = await Message.find(
      { _id: { $in: messageIds }, senderId: userId },
      "_id"
    ).lean();
    return { deletedCount: result.modifiedCount, affectedIds: updated.map(m => String(m._id)) };
  } else {
    result = await Message.updateMany(
      { _id: { $in: messageIds } },
      { $addToSet: { deletedForUsers: userId } }
    );
    return { deletedCount: result.modifiedCount, affectedIds: messageIds.map(String) };
  }
}