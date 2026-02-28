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

export default mongoose.model("Souljar", souljarSchema);