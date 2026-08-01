import admin from "firebase-admin";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load the service account key JSON from the project root
// Generate this from: Firebase Console → Project Settings → Service Accounts → Generate new private key
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    // Production: credentials passed as env var
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } else {
    // Local dev: read from file
    serviceAccount = JSON.parse(
      readFileSync(join(__dirname, "../firebase-service-account.json"), "utf8")
    );
  }
} catch {
  console.warn("⚠️  Firebase service account not configured — biometric login and push notifications disabled");
}

if (serviceAccount && !admin.apps.length) {
  const firebaseConfig = {
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  };
  const dbUrl = process.env.FIREBASE_DATABASE_URL?.trim();
  if (dbUrl) {
    firebaseConfig.databaseURL = dbUrl;
  } else {
    console.warn(
      "⚠️  FIREBASE_DATABASE_URL is missing — RTDB sync features are disabled"
    );
  }
  admin.initializeApp(firebaseConfig);
}

// ─── Realtime Database reference ─────────────────────────────────────────────
function getDB() {
  if (!admin.apps.length) return null;
  try {
    return admin.database();
  } catch (err) {
    console.warn(`⚠️  RTDB unavailable: ${err.message}`);
    return null;
  }
}

// ─── Force logout ──────────────────────────────────────────────────────────────
/**
 * Flag a user for immediate sign-out on their device (admin block/delete) at
 * /forceLogout/{uid}. The app holds a live listener on this path so it takes
 * effect right away instead of waiting for the cached ID token to expire.
 * Also revokes refresh tokens so a fresh sign-in attempt is rejected too.
 * @param {string} uid
 * @param {string} reason
 */
export async function setForceLogout(uid, reason) {
  const db = getDB();
  if (db) {
    try {
      await db.ref(`forceLogout/${uid}`).set({ reason, at: Date.now() });
    } catch (err) {
      console.error("RTDB setForceLogout error:", err.message);
    }
  }
  try {
    await admin.auth().revokeRefreshTokens(uid);
  } catch (err) {
    console.warn("revokeRefreshTokens error (non-fatal):", err.message);
  }
}

/**
 * Clear the force-logout flag (e.g. on unblock).
 * @param {string} uid
 */
export async function clearForceLogout(uid) {
  const db = getDB();
  if (!db) return;
  try {
    await db.ref(`forceLogout/${uid}`).remove();
  } catch (err) {
    console.error("RTDB clearForceLogout error:", err.message);
  }
}

// ─── Profile sync ─────────────────────────────────────────────────────────────
/**
 * Sync a user profile to Firebase RTDB at /profiles/{uid}
 * @param {string} uid
 * @param {object} profileData
 */
export async function syncProfileToRTDB(uid, profileData) {
  const db = getDB();
  if (!db) return;
  try {
    await db.ref(`profiles/${uid}`).set({
      ...profileData,
      updatedAt: Date.now(),
    });
  } catch (err) {
    console.error("RTDB syncProfile error:", err.message);
  }
}

// ─── Notification sync ────────────────────────────────────────────────────────
/**
 * Write a notification to Firebase RTDB at /notifications/{uid}/{notifId}
 * @param {string} uid
 * @param {string} notifId
 * @param {object} notifData
 */
export async function syncNotificationToRTDB(uid, notifId, notifData) {
  const db = getDB();
  if (!db) return;
  try {
    await db.ref(`notifications/${uid}/${notifId}`).set(notifData);
  } catch (err) {
    console.error("RTDB syncNotification error:", err.message);
  }
}

/**
 * Update a notification field in RTDB (e.g. mark as read)
 * @param {string} uid
 * @param {string} notifId
 * @param {object} updates  e.g. { read: true }
 */
export async function updateNotificationInRTDB(uid, notifId, updates) {
  const db = getDB();
  if (!db) return;
  try {
    await db.ref(`notifications/${uid}/${notifId}`).update(updates);
  } catch (err) {
    console.error("RTDB updateNotification error:", err.message);
  }
}

/**
 * Delete a notification from RTDB
 * @param {string} uid
 * @param {string} notifId  — pass null to delete ALL notifications for uid
 */
