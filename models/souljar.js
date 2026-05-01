import mongoose from "mongoose";

const souljarSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },

    jarCode: {
      type: String,
      unique: true,
      required: true,
    },

    topic: String,
    text: String,

    mood: String,
    activity: String,

    stamp: String,

    anonymous: {
      type: Boolean,
      default: false,
    },

    reflectionSeconds: Number,

    ocrText: String,

    imagePath: String,

    attachmentNames: [String],

    wordCount: Number,
  },
  { timestamps: true }
);

souljarSchema.index({ createdAt: -1 });
souljarSchema.index({ topic: 1, createdAt: -1 });
souljarSchema.index({ userId: 1, createdAt: -1 });
souljarSchema.index({ anonymous: 1, createdAt: -1 });

export default mongoose.model("Souljar", souljarSchema);