import FCMToken from "../models/FCMToken.js";
import Notification from "../models/Notification.js";
import { sendPushNotification, syncNotificationToRTDB } from "../config/firebase.js";

export function buildPersonalRoom(role, uid) {
  return `${role}:${uid}`;
}

export function serializeNotification(notification) {
  return {
    _id: notification._id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    data: Object.fromEntries(notification.data || []),
    read: notification.read,
    createdAt: notification.createdAt,
  };
}

export function emitToUser(io, role, uid, eventName, payload) {
  io.to(buildPersonalRoom(role, uid)).emit(eventName, payload);
}

export async function createNotification(
  io,
  { recipientUid, recipientRole, type, title, body, data = {} }
) {
  const notification = await Notification.create({
    recipientUid,
    recipientRole,
    type,
    title,
    body,
    data,
  });

  const serialized = serializeNotification(notification);
  emitToUser(io, recipientRole, recipientUid, "new_notification", serialized);

  // Sync to Firebase RTDB for real-time reads
  syncNotificationToRTDB(recipientUid, String(notification._id), {
    ...serialized,
    data: serialized.data,
    createdAt: notification.createdAt.getTime(),
  });

  try {
    const tokenRecord = await FCMToken.findOne({ uid: recipientUid }).lean();
    if (tokenRecord) {
      const stringData = Object.fromEntries(
        Object.entries(data).map(([key, value]) => [key, String(value)])
      );
      await sendPushNotification(tokenRecord.token, title, body, stringData);
    }
  } catch (err) {
    if (
      err.code === "messaging/registration-token-not-registered" ||
      err.code === "messaging/invalid-registration-token"
    ) {
      await FCMToken.deleteOne({ uid: recipientUid });
    }
  }

  return notification;
}