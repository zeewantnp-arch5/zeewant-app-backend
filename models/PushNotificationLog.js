import mongoose from "mongoose";

const pushNotificationLogSchema = new mongoose.Schema(
  {
    title:          { type: String, required: true },
    body:           { type: String, required: true },
    type: {
      type: String,
      enum: ["motivational", "emotional_support", "campaign", "feature_update", "story"],
      default: "motivational",
    },
    targetAudience: {
      type: String,
      enum: ["all", "students", "premium", "soulpana_pending", "inactive"],
      default: "all",
    },
    sentCount:      { type: Number, default: 0 },
    deliveredCount: { type: Number, default: 0 },
    openedCount:    { type: Number, default: 0 },
    clickedCount:   { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["draft", "sending", "sent", "failed"],
      default: "draft",
    },
    sentAt:     { type: Date },
    sentBy:     { type: String },
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign" },
  },
  { timestamps: true }
);

pushNotificationLogSchema.index({ status: 1, createdAt: -1 });
pushNotificationLogSchema.index({ createdAt: -1 });

export default mongoose.model("PushNotificationLog", pushNotificationLogSchema);
