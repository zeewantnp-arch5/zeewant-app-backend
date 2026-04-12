import mongoose from "mongoose";

const soulpanaCommentSchema = new mongoose.Schema(
  {
    questionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Soulpana",
      required: true,
      index: true,
    },
    authorId: { type: String, required: true },       // Firebase UID
    authorName: { type: String, required: true },
    authorRole: {
      type: String,
      required: true,
      enum: ["student", "soultee"],
    },
    text: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

export default mongoose.model("SoulpanaComment", soulpanaCommentSchema);
