import mongoose from "mongoose";

const POST_CATEGORIES = [
  "Anxiety",
  "Depression",
  "Stress",
  "Relationships",
  "Self-Esteem",
  "Grief & Loss",
  "Anger Management",
  "Loneliness",
  "Trauma",
  "Work & Career",
  "Family Issues",
  "Academic Pressure",
  "Identity & Purpose",
  "Other",
];

// Sub-schema for a single media attachment within a post
const mediaItemSchema = new mongoose.Schema(
  {
    type:     { type: String, enum: ["image", "audio", "video"], required: true },
    url:      { type: String, required: true },
    path:     { type: String, default: null }, // Firebase Storage path for deletion
    size:     { type: Number, default: 0 },    // bytes
    mimeType: { type: String, default: "" },
  },
  { _id: false }
);

const postSchema = new mongoose.Schema(
  {
    userId:   { type: String, required: true, index: true },
    userName: { type: String, default: "Anonymous" },
    userRole: { type: String, enum: ["student", "soultee"], default: "student" },

    title:       { type: String, required: true, trim: true, maxlength: 200 },
    category:    { type: String, required: true, enum: POST_CATEGORIES },
    description: { type: String, default: "" },

    // ── Single media — kept for backwards compatibility ──────────────────────
    mediaType: { type: String, enum: ["none", "image", "video", "audio"], default: "none" },
    mediaUrl:  { type: String, default: null },
    mediaPath: { type: String, default: null }, // Firebase Storage path (for deletion)

    // ── Multiple media items: image + audio + video in one post ──────────────
    mediaItems: { type: [mediaItemSchema], default: [] },

    status:       { type: String, enum: ["pending", "approved", "rejected"], default: "pending", index: true },
    adminComment: { type: String, default: "" },
    approvedBy:   { type: String, default: null },
    approvedAt:   { type: Date,   default: null },
    rejectedBy:   { type: String, default: null },
    rejectedAt:   { type: Date,   default: null },

    likes:    { type: [String], default: [] },
    dislikes: { type: [String], default: [] },
    views:    { type: Number,   default: 0 },
  },
  { timestamps: true }
);

postSchema.index({ status: 1, createdAt: -1 });
postSchema.index({ userId: 1, createdAt: -1 });

postSchema.virtual("likeCount").get(function () {
  return this.likes.length;
});
postSchema.virtual("dislikeCount").get(function () {
  return this.dislikes.length;
});

postSchema.set("toJSON", { virtuals: true });

export { POST_CATEGORIES };
export default mongoose.model("Post", postSchema);
