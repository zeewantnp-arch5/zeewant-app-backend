import UserSubscription from "../models/UserSubscription.js";
import { sendPushNotification } from "./fcmService.js";

/**
 * Runs the full subscription lifecycle job:
 *  1. Sends a 2-day warning to subscriptions expiring in the next 48 hours.
 *  2. Marks subscriptions past their expiryDate as 'expired' and notifies the user.
 *
 * Safe to call repeatedly — each step is idempotent.
 */
export async function runSubscriptionExpiryJob() {
  const now = new Date();
  console.log(`[subscription-expiry] Job started at ${now.toISOString()}`);

  try {
    await _sendExpiryWarnings(now);
    await _expireAndNotify(now);
  } catch (err) {
    console.error("[subscription-expiry] Job error:", err.message);
  }

  console.log("[subscription-expiry] Job finished.");
}

// ── 2-day warning ─────────────────────────────────────────────────────────────

async function _sendExpiryWarnings(now) {
  // Warn users 2 hours before their 24-hour session access expires
  const in2h = new Date(now.getTime() + 2 * 60 * 60 * 1000);

  const expiringSoon = await UserSubscription.find({
    status: "active",
    expiryDate: { $gt: now, $lte: in2h },
    warningSentAt: { $exists: false },
  }).lean();

  if (!expiringSoon.length) return;

  console.log(`[subscription-expiry] Sending 2-hour warning to ${expiringSoon.length} user(s)`);

  await Promise.allSettled(
    expiringSoon.map(async (sub) => {
      const minsLeft = Math.max(1, Math.round((sub.expiryDate - now) / (60 * 1000)));
      const timeLabel = minsLeft >= 60
        ? `${Math.round(minsLeft / 60)} hour${Math.round(minsLeft / 60) !== 1 ? "s" : ""}`
        : `${minsLeft} minute${minsLeft !== 1 ? "s" : ""}`;

      await sendPushNotification(sub.userId, {
        title: "⚠️ Session Access Expiring Soon",
        body: `Your chat access expires in ${timeLabel}. Open the app to continue your session.`,
        data: {
          type: "subscription_expiring",
          planName: sub.planName,
          expiryDate: sub.expiryDate.toISOString(),
          screen: "subscription",
        },
      });

      // Mark warning sent so we don't spam
      await UserSubscription.findByIdAndUpdate(sub._id, {
        warningSentAt: now,
      });
    })
  );
}

// ── Expire + notify ───────────────────────────────────────────────────────────

async function _expireAndNotify(now) {
  // Bulk-mark expired subscriptions
  const expiredResult = await UserSubscription.updateMany(
    { status: "active", expiryDate: { $lte: now } },
    { $set: { status: "expired" } }
  );

  if (!expiredResult.modifiedCount) return;

  console.log(
    `[subscription-expiry] Expired ${expiredResult.modifiedCount} subscription(s). Sending notifications…`
  );

  // Fetch the newly expired ones to notify each user
  const expiredSubs = await UserSubscription.find({
    status: "expired",
    expiryDate: { $lte: now },
    expiredNotifiedAt: { $exists: false }, // notify only once
  }).lean();

  await Promise.allSettled(
    expiredSubs.map(async (sub) => {
      await sendPushNotification(sub.userId, {
        title: "🔒 Subscription Expired",
        body: `Your Zeewant ${sub.planName} plan has ended. Renew to continue chatting with your Soultee.`,
        data: {
          type: "subscription_expired",
          planName: sub.planName,
          screen: "subscription",
        },
      });

      await UserSubscription.findByIdAndUpdate(sub._id, {
        expiredNotifiedAt: now,
      });
    })
  );
}
