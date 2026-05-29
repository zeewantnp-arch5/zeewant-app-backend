import mongoose from "mongoose";

const userSubscriptionSchema = new mongoose.Schema(
  {
    userId:    { type: String, required: true, index: true }, // student Firebase UID
    soulteeId: { type: String, required: true, index: true }, // soultee Firebase UID
    userRole: { type: String, enum: ["student", "soultee"], default: "student" },
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubscriptionPlan",
      default: null,   // null for dynamic-fee (soultee-specific) payments
    },
    planName: { type: String, default: "session" }, // "session" for dynamic, or "normal"/"pro"/"advanced"
    status: {
      type: String,
      enum: ["active", "expired", "cancelled"],
      default: "active",
      index: true,
    },
    startDate: { type: Date, default: Date.now },
    expiryDate: { type: Date, required: true },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "Payment" },
    transactionId: { type: String, default: null },
    paymentMethod: { type: String, enum: ["esewa", "khalti", "code"], required: true },
    amountPaid: { type: Number, required: true },
    // Notification tracking — prevents duplicate alerts
    warningSentAt: { type: Date, default: null },      // 24-hr expiry warning sent
    expiredNotifiedAt: { type: Date, default: null },   // post-expiry notification sent
  },
  { timestamps: true }
);

userSubscriptionSchema.index({ userId: 1, soulteeId: 1, status: 1, expiryDate: -1 });

export default mongoose.model("UserSubscription", userSubscriptionSchema);
