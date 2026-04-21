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
    // ── Firebase Storage media URLs (uploaded directly from the client) ──────
    mediaUrls: [{ type: String }],
    // ── Engagement (like / dislike) ──────────────────────────────────────────
    // Each array stores Firebase UIDs — no duplicates enforced at schema level,
    // enforced atomically via $addToSet / $pull in the route.
    likes:    [{ type: String }],   // UIDs of users who liked
    dislikes: [{ type: String }],   // UIDs of users who disliked
    soulteeResponse: { type: String, default: null },
    respondedBy: { type: String, default: null }, // soultee firebaseUid
    respondedByName: { type: String, default: null },
    respondedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Virtual counts — included in toJSON / toObject so API consumers never need
// to count the array length themselves.
soulpanaSchema.virtual("likeCount").get(function () {
  return this.likes?.length ?? 0;
});
soulpanaSchema.virtual("dislikeCount").get(function () {
  return this.dislikes?.length ?? 0;
});

soulpanaSchema.set("toJSON",   { virtuals: true });
soulpanaSchema.set("toObject", { virtuals: true });

export default mongoose.model("Soulpana", soulpanaSchema);
