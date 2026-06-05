import mongoose from "mongoose";

const sessionWithdrawalSchema = new mongoose.Schema(
  {
    soulteeFirebaseUid: { type: String, required: true, index: true },
    amount:             { type: Number, required: true },

    method: {
      type: String,
      enum: ["esewa", "khalti", "bank"],
      required: true,
    },

    // Filled based on method
    accountDetails: {
      number:        { type: String, default: "" }, // eSewa/Khalti number
      bankName:      { type: String, default: "" },
      accountHolder: { type: String, default: "" },
      accountNumber: { type: String, default: "" },
      branchName:    { type: String, default: "" },
    },

    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "paid"],
      default: "pending",
      index: true,
    },

    adminNote:    { type: String, default: "" },
    reference:    { type: String, default: "" }, // payment reference / UTR
    processedAt:  { type: Date, default: null },
    processedBy:  { type: String, default: null }, // admin UID
  },
  { timestamps: true }
);

sessionWithdrawalSchema.index({ soulteeFirebaseUid: 1, status: 1, createdAt: -1 });

export default mongoose.model("SessionWithdrawal", sessionWithdrawalSchema);
