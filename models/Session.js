import mongoose from "mongoose";

const sessionSchema = new mongoose.Schema(
  {
    soulteeFirebaseUid: { type: String, required: true },
    studentFirebaseUid: { type: String, required: true },
    studentName: { type: String, default: "Student" },

    scheduledAt: { type: Date, required: true },
    durationMinutes: { type: Number, default: 60 },
    sessionFee: { type: Number, default: 0 },

    // upcoming | ongoing | completed | cancelled
    status: {
      type: String,
      enum: ["upcoming", "ongoing", "completed", "cancelled"],
      default: "upcoming",
    },

    notes: { type: String, default: "" },       // soultee's private session notes
    sessionType: { type: String, default: "chat" }, // chat | video | voice
    cancelReason: { type: String, default: "" },
  },
  { timestamps: true }
);

export default mongoose.model("Session", sessionSchema);
