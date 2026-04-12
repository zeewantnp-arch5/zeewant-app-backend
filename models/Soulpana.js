import mongoose from "mongoose";

const soulpanaSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    title: { type: String, required: true },
    category: { type: String, required: true },
    soulteeType: { type: String, required: true },
    description: { type: String, required: true },
    emotionTag: { type: String, default: null }, // sad, anxious, confused, lonely, overwhelmed, angry, hopeful
    anonymous: { type: Boolean, default: false },
    status: { type: String, default: "pending", enum: ["pending", "answered", "closed"] },
    attachments: [
      {
        originalName: String,
        fileName: String,
        mimeType: String,
        size: Number,
      },
    ],
    soulteeResponse: { type: String, default: null },
    respondedBy: { type: String, default: null }, // soultee firebaseUid
    respondedByName: { type: String, default: null },
    respondedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export default mongoose.model("Soulpana", soulpanaSchema);
