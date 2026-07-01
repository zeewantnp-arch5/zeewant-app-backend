import FeatureSubscription from "../models/FeatureSubscription.js";
import { sendPushNotification } from "./fcmService.js";
import { FEATURE_PRICING, ANNUAL_PRICING } from "./featureSubscriptionService.js";

const DAY_MS = 86_400_000;

function daysUntil(date) {
  return Math.ceil((new Date(date) - Date.now()) / DAY_MS);
}

function featureLabel(feature) {
  return feature === "soulway" ? "SoulWay" : "SoulJar";
}

// ── Run once: expire stale records + send scheduled notifications ─────────────
export async function runFeatureExpiryJob() {
  const now = new Date();
  console.log("[FeatureExpiry] running job at", now.toISOString());

  try {
    await _processTrialNotifications(now);
    await _processSubscriptionNotifications(now);
    await _expireStaleRecords(now);
  } catch (err) {
    console.error("[FeatureExpiry] job error:", err.message);
  }
}

// ── Trial notifications (Day 5, Day 6, Expiry Day) ───────────────────────────
async function _processTrialNotifications(now) {
  const activeTrial = await FeatureSubscription.find({
    status: "trial",
    trialEndDate: { $gt: now },
  }).lean();

  for (const sub of activeTrial) {
    const days = daysUntil(sub.trialEndDate);
    const label = featureLabel(sub.feature);

    // Day 5 reminder (2 days left in 7-day trial)
    if (days === 2 && !sub.trialNotifiedAt5Days) {
      await sendPushNotification(sub.userId, {
        title: `⏳ ${label} Trial Ending Soon`,
        body: `Your free ${label} trial ends in 2 days. Subscribe to keep access!`,
        data: { type: "feature_trial_reminder", feature: sub.feature, daysLeft: "2" },
      }).catch(() => {});
      await FeatureSubscription.updateOne({ _id: sub._id }, { trialNotifiedAt5Days: true });
    }

    // Day 6 reminder (1 day left)
    if (days === 1 && !sub.trialNotifiedAt6Days) {
      await sendPushNotification(sub.userId, {
        title: `🔔 Last Day of ${label} Trial`,
        body: `Your free ${label} trial ends tomorrow. Subscribe now for NPR ${sub.feature === "soulway" ? 399 : 99}/month!`,
        data: { type: "feature_trial_reminder", feature: sub.feature, daysLeft: "1" },
      }).catch(() => {});
      await FeatureSubscription.updateOne({ _id: sub._id }, { trialNotifiedAt6Days: true });
    }
  }

  // Trial expiry notifications (trial ended today — within last 24h)
  const justExpiredTrial = await FeatureSubscription.find({
    status: "trial",
    trialEndDate: { $lte: now, $gt: new Date(now - DAY_MS) },
    trialNotifiedAtExpiry: false,
  }).lean();

  for (const sub of justExpiredTrial) {
    const label = featureLabel(sub.feature);
    await sendPushNotification(sub.userId, {
      title: `🔒 ${label} Trial Expired`,
      body: `Your ${label} trial has ended. Subscribe for NPR ${sub.feature === "soulway" ? 399 : 99}/month to continue!`,
      data: { type: "feature_trial_expired", feature: sub.feature },
    }).catch(() => {});
    await FeatureSubscription.updateOne(
      { _id: sub._id },
      { status: "expired", trialNotifiedAtExpiry: true }
    );
  }
}

