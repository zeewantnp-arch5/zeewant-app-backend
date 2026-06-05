import FeatureSubscription from "../models/FeatureSubscription.js";
import FeaturePayment from "../models/FeaturePayment.js";
import { sendPushNotification } from "./fcmService.js";

// ── Server-authoritative pricing ─────────────────────────────────────────────
export const FEATURE_PRICING = {
  soulway: 399, // NPR/month
  souljar: 99,  // NPR/month
};

const TRIAL_DAYS        = 7;
const SUBSCRIPTION_DAYS = 30;

// ── Access computation (pure, no DB) ─────────────────────────────────────────
export function computeAccess(sub) {
  const now = new Date();

  if (sub.status === "trial" && sub.trialEndDate > now) {
    const msLeft       = sub.trialEndDate - now;
    const daysRemaining = Math.max(1, Math.ceil(msLeft / 86_400_000));
    return {
      hasAccess: true,
      status: "trial",
      daysRemaining,
      trialEndDate:        sub.trialEndDate.toISOString(),
      subscriptionEndDate: null,
    };
  }

  if (sub.status === "active" && sub.subscriptionEndDate > now) {
    const msLeft       = sub.subscriptionEndDate - now;
    const daysRemaining = Math.max(1, Math.ceil(msLeft / 86_400_000));
    return {
      hasAccess: true,
      status: "active",
      daysRemaining,
      trialEndDate:        sub.trialEndDate?.toISOString() ?? null,
      subscriptionEndDate: sub.subscriptionEndDate.toISOString(),
    };
  }

  // Expired or cancelled
  return {
    hasAccess: false,
    status: "expired",
    daysRemaining: 0,
    trialEndDate:        sub.trialEndDate?.toISOString() ?? null,
    subscriptionEndDate: sub.subscriptionEndDate?.toISOString() ?? null,
  };
}

// ── Get or auto-initialize trial ─────────────────────────────────────────────
// Called every time the client checks access. Creates the trial on first call.
export async function getOrInitFeatureAccess(userId, feature) {
  let sub = await FeatureSubscription.findOne({ userId, feature });

  if (!sub) {
    const trialStartDate = new Date();
    const trialEndDate   = new Date(trialStartDate);
    trialEndDate.setDate(trialEndDate.getDate() + TRIAL_DAYS);

    sub = await FeatureSubscription.create({
      userId,
      feature,
      status: "trial",
      trialStartDate,
      trialEndDate,
    });
  }

  // Auto-expire stale trial records
  if (sub.status === "trial" && sub.trialEndDate <= new Date()) {
    sub = await FeatureSubscription.findByIdAndUpdate(
      sub._id,
      { status: "expired" },
      { new: true }
    );
  }

  // Auto-expire stale active subscriptions
  if (sub.status === "active" && sub.subscriptionEndDate <= new Date()) {
    sub = await FeatureSubscription.findByIdAndUpdate(
      sub._id,
      { status: "expired" },
      { new: true }
    );
  }

  return computeAccess(sub);
}

// ── Activate subscription after successful payment ───────────────────────────
export async function activateFeatureSubscription(payment) {
  const { userId, feature, _id: paymentId, method, amount } = payment;
  const now = new Date();
  const subscriptionStartDate = now;
  const subscriptionEndDate   = new Date(now);
  subscriptionEndDate.setDate(subscriptionEndDate.getDate() + SUBSCRIPTION_DAYS);

  const sub = await FeatureSubscription.findOneAndUpdate(
    { userId, feature },
    {
      $set: {
        status: "active",
        subscriptionStartDate,
        subscriptionEndDate,
        latestPaymentId:     paymentId,
        latestPaymentMethod: method,
        latestAmountPaid:    amount,
        // Reset expiry notification flags for the new cycle
        notifiedAt7Days:  false,
        notifiedAt3Days:  false,
        notifiedAtExpiry: false,
      },
    },
    { upsert: true, new: true }
  );

  const label = feature === "soulway" ? "SoulWay" : "SoulJar";
  const endStr = subscriptionEndDate.toLocaleDateString("en-US", {
    day: "numeric", month: "long", year: "numeric",
  });

  sendPushNotification(userId, {
    title: `✅ ${label} Subscription Activated`,
    body:  `Your ${label} access is now active until ${endStr}.`,
    data: {
      type:                "feature_subscription_activated",
      feature,
      subscriptionEndDate: subscriptionEndDate.toISOString(),
      screen:              feature,
    },
  }).catch(() => {});

  return sub;
}

// ── Admin: list all subscriptions with pagination ────────────────────────────
export async function listFeatureSubscriptions({ feature, status, page = 1, limit = 50 }) {
  const filter = {};
  if (feature) filter.feature = feature;
  if (status)  filter.status  = status;

  const [docs, total] = await Promise.all([
    FeatureSubscription.find(filter)
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    FeatureSubscription.countDocuments(filter),
  ]);

  return { subscriptions: docs, total, page, limit };
}

// ── Admin: revenue summary ───────────────────────────────────────────────────
export async function getFeatureRevenueStats() {
  const [paymentStats, subStats] = await Promise.all([
    FeaturePayment.aggregate([
      { $match: { status: "completed" } },
      {
        $group: {
          _id: "$feature",
          totalRevenue: { $sum: "$amount" },
          totalPayments: { $count: {} },
        },
      },
    ]),
    FeatureSubscription.aggregate([
      {
        $group: {
          _id: { feature: "$feature", status: "$status" },
          count: { $count: {} },
        },
      },
    ]),
  ]);

  const revenue = { soulway: 0, souljar: 0 };
  const payments = { soulway: 0, souljar: 0 };
  for (const s of paymentStats) {
    revenue[s._id]  = s.totalRevenue;
    payments[s._id] = s.totalPayments;
  }

  const counts = {};
  for (const s of subStats) {
    const key = s._id.feature;
    if (!counts[key]) counts[key] = {};
    counts[key][s._id.status] = s.count;
  }

  return { revenue, payments, counts };
}
