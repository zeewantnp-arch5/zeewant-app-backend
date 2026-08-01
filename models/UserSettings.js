import mongoose from "mongoose";

// Stores per-user app settings.
const userSettingsSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      unique: true,
    },
    shieldEnabled: {
      type: Boolean,
      default: false,
    },
    // Store a hashed passkey only; never store raw passkey in DB.
    shieldPasskeyHash: {
      type: String,
      default: null,
    },
    shieldPasskeySetAt: {
      type: Date,
      default: null,
    },
    // A one-time-visible recovery code hash used when user forgets passkey.
    shieldRecoveryCodeHash: {
      type: String,
      default: null,
    },
    shieldRecoveryCodeSetAt: {
      type: Date,
      default: null,
    },
    shieldRecoveryFailedAttempts: {
      type: Number,
      default: 0,
    },
    shieldRecoveryLockedUntil: {
      type: Date,
      default: null,
    },
    shieldPasskeyFailedAttempts: {
      type: Number,
      default: 0,
    },
    shieldPasskeyLockedUntil: {
      type: Date,
      default: null,
    },
    // reserved for future settings fields
  },
  { timestamps: true }
);

export default mongoose.model("UserSettings", userSettingsSchema);
