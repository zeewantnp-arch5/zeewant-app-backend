import mongoose from "mongoose";

const paymentSchema = new mongoose.Schema(
  {
    userId:    { type: String, required: true, index: true }, // student Firebase UID
    soulteeId: { type: String, required: true, index: true }, // soultee Firebase UID
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubscriptionPlan",
      required: true,
    },
    planName: { type: String, required: true },
    amount: { type: Number, required: true }, // NPR
    method: { type: String, enum: ["esewa", "khalti"], required: true },
    // Unique UUID generated per payment attempt; used to correlate gateway callbacks
    transactionUuid: { type: String, unique: true, required: true, index: true },
    // Gateway-assigned transaction ID (filled on verification)
    gatewayTransactionId: { type: String, default: null },
    // Khalti pidx (only for Khalti payments)
    khaltiPidx: { type: String, default: null, index: true },
    status: {
      type: String,
      enum: ["pending", "completed", "failed"],
      default: "pending",
      index: true,
    },
    gatewayResponse: { type: mongoose.Schema.Types.Mixed, default: null },
    verifiedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export default mongoose.model("Payment", paymentSchema);
