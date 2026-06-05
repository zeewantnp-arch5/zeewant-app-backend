import mongoose from "mongoose";

// One document per soultee. Tracks cumulative earnings and withdrawals.
// availableBalance = totalEarned - totalWithdrawn - pendingWithdrawals
const sessionWalletSchema = new mongoose.Schema(
  {
    soulteeFirebaseUid: { type: String, required: true, unique: true, index: true },

    totalEarned:        { type: Number, default: 0 }, // sum of soulteeEarnings for completed sessions
    totalWithdrawn:     { type: Number, default: 0 }, // sum of approved+paid withdrawals
    pendingWithdrawals: { type: Number, default: 0 }, // sum of pending withdrawal requests
  },
  { timestamps: true }
);

sessionWalletSchema.virtual("availableBalance").get(function () {
  return Math.max(0, this.totalEarned - this.totalWithdrawn - this.pendingWithdrawals);
});

sessionWalletSchema.virtual("withdrawableBalance").get(function () {
  return Math.max(0, this.totalEarned - this.totalWithdrawn - this.pendingWithdrawals);
});

sessionWalletSchema.set("toJSON", { virtuals: true });

export default mongoose.model("SessionWallet", sessionWalletSchema);
