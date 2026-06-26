import CallEvent from "../models/CallEvent.js";

export async function createCallEvent({
  roomId,
  callerId,
  callerRole,
  callerName,
  receiverId,
  receiverRole,
  callType = "audio",
  status = "incoming",
  livekitRoom = null,
  agoraChannel = null,
}) {
  return CallEvent.create({
    roomId,
    callerId,
    callerRole,
    callerName: callerName || "",
    receiverId,
    receiverRole,
    callType: callType === "video" ? "video" : "audio",
    status,
    initiatedAt: new Date(),
    livekitRoom: livekitRoom || null,
    agoraChannel: agoraChannel || null,
  });
}

export async function markCallAccepted(callEventId) {
  if (!callEventId) return null;

  return CallEvent.findByIdAndUpdate(
    callEventId,
    {
      status: "accepted",
      answeredAt: new Date(),
    },
    { new: true }
  );
}

export async function markCallRejected(callEventId) {
  if (!callEventId) return null;

  return CallEvent.findByIdAndUpdate(
    callEventId,
    {
      status: "rejected",
      endedAt: new Date(),
      durationSec: 0,
    },
    { new: true }
  );
}

export async function markCallEnded(callEventId) {
  if (!callEventId) return null;

  const current = await CallEvent.findById(callEventId);
  if (!current) return null;

  const endedAt = new Date();
  const referenceTime = current.answeredAt || current.initiatedAt || endedAt;
  const durationSec = Math.max(
    0,
    Math.floor((endedAt.getTime() - new Date(referenceTime).getTime()) / 1000)
  );

  current.status = "ended";
  current.endedAt = endedAt;
  current.durationSec = durationSec;
  await current.save();

  return current;
}

export async function listPendingMissedCallsForUser({ userId, userRole, limit = 20 }) {
  if (!userId || !userRole) return [];

  return CallEvent.find({
    receiverId: userId,
    receiverRole: userRole,
    status: "missed",
    notifiedAt: null,
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

export async function markMissedCallsNotified(callEventIds) {
  if (!Array.isArray(callEventIds) || callEventIds.length === 0) return;

  await CallEvent.updateMany(
    { _id: { $in: callEventIds } },
    { $set: { notifiedAt: new Date() } }
  );
}

export async function markCallCancelled(callEventId) {
  if (!callEventId) return null;
  return CallEvent.findByIdAndUpdate(
    callEventId,
    { status: "cancelled", endedAt: new Date() },
    { new: true }
  );
}

export async function markCallsSeen(callEventIds) {
  if (!Array.isArray(callEventIds) || callEventIds.length === 0) return;
  await CallEvent.updateMany(
    { _id: { $in: callEventIds } },
    { $set: { seenAt: new Date() } }
  );
}

export async function getCallHistory({ userId, limit = 20, skip = 0 }) {
  if (!userId) return [];
  return CallEvent.find({
    $or: [{ callerId: userId }, { receiverId: userId }],
  })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();
}

export async function getMissedCallsForUser({ userId, limit = 50 }) {
  if (!userId) return [];
  return CallEvent.find({
    receiverId: userId,
    status: "missed",
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

export async function getCallHistoryForRoom({ roomId, limit = 20 }) {
  if (!roomId) return [];
  return CallEvent.find({ roomId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

export async function getCallEventById(callEventId) {
  if (!callEventId) return null;
  return CallEvent.findById(callEventId).lean();
}

export function buildCallEventText({ status, callType, actorName }) {
  const typeLabel = callType === "video" ? "video" : "audio";
  const caller = actorName || "User";

  switch (status) {
    case "missed":
    case "cancelled":
      return `Missed ${typeLabel} call from ${caller}`;
    case "accepted":
      return `${typeLabel} call accepted`;
    case "rejected":
      return `${typeLabel} call declined`;
    case "ended":
      return `${typeLabel} call ended`;
    default:
      return `${typeLabel} call event`;
  }
}
