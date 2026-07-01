import mongoose from "mongoose";

const paymentSchema = new mongoose.Schema(
  {
    userId:    { type: String, required: true, index: true }, // student Firebase UID
    soulteeId: { type: String, required: true, index: true }, // soultee Firebase UID
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubscriptionPlan",
      default: null,   // null for dynamic-fee payments (no fixed plan)
    },
    planName: { type: String, default: "session" },
    durationMinutes: { type: Number, default: null }, // chosen session duration in minutes
    amount: { type: Number, required: true }, // NPR
    method: { type: String, enum: ["esewa", "khalti", "cos"], required: true },
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
    // Extended payment status for COS and unified tracking
    paymentStatus: {
      type: String,
      enum: ["pending", "verified", "approved", "rejected", "paid"],
      default: "pending",
      index: true,
    },
    verificationStatus: {
      type: String,
      enum: ["pending_verification", "verified", "rejected"],
      default: "pending_verification",
      index: true,
    },
    // COS proof upload (student uploads screenshot / voucher URL from Firebase Storage)
    proofUpload: {
      url:        { type: String, default: null },
      uploadedAt: { type: Date,   default: null },
      fileType:   { type: String, default: null },
    },
    approvedBy:       { type: String, default: null },
    approvedAt:       { type: Date,   default: null },
    rejectionReason:  { type: String, default: null },
    invoiceUrl:       { type: String, default: null },
    receiptUrl:       { type: String, default: null },
    sessionReportUrl: { type: String, default: null },
    gatewayResponse: { type: mongoose.Schema.Types.Mixed, default: null },
    verifiedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export default mongoose.model("Payment", paymentSchema);
