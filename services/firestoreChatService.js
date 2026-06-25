/**
 * firestoreChatService.js
 *
 * Backend-side Firestore operations for the Firebase chat migration.
 * Flutter clients write messages directly to Firestore; this service
 * handles server-initiated writes: system messages (missed calls, session
 * events), and conversation-metadata updates that the client cannot do
 * because they require admin-SDK privileges or run as side-effects of
 * other backend operations.
 */

import admin from 'firebase-admin';

const db = admin.firestore();

// ── Helpers ────────────────────────────────────────────────────────────────

const msgs = (roomId) =>
  db.collection('conversations').doc(roomId).collection('messages');

const conv = (roomId) => db.collection('conversations').doc(roomId);

// ── Conversation bootstrap ─────────────────────────────────────────────────

/**
 * Creates the conversations/{roomId} document if it does not yet exist.
 * Called when a StudentSoulteeLink transitions to "active" so the Firestore
 * document is ready before either Flutter client opens the chat screen.
 */
export async function ensureConversation(
  roomId,
  { studentUid, soulteeUid, studentName, solteeName }
) {
  const ref = conv(roomId);
  await ref.set(
    {
      id: roomId,
      studentUid,
      soulteeUid,
      studentName,
      solteeName,
      status: 'active',
      chatLocked: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      unreadCounts: { [studentUid]: 0, [soulteeUid]: 0 },
    },
    { merge: true }
  );
}

// ── System messages ────────────────────────────────────────────────────────

/**
 * Writes a system message (missed_call, session-event notice, etc.) directly
 * to Firestore and bumps the conversation's lastMessage + unreadCount.
 * Returns the new Firestore document ID.
 */
export async function sendSystemMessage({
  roomId,
  senderId,
  senderName,
  senderRole,
  recipientUid,
  text,
  type = 'system',
  callType = null,
}) {
  const now = admin.firestore.Timestamp.now();
  const docRef = msgs(roomId).doc();

  const batch = db.batch();

  batch.set(docRef, {
    senderId,
    senderName,
    senderRole,
    recipientUid,
    text,
    type,
    ...(callType && { callType }),
    status: 'sent',
    isDeleted: false,
    deletedForEveryone: false,
    deletedForUsers: [],
    reactions: {},
    createdAt: now,
    updatedAt: now,
  });

  batch.set(
    conv(roomId),
    {
      lastMessage: { id: docRef.id, text, type, senderId, createdAt: now },
      updatedAt: now,
      [`unreadCounts.${recipientUid}`]: admin.firestore.FieldValue.increment(1),
    },
    { merge: true }
  );

  await batch.commit();
  return docRef.id;
}

// ── Session-lock state ─────────────────────────────────────────────────────

/**
 * Updates chatLocked on the conversation document.
 * Flutter's conversationStream picks this up in real time, replacing the
 * need for Socket.IO chat_locked / chat_relocked / chat_unlocked events.
 */
export async function setConversationLocked(roomId, chatLocked) {
  await conv(roomId).set(
    { chatLocked, updatedAt: admin.firestore.Timestamp.now() },
    { merge: true }
  );
}

// ── Follow-up state ────────────────────────────────────────────────────────

/**
 * Sets follow-up activation / expiry on the conversation document.
 * Flutter's conversationStream replaces the followup_activated /
 * followup_expired Socket.IO events.
 */
export async function setFollowUpStatus(roomId, { active, expiresAt, durationMinutes }) {
  const now = admin.firestore.Timestamp.now();
  const update = {
    followUpActive: active,
    chatLocked: !active,
    updatedAt: now,
  };
  if (expiresAt) {
    update.followUpExpiresAt = admin.firestore.Timestamp.fromDate(
      new Date(expiresAt)
    );
  }
  if (durationMinutes != null) {
    update.followUpDurationMinutes = durationMinutes;
  }
  if (!active) {
    // On expiry, reset the timer fields so the client doesn't restart the countdown.
    update.followUpExpiresAt = admin.firestore.FieldValue.delete();
    update.followUpDurationMinutes = admin.firestore.FieldValue.delete();
  }
  await conv(roomId).set(update, { merge: true });
}

// ── COS (Cash on Service) state ────────────────────────────────────────────

/**
 * Marks a COS payment as pending on the conversation so the client shows
 * the pending banner immediately on next open (even after app restart).
 */
export async function setCosPending(roomId, pending) {
  await conv(roomId).set(
    { cosPending: pending, updatedAt: admin.firestore.Timestamp.now() },
    { merge: true }
  );
}

// ── Active sessions metadata ───────────────────────────────────────────────

/**
 * Returns the Firestore lastMessage and unreadCounts for a list of roomIds.
 * Used by the active-sessions API endpoint to overlay real-time message
 * metadata onto the MongoDB session list without a Firestore stream.
 */
export async function getConversationsMeta(roomIds) {
  if (!roomIds.length) return {};
  const refs = roomIds.map((id) => conv(id));
  const snaps = await db.getAll(...refs);
  const result = {};
  for (const snap of snaps) {
    if (snap.exists) result[snap.id] = snap.data();
  }
  return result;
}
