import admin from "firebase-admin";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load the service account key JSON from the project root
// Generate this from: Firebase Console → Project Settings → Service Accounts → Generate new private key
let serviceAccount;
try {
  serviceAccount = JSON.parse(
    readFileSync(join(__dirname, "../firebase-service-account.json"), "utf8")
  );
} catch {
  // Allow startup without the key (socket-only mode); FCM notifications will be skipped
  console.warn("⚠️  firebase-service-account.json not found — push notifications disabled");
}

if (serviceAccount && !admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
}

// ─── Realtime Database reference ─────────────────────────────────────────────
function getDB() {
  if (!admin.apps.length) return null;
  return admin.database();
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

export default admin;
