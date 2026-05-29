import mongoose from "mongoose";

const soulteeFeedbackSchema = new mongoose.Schema(
  {
    studentUid:  { type: String, required: true, index: true }, // Firebase UID
    soulteeUid:  { type: String, required: true, index: true }, // Firebase UID
    roomId:      { type: String, default: null },               // chat room / session
    rating:      { type: Number, required: true, min: 1, max: 5 },
    comment:     { type: String, default: "" },
    studentName: { type: String, default: "Anonymous" },
  },
  { timestamps: true }
);

soulteeFeedbackSchema.index({ soulteeUid: 1, createdAt: -1 });

export default mongoose.model("SoulteeFeedback", soulteeFeedbackSchema);
