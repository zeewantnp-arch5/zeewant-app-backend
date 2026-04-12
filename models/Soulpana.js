import mongoose from "mongoose";

const soulpanaSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    title: { type: String, required: true },
    category: { type: String, required: true },
    soulteeType: { type: String, default: null }, // general type (optional when soultee is assigned directly)
    description: { type: String, required: true },
    emotionTag: { type: String, default: null },
    anonymous: { type: Boolean, default: false },
    // ── Direct soultee assignment (via StudentSoulteeLink) ──────────────────
    assignedSoulteeUid: { type: String, default: null, index: true },
    assignedSoulteeName: { type: String, default: null },
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
