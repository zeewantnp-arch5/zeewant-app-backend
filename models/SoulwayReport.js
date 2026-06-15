import mongoose from "mongoose";

const soulwayReportSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    entryCount: Number,
    collectionPeriod: {
      from: Date,
      to: Date,
    },
    crisisDetected: { type: Boolean, default: false },
    crisisMessage: String,
    // Keyed by normalized section heading (e.g. "primary_pattern_identified")
    sections: { type: mongoose.Schema.Types.Mixed, default: {} },
    rawReport: String,
    generatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Auto-expire reports after 7 days so stale analyses don't persist
soulwayReportSchema.index({ generatedAt: 1 }, { expireAfterSeconds: 604800 });

export default mongoose.model("SoulwayReport", soulwayReportSchema);
