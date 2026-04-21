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
    parentCommentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SoulpanaComment",
      default: null,
      index: true,
    },
    text: { type: String, required: true, trim: true },
    likes: { type: [String], default: [] },
    dislikes: { type: [String], default: [] },
  },
  { timestamps: true }
);

export default mongoose.model("SoulpanaComment", soulpanaCommentSchema);
