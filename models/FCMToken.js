import mongoose from "mongoose";

// Stores FCM device tokens for each user (student or soultee)
// Supports multiple tokens per user (different devices)
const fcmTokenSchema = new mongoose.Schema(
  {
    userUid: { type: String, required: true, index: true }, // Firebase UID
    token: { type: String, required: true },                 // FCM registration token
    isActive: { type: Boolean, default: true, index: true }, // Is token still valid
    registeredAt: { type: Date, default: Date.now },
    lastUsedAt: { type: Date, default: Date.now },
    deactivatedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Compound index for unique tokens per user
fcmTokenSchema.index({ userUid: 1, token: 1 }, { unique: true });
fcmTokenSchema.index({ isActive: 1, lastUsedAt: -1 });

export default mongoose.model("FCMToken", fcmTokenSchema);
