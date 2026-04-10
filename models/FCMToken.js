import mongoose from "mongoose";

// Stores the latest FCM device token for each user (student or soultee)
const fcmTokenSchema = new mongoose.Schema(
  {
    uid: { type: String, required: true, unique: true }, // Firebase UID
    role: { type: String, enum: ["student", "soultee"], required: true },
    token: { type: String, required: true }, // FCM registration token
  },
  { timestamps: true }
);

export default mongoose.model("FCMToken", fcmTokenSchema);
