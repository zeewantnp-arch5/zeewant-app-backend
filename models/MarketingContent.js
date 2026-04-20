import mongoose from "mongoose";

const marketingContentSchema = new mongoose.Schema(
  {
    title:       { type: String, required: true },
    type: {
      type: String,
      enum: ["soultee_post", "quote", "story", "educational", "campaign"],
      required: true,
    },
    body:        { type: String, default: "" },
    status: {
      type: String,
      enum: ["draft", "scheduled", "published"],
      default: "draft",
    },
    publishedAt: { type: Date },
    scheduledAt: { type: Date },
    campaignId:  { type: mongoose.Schema.Types.ObjectId, ref: "Campaign" },
    views:       { type: Number, default: 0 },
    likes:       { type: Number, default: 0 },
    shares:      { type: Number, default: 0 },
    saves:       { type: Number, default: 0 },
    createdBy:   { type: String },
    tags:        [String],
  },
  { timestamps: true }
);

marketingContentSchema.index({ status: 1, createdAt: -1 });
marketingContentSchema.index({ type: 1, createdAt: -1 });
marketingContentSchema.index({ views: -1 });

export default mongoose.model("MarketingContent", marketingContentSchema);
