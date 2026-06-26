import mongoose from "mongoose";

// Payment record for a SoulWay, SoulJar, or Chat feature subscription purchase.
const featurePaymentSchema = new mongoose.Schema(
  {
    userId:  { type: String, required: true, index: true },
    feature: { type: String, enum: ["soulway", "souljar", "chat"], required: true },
    amount:  { type: Number, required: true },              // NPR, server-authoritative
    method:  { type: String, enum: ["esewa", "khalti"], required: true },

    // Unique UUID generated per attempt — correlates gateway callbacks
    transactionUuid: { type: String, unique: true, required: true, index: true },

    // Khalti-specific
    khaltiPidx: { type: String, default: null, index: true },

    // Gateway-assigned transaction ID (filled on verification)
    gatewayTransactionId: { type: String, default: null },

    status: {
      type: String,
      enum: ["pending", "completed", "failed"],
      default: "pending",
      index: true,
    },

    gatewayResponse: { type: mongoose.Schema.Types.Mixed, default: null },
    verifiedAt:      { type: Date, default: null },
  },
  { timestamps: true }
);

export default mongoose.model("FeaturePayment", featurePaymentSchema);
