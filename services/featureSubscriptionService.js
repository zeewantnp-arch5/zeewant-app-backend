import FeatureSubscription from "../models/FeatureSubscription.js";
import FeaturePayment from "../models/FeaturePayment.js";
import { sendPushNotification } from "./fcmService.js";

// ── Server-authoritative pricing ─────────────────────────────────────────────
export const FEATURE_PRICING = {
  soulway: 399, // NPR/month
  souljar: 99,  // NPR/month
  chat:    199, // NPR/month
};

// Annual plan prices (includes bundle)
export const ANNUAL_PRICING = {
  souljar:        999,  // SoulJar annual
  souljar_soulway: 3999, // SoulJar + SoulWay annual bundle
};

const TRIAL_DAYS             = 7;
const SUBSCRIPTION_DAYS      = 30;
const ANNUAL_SUBSCRIPTION_DAYS = 365;

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

// ── Activate a single feature subscription (monthly or annual) ───────────────
async function _activateOne({ userId, feature, paymentId, method, amount, planType }) {
  const now = new Date();
  const days = planType === "annual" ? ANNUAL_SUBSCRIPTION_DAYS : SUBSCRIPTION_DAYS;
  const subscriptionStartDate = now;
  const subscriptionEndDate   = new Date(now);
  subscriptionEndDate.setDate(subscriptionEndDate.getDate() + days);

  return FeatureSubscription.findOneAndUpdate(
    { userId, feature },
    {
      $set: {
        status: "active",
        planType,
        subscriptionStartDate,
        subscriptionEndDate,
        latestPaymentId:     paymentId,
        latestPaymentMethod: method,
        latestAmountPaid:    amount,
        notifiedAt7Days:  false,
        notifiedAt3Days:  false,
        notifiedAtExpiry: false,
      },
    },
    { upsert: true, new: true }
  );
}

// ── Activate subscription after successful payment ───────────────────────────
// Detects annual plan by amount and activates 1 or 2 features accordingly.
export async function activateFeatureSubscription(payment) {
  const { userId, feature, _id: paymentId, method, amount } = payment;

  // Determine plan type and which features to activate
  const isAnnualBundle  = amount >= ANNUAL_PRICING.souljar_soulway;
  const isAnnualSouljar = !isAnnualBundle && amount >= ANNUAL_PRICING.souljar;
  const planType        = (isAnnualBundle || isAnnualSouljar) ? "annual" : "monthly";

  // Features to activate for this payment
  const featuresToActivate = isAnnualBundle
    ? ["souljar", "soulway"]
    : [feature || "souljar"];

  const activated = await Promise.all(
    featuresToActivate.map((f) =>
      _activateOne({ userId, feature: f, paymentId, method, amount, planType })
    )
  );

  const sub = activated[0];
  const subscriptionEndDate = sub.subscriptionEndDate;
  const endStr = subscriptionEndDate.toLocaleDateString("en-US", {
    day: "numeric", month: "long", year: "numeric",
  });

  const planLabel = isAnnualBundle
    ? "SoulJar + SoulWay Annual Bundle"
    : isAnnualSouljar
    ? "SoulJar Annual"
    : feature === "soulway" ? "SoulWay" : feature === "chat" ? "Soultee Chat" : "SoulJar";

  sendPushNotification(userId, {
    title: `✅ ${planLabel} Activated`,
    body:  `Your access is now active until ${endStr}. ${planType === "annual" ? "Enjoy your year!" : ""}`.trim(),
    data: {
      type:                "feature_subscription_activated",
      feature:             featuresToActivate[0],
      planType,
      subscriptionEndDate: subscriptionEndDate.toISOString(),
      screen:              featuresToActivate[0],
    },
  }).catch(() => {});

  return sub;
}

// ── Activate annual bundle directly (called from payment route for NPR 3999) ──
export async function activateAnnualBundle({ userId, paymentId, method, amount }) {
  return activateFeatureSubscription({ userId, feature: "souljar", _id: paymentId, method, amount });
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

  const revenue = { soulway: 0, souljar: 0, chat: 0 };
  const payments = { soulway: 0, souljar: 0, chat: 0 };
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
