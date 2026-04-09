import mongoose from "mongoose";

const soulpanaSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    title: { type: String, required: true },
    category: { type: String, required: true },
    soulteeType: { type: String, required: true },
    description: { type: String, required: true },
    anonymous: { type: Boolean, default: false },
    status: { type: String, default: "pending" },
    attachments: [
      {
        originalName: String,
        fileName: String,
        mimeType: String,
        size: Number,
      },
    ],
  },
  { timestamps: true }
);

export default mongoose.model("Soulpana", soulpanaSchema);