export async function deleteNotificationFromRTDB(uid, notifId = null) {
  const db = getDB();
  if (!db) return;
  try {
    const path = notifId ? `notifications/${uid}/${notifId}` : `notifications/${uid}`;
    await db.ref(path).remove();
  } catch (err) {
    console.error("RTDB deleteNotification error:", err.message);
  }
}

// ─── OTP helpers ──────────────────────────────────────────────────────────────
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ATTEMPTS = 5;

/**
 * Generate and store a 6-digit OTP in RTDB at /otps/{uid}
 * Returns the generated OTP string so the caller can send it.
 * @param {string} uid
 * @returns {string} otp
 */
export async function storeOTP(uid) {
  const db = getDB();
  if (!db) throw new Error("Firebase not initialised");

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  await db.ref(`otps/${uid}`).set({
    otp,
    expiresAt: Date.now() + OTP_TTL_MS,
    attempts: 0,
  });
  return otp;
}

/**
 * Verify an OTP for a user. Deletes the record on success or after max attempts.
 * @param {string} uid
 * @param {string} code   - the OTP entered by the user
 * @returns {{ valid: boolean, reason?: string }}
 */
export async function verifyOTP(uid, code) {
  const db = getDB();
  if (!db) return { valid: false, reason: "Firebase not initialised" };

  const ref = db.ref(`otps/${uid}`);
  const snap = await ref.once("value");

  if (!snap.exists()) return { valid: false, reason: "No OTP found. Please request a new one." };

  const { otp, expiresAt, attempts } = snap.val();

  if (Date.now() > expiresAt) {
    await ref.remove();
    return { valid: false, reason: "OTP has expired. Please request a new one." };
  }

  if (attempts >= MAX_ATTEMPTS) {
    await ref.remove();
    return { valid: false, reason: "Too many attempts. Please request a new OTP." };
  }

  if (String(code) !== String(otp)) {
    await ref.update({ attempts: attempts + 1 });
    return { valid: false, reason: "Incorrect OTP." };
  }

  // Success — remove the OTP record
  await ref.remove();
  return { valid: true };
}

// ─── Engagement sync (likes / dislikes) ──────────────────────────────────────
/**
 * Sync like / dislike counts to Firebase RTDB at /engagement/{questionId}.
 * Clients can listen to this path for real-time badge updates in list views.
 * @param {string} questionId  MongoDB _id string
 * @param {number} likeCount
 * @param {number} dislikeCount
 */
export async function syncEngagementToRTDB(questionId, likeCount, dislikeCount) {
  const db = getDB();
  if (!db) return;
  try {
    await db.ref(`engagement/${questionId}`).set({
      likeCount,
      dislikeCount,
      updatedAt: Date.now(),
    });
  } catch (err) {
    console.error("RTDB syncEngagement error:", err.message);
  }
}

// ─── Comment posted sync ─────────────────────────────────────────────────────
/**
 * Write a lightweight record to RTDB at /comments/{questionId}/lastActivity
 * so Flutter listeners know a new comment arrived without polling MongoDB.
 */
export async function syncCommentToRTDB(questionId, commentId, meta) {
  const db = getDB();
  if (!db) return;
  try {
    await db.ref(`comments/${questionId}/lastActivity`).set({
      commentId,
      authorRole: meta.authorRole ?? "unknown",
      isReply:    meta.isReply ?? false,
      ts:         Date.now(),
    });
  } catch (err) {
    console.error("RTDB syncComment error:", err.message);
  }
}

// ─── Comment interaction sync ───────────────────────────────────────────────
/**
 * Sync a single comment interaction payload to RTDB at
 * /commentInteractions/{questionId}/{commentId}
 */
export async function syncCommentInteractionToRTDB(questionId, commentId, payload) {
  const db = getDB();
  if (!db) return;
  try {
    await db.ref(`commentInteractions/${questionId}/${commentId}`).update({
      ...payload,
      updatedAt: Date.now(),
    });
  } catch (err) {
    console.error("RTDB syncCommentInteraction error:", err.message);
  }
}

// ─── Post RTDB sync ───────────────────────────────────────────────────────────
/**
 * Push an approved post's metadata to RTDB at /explore/posts/{postId}
 * Flutter clients listen here for real-time explore feed updates.
 */
