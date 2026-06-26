import mongoose from "mongoose";

// Tracks per-user trial and paid subscription access to SoulWay, SoulJar, and Chat.
// One document per (userId, feature) pair — upserted on trial init and on payment.
const featureSubscriptionSchema = new mongoose.Schema(
  {
    userId:  { type: String, required: true, index: true }, // Firebase UID
    feature: { type: String, enum: ["soulway", "souljar", "chat"], required: true },

    // Trial window (set once on first access)
    trialStartDate: { type: Date, required: true },
    trialEndDate:   { type: Date, required: true },

    // Overall access status
    status: {
      type: String,
      enum: ["trial", "active", "expired", "cancelled"],
      default: "trial",
      index: true,
    },

    // Paid subscription window (null until first payment)
    subscriptionStartDate: { type: Date, default: null },
    subscriptionEndDate:   { type: Date, default: null },

    // Latest payment reference
    latestPaymentId:     { type: mongoose.Schema.Types.ObjectId, ref: "FeaturePayment", default: null },
    latestPaymentMethod: { type: String, enum: ["esewa", "khalti", null], default: null },
    latestAmountPaid:    { type: Number, default: 0 },

    // ── Subscription expiry notification flags (reset on each renewal) ─────
    notifiedAt7Days:  { type: Boolean, default: false },
    notifiedAt3Days:  { type: Boolean, default: false },
    notifiedAtExpiry: { type: Boolean, default: false },

    // ── Trial expiry notification flags ────────────────────────────────────
    trialNotifiedAt5Days:  { type: Boolean, default: false },
    trialNotifiedAt6Days:  { type: Boolean, default: false },
    trialNotifiedAtExpiry: { type: Boolean, default: false },
  },
  { timestamps: true }
);

featureSubscriptionSchema.index({ userId: 1, feature: 1 }, { unique: true });

export default mongoose.model("FeatureSubscription", featureSubscriptionSchema);
