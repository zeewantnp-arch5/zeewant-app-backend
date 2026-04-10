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
  });
}

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
