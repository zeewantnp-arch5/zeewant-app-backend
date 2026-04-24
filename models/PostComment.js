import mongoose from "mongoose";

const postCommentSchema = new mongoose.Schema(
  {
    postId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Post",
      required: true,
      index: true,
    },
    authorId:   { type: String, required: true },
    authorName: { type: String, required: true },
    authorRole: { type: String, enum: ["student", "soultee"], default: "student" },
    text:       { type: String, required: true, trim: true, maxlength: 1000 },
    likes:      { type: [String], default: [] },
  },
  { timestamps: true }
);

postCommentSchema.virtual("likeCount").get(function () {
  return this.likes.length;
});
postCommentSchema.set("toJSON", { virtuals: true });

export default mongoose.model("PostComment", postCommentSchema);