export async function syncPostToRTDB(postId, postMeta) {
  const db = getDB();
  if (!db) return;
  try {
    await db.ref(`explore/posts/${postId}`).set({
      ...postMeta,
      updatedAt: Date.now(),
    });
  } catch (err) {
    console.error("RTDB syncPost error:", err.message);
  }
}

/**
 * Remove a post from the RTDB explore feed (rejected or deleted).
 */
export async function removePostFromRTDB(postId) {
  const db = getDB();
  if (!db) return;
  try {
    await db.ref(`explore/posts/${postId}`).remove();
  } catch (err) {
    console.error("RTDB removePost error:", err.message);
  }
}

/**
 * Sync a post's like count to RTDB at /explore/engagement/{postId}
 */
export async function syncPostEngagementToRTDB(postId, likeCount) {
  const db = getDB();
  if (!db) return;
  try {
    await db.ref(`explore/engagement/${postId}`).set({
      likeCount,
      updatedAt: Date.now(),
    });
  } catch (err) {
    console.error("RTDB syncPostEngagement error:", err.message);
  }
}

// ─── FCM push notification ────────────────────────────────────────────────────
/**
 * Send a Firebase Cloud Messaging push notification.
 * Silently no-ops if Firebase is not initialised.
 *
 * @param {string} token   - FCM device token
 * @param {string} title   - Notification title
 * @param {string} body    - Notification body
 * @param {object} data    - Extra key-value payload (all strings)
 */
export async function sendPushNotification(token, title, body, data = {}) {
  if (!admin.apps.length || !token) return;

  const stringData = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, String(v)])
  );

  try {
    await admin.messaging().send({
      token,
      notification: { title, body },
      data: stringData,
      android: { priority: "high" },
      apns: { payload: { aps: { sound: "default", badge: 1 } } },
    });
  } catch (err) {
    // Invalid/stale token — caller should delete it
    if (
      err.code === "messaging/registration-token-not-registered" ||
      err.code === "messaging/invalid-registration-token"
    ) {
      throw err; // bubble up so the route can remove the token
    }
    console.error("FCM send error:", err.message);
  }
}

// ─── Session timer sync ───────────────────────────────────────────────────────
/**
 * Write or update session timer state to RTDB at /sessionTimers/{roomId}.
 * Both student and soultee listen to this path for real-time countdown sync.
 * @param {string} roomId  — StudentSoulteeLink._id
 * @param {object} timerData  — { sessionId, soulteeUid, studentUid, startedAt, durationMinutes, expiresAt, status }
 */
export async function syncSessionTimerToRTDB(roomId, timerData) {
  const db = getDB();
  if (!db) return;
  try {
    await db.ref(`sessionTimers/${roomId}`).set({
      ...timerData,
      updatedAt: Date.now(),
    });
  } catch (err) {
    console.error("RTDB syncSessionTimer error:", err.message);
  }
}

// ─── Broadcast: write new-post signal to RTDB so all student clients update ───
/**
 * Writes a new-post broadcast to /broadcasts/new_posts/{postId}.
 * Student Flutter clients listen here and show an in-app notification.
 */
export async function syncBroadcastToRTDB(postId, broadcastData) {
  const db = getDB();
  if (!db) return;
  try {
    await db.ref(`broadcasts/new_posts/${postId}`).set({
      ...broadcastData,
      createdAt: Date.now(),
    });
  } catch (err) {
    console.error("RTDB syncBroadcast error:", err.message);
  }
}

// ─── FCM topic notification (sends to all subscribers of a topic) ─────────────
/**
 * Send an FCM notification to every device subscribed to `topic`.
 * Students subscribe to "new_posts" at app startup.
 */
export async function sendTopicNotification(topic, title, body, data = {}) {
  if (!admin.apps.length) return;
  const stringData = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, String(v)])
  );
  try {
    await admin.messaging().send({
      topic,
      notification: { title, body },
      data: stringData,
      android: { priority: "high" },
      apns: { payload: { aps: { sound: "default", badge: 1 } } },
    });
  } catch (err) {
    console.error("FCM topic send error:", err.message);
  }
}

export default admin;
