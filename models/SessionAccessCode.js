import mongoose from "mongoose";

const sessionAccessCodeSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    soulteeId: { type: String, required: true, index: true },
    issuedBy: { type: String, default: null },
    status: {
      type: String,
      enum: ["active", "redeemed", "expired", "revoked"],
      default: "active",
      index: true,
    },
    validUntil: { type: Date, required: true },
    redeemedAt: { type: Date, default: null },
    redeemedSubscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "UserSubscription",
      default: null,
    },
  },
  { timestamps: true }
);

sessionAccessCodeSchema.index({ userId: 1, soulteeId: 1, status: 1, validUntil: -1 });

export default mongoose.model("SessionAccessCode", sessionAccessCodeSchema);