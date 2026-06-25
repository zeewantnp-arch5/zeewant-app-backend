import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, index: true }, // = requestDocId from StudentSoulteeLink
    senderId: { type: String, required: true },            // Firebase UID
    senderName: { type: String, default: "" },
    senderRole: { type: String, enum: ["student", "soultee"], required: true },
    recipientUid: { type: String, required: true },
    recipientRole: { type: String, enum: ["student", "soultee"], required: true },
    text: { type: String, default: "" },
    type: {
      type: String,
      enum: ["text", "image", "video", "document", "audio", "system", "missed_call"],
      default: "text",
    },
    callType: { type: String, enum: ["audio", "video", null], default: null },
    attachmentUrl: { type: String, default: null },
    attachmentName: { type: String, default: null },
    attachmentMimeType: { type: String, default: null },
    attachmentSize: { type: Number, default: null },
    replyToMessageId: { type: String, default: null },
    replyToText: { type: String, default: null },
    replyToSenderName: { type: String, default: null },
    status: {
      type: String,
      enum: ["sent", "delivered", "read"],
      default: "sent",
      index: true,
    },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    // ── Soft deletion ─────────────────────────────────────────────────────────
    isDeleted: { type: Boolean, default: false },
    deletedForEveryone: { type: Boolean, default: false },
    deletedBy: { type: String, default: null },
    deletedAt: { type: Date, default: null },
    // UIDs who deleted this message for themselves only ("Delete for Me")
    deletedForUsers: { type: [String], default: [] },
    // Emoji reactions: each entry = { userId, emoji, reactedAt }
    reactions: {
      type: [{
        userId:    { type: String, required: true },
        emoji:     { type: String, required: true },
        reactedAt: { type: Date, default: Date.now },
      }],
      default: [],
    },
  },
  { timestamps: true }
);

messageSchema.index({ roomId: 1, createdAt: -1 });
messageSchema.index({ recipientUid: 1, recipientRole: 1, status: 1, createdAt: -1 });
messageSchema.index({ roomId: 1, status: 1 });

export default mongoose.model("Message", messageSchema);