// ── Subscription notifications (7 days, 3 days, expiry day) ──────────────────
async function _processSubscriptionNotifications(now) {
  const activeSubs = await FeatureSubscription.find({
    status: "active",
    subscriptionEndDate: { $gt: now },
  }).lean();

  for (const sub of activeSubs) {
    const days     = daysUntil(sub.subscriptionEndDate);
    const label    = featureLabel(sub.feature);
    const isAnnual = sub.planType === "annual";
    const renewPrice = isAnnual
      ? (sub.feature === "souljar" ? `NPR ${ANNUAL_PRICING.souljar}/year` : `NPR ${ANNUAL_PRICING.souljar_soulway}/year`)
      : `NPR ${FEATURE_PRICING[sub.feature] ?? 99}/month`;

    if (days === 7 && !sub.notifiedAt7Days) {
      await sendPushNotification(sub.userId, {
        title: `📅 ${label} ${isAnnual ? "Annual Plan" : "Subscription"} Renews in 7 Days`,
        body: `Your ${label} ${isAnnual ? "annual plan" : "subscription"} expires in 7 days. Renew for ${renewPrice}.`,
        data: { type: "feature_sub_expiry_reminder", feature: sub.feature, daysLeft: "7", planType: sub.planType ?? "monthly" },
      }).catch(() => {});
      await FeatureSubscription.updateOne({ _id: sub._id }, { notifiedAt7Days: true });
    }

    if (days === 3 && !sub.notifiedAt3Days) {
      await sendPushNotification(sub.userId, {
        title: `⚠️ ${label} ${isAnnual ? "Annual Plan" : "Subscription"} Expires in 3 Days`,
        body: `Renew your ${label} ${isAnnual ? "annual plan" : "subscription"} (${renewPrice}) to avoid losing access.`,
        data: { type: "feature_sub_expiry_reminder", feature: sub.feature, daysLeft: "3", planType: sub.planType ?? "monthly" },
      }).catch(() => {});
      await FeatureSubscription.updateOne({ _id: sub._id }, { notifiedAt3Days: true });
    }
  }

  // Expiry day — lock and notify
  const justExpiredSub = await FeatureSubscription.find({
    status: "active",
    subscriptionEndDate: { $lte: now, $gt: new Date(now - DAY_MS) },
    notifiedAtExpiry: false,
  }).lean();

  for (const sub of justExpiredSub) {
    const label    = featureLabel(sub.feature);
    const isAnnual = sub.planType === "annual";
    const renewPrice = isAnnual
      ? (sub.feature === "souljar" ? `NPR ${ANNUAL_PRICING.souljar}/year` : `NPR ${ANNUAL_PRICING.souljar_soulway}/year`)
      : `NPR ${FEATURE_PRICING[sub.feature] ?? 99}/month`;

    await sendPushNotification(sub.userId, {
      title: `🔒 ${label} ${isAnnual ? "Annual Plan" : "Subscription"} Expired`,
      body: `Your ${label} access has ended. Tap to renew for ${renewPrice} and restore access.`,
      data: {
        type:     "feature_sub_expired",
        feature:  sub.feature,
        planType: sub.planType ?? "monthly",
        screen:   "subscriptions",
      },
    }).catch(() => {});

    // Lock this feature
    await FeatureSubscription.updateOne(
      { _id: sub._id },
      { status: "expired", notifiedAtExpiry: true }
    );

    // If annual bundle — also lock the paired feature (soulway ↔ souljar)
    if (isAnnual && (sub.feature === "souljar" || sub.feature === "soulway")) {
      const paired = sub.feature === "souljar" ? "soulway" : "souljar";
      await FeatureSubscription.updateOne(
        { userId: sub.userId, feature: paired, planType: "annual", status: "active" },
        { status: "expired", notifiedAtExpiry: true }
      );
    }
  }
}

// ── Bulk expire all overdue records ───────────────────────────────────────────
async function _expireStaleRecords(now) {
  const [t, s] = await Promise.all([
    FeatureSubscription.updateMany(
      { status: "trial",  trialEndDate:        { $lte: now } },
      { $set: { status: "expired" } }
    ),
    FeatureSubscription.updateMany(
      { status: "active", subscriptionEndDate: { $lte: now } },
      { $set: { status: "expired" } }
    ),
  ]);
  if (t.modifiedCount || s.modifiedCount)
    console.log(`[FeatureExpiry] expired ${t.modifiedCount} trials, ${s.modifiedCount} subscriptions`);
}
