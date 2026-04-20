import mongoose from "mongoose";

const campaignSchema = new mongoose.Schema(
  {
    name:           { type: String, required: true },
    acronym:        { type: String, required: true },
    description:    { type: String, default: "" },
    startDate:      { type: Date },
    endDate:        { type: Date },
    status: {
      type: String,
      enum: ["planning", "upcoming", "live", "completed", "paused"],
      default: "planning",
    },
    targetAudience: { type: String, default: "all" },
    reach:          { type: Number, default: 0 },
    participation:  { type: Number, default: 0 },
    conversions:    { type: Number, default: 0 },
    budget:         { type: Number, default: 0 },
    createdBy:      { type: String },
    tags:           [String],
  },
  { timestamps: true }
);

campaignSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model("Campaign", campaignSchema);
