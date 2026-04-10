import Message from "../models/Message.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";

function allowedStatuses(allowPending) {
  return allowPending ? ["pending", "active"] : ["active"];
}

export function serializeMessage(message) {
  return {
    _id: message._id,
    roomId: message.roomId,
    senderId: message.senderId,
    senderName: message.senderName,
    senderRole: message.senderRole,
    recipientUid: message.recipientUid,
    recipientRole: message.recipientRole,
    text: message.text,
    type: message.type,
    readAt: message.readAt,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

export async function getRoomLinkForParticipant({
  roomId,
  userId,
  userRole,
  allowPending = false,
}) {
  if (!roomId || !userId || !userRole) {
    return null;
  }

  const link = await StudentSoulteeLink.findOne({
    _id: roomId,
    status: { $in: allowedStatuses(allowPending) },
  }).lean();

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

export async function createPersistentMessage({
  roomId,
  senderId,
  senderName,
  senderRole,
  text,
  type = "text",
  allowPending = false,
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

  const result = await Message.updateMany(
    {
      roomId,
      recipientUid: userId,
      recipientRole: userRole,
      readAt: null,
    },
    {
      $set: { readAt: new Date() },
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