import admin from "../config/firebase.js";
import FCMToken from "../models/FCMToken.js";

/**
 * Send a push notification to a user via FCM
 * @param {String} userUid - Firebase UID of the recipient
 * @param {Object} notification - Notification object
 * @param {String} notification.title - Notification title
 * @param {String} notification.body - Notification body
 * @param {Object} notification.data - Additional data (optional)
 * @returns {Promise<Object>} - Result with count of messages sent
 */
export async function sendPushNotification(userUid, notification) {
  try {
    if (!admin.apps.length) {
      console.error("Firebase not initialized");
      return { success: false, messagesSent: 0, error: "Firebase not initialized" };
    }

    // Get all FCM tokens for this user
    const tokens = await FCMToken.find({
      userUid,
      isActive: true,
    }).select("token");

    if (!tokens.length) {
      console.log(`No active FCM tokens found for user: ${userUid}`);
      return { success: true, messagesSent: 0 };
    }

    const tokenList = tokens.map((t) => t.token);

    const message = {
      notification: {
        title: notification.title || "Zeewant Notification",
        body: notification.body || "",
      },
      data: notification.data || {},
    };

    // Send to all tokens for this user
    const response = await admin.messaging().sendMulticast({
      tokens: tokenList,
      ...message,
    });

    // Log the response
    console.log(`FCM notification sent to ${userUid}:`, {
      successCount: response.successCount,
      failureCount: response.failureCount,
    });

    // Handle failures - remove invalid tokens
    if (response.failureCount > 0) {
      const failedTokens = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          failedTokens.push(tokenList[idx]);
        }
      });

      if (failedTokens.length > 0) {
        await FCMToken.updateMany(
          { token: { $in: failedTokens } },
          { isActive: false }
        );
        console.log(`Deactivated ${failedTokens.length} invalid FCM tokens`);
      }
    }

    return {
      success: response.failureCount === 0,
      messagesSent: response.successCount,
      failureCount: response.failureCount,
    };
  } catch (err) {
    console.error("FCM notification error:", err.message);
    return { success: false, messagesSent: 0, error: err.message };
  }
}

/**
 * Send a notification to multiple users
 * @param {Array<String>} userUids - Array of Firebase UIDs
 * @param {Object} notification - Notification object
 * @returns {Promise<Object>} - Aggregated result
 */
export async function sendBulkPushNotifications(userUids, notification) {
  const results = await Promise.all(
    userUids.map((uid) => sendPushNotification(uid, notification))
  );

  const totalSent = results.reduce((sum, r) => sum + (r.messagesSent || 0), 0);
  const totalFailed = results.reduce((sum, r) => sum + (r.failureCount || 0), 0);

  return {
    success: totalFailed === 0,
    messagesSent: totalSent,
    failureCount: totalFailed,
    details: results,
  };
}

/**
 * Register or update an FCM token for a user
 * @param {String} userUid - Firebase UID
 * @param {String} token - FCM token
 * @returns {Promise<Object>} - Token record
 */
export async function registerFCMToken(userUid, token) {
  if (!userUid || !token) {
    throw new Error("userUid and token are required");
  }
  try {
    return await FCMToken.findOneAndUpdate(
      { userUid, token },
      { userUid, token, isActive: true, registeredAt: new Date(), lastUsedAt: new Date() },
      { upsert: true, new: true }
    );
  } catch (err) {
    // Stale unique index on the legacy 'uid' field causes E11000 when uid is absent.
    // Fall back to a find-or-create pattern so token registration never blocks the app.
    if (err.code === 11000) {
      console.warn("[FCM] Stale uid_1 index conflict — dropping stale index and retrying");
      try {
        await FCMToken.collection.dropIndex("uid_1");
        console.log("[FCM] Dropped stale uid_1 index");
      } catch (_) { /* already gone */ }
      return await FCMToken.findOneAndUpdate(
        { userUid, token },
        { userUid, token, isActive: true, registeredAt: new Date(), lastUsedAt: new Date() },
        { upsert: true, new: true }
      );
    }
    console.error("Error registering FCM token:", err.message);
    throw err;
  }
}

/**
 * Deactivate an FCM token
 * @param {String} userUid - Firebase UID
 * @param {String} token - FCM token
 * @returns {Promise<void>}
 */
export async function deactivateFCMToken(userUid, token) {
  try {
    await FCMToken.findOneAndUpdate(
      { userUid, token },
      { isActive: false, deactivatedAt: new Date() }
    );
  } catch (err) {
    console.error("Error deactivating FCM token:", err.message);
    throw err;
  }
}

/**
 * Get all active FCM tokens for a user
 * @param {String} userUid - Firebase UID
 * @returns {Promise<Array>} - Array of active tokens
 */
export async function getActiveFCMTokens(userUid) {
  try {
    const tokens = await FCMToken.find({
      userUid,
      isActive: true,
    }).select("token");

    return tokens.map((t) => t.token);
  } catch (err) {
    console.error("Error retrieving FCM tokens:", err.message);
    return [];
  }
}

/**
 * Clean up old and inactive FCM tokens
 * @returns {Promise<Object>} - Count of deleted tokens
 */
export async function cleanupFCMTokens() {
  try {
    // Delete tokens older than 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const result = await FCMToken.deleteMany({
      isActive: false,
      deactivatedAt: { $lt: thirtyDaysAgo },
    });

    console.log(`Cleaned up ${result.deletedCount} old FCM tokens`);
    return result;
  } catch (err) {
    console.error("Error cleaning up FCM tokens:", err.message);
    throw err;
  }
}
