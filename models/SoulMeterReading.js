import mongoose from "mongoose";

const soulMeterReadingSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    primaryEmotion: {
      type: String,
      required: true,
      enum: ["stress", "anxiety", "sadness", "happiness", "neutral", "fatigue"],
    },
    scores: {
      stress: { type: Number, required: true, min: 0, max: 100 },
      anxiety: { type: Number, required: true, min: 0, max: 100 },
      sadness: { type: Number, required: true, min: 0, max: 100 },
      happiness: { type: Number, required: true, min: 0, max: 100 },
      neutral: { type: Number, required: true, min: 0, max: 100 },
      fatigue: { type: Number, required: true, min: 0, max: 100 },
    },
    confidence: {
      type: Number,
      required: true,
      min: 0,
      max: 1,
    },
    quality: {
      lowLight: { type: Boolean, default: false },
      faceCount: { type: Number, default: 1, min: 0 },
      inferenceVersion: { type: String, default: "mlkit-heuristic-v1" },
    },
    consentToStore: {
      type: Boolean,
      required: true,
      default: false,
    },
    source: {
      type: String,
      default: "mobile-realtime",
      trim: true,
    },
    detectedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: true }
);

soulMeterReadingSchema.index({ userId: 1, detectedAt: -1 });

export default mongoose.model("SoulMeterReading", soulMeterReadingSchema);
