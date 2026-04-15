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
      enum: ["text", "image", "video", "document", "audio", "system"],
      default: "text",
    },
    attachmentUrl: { type: String, default: null },
    attachmentName: { type: String, default: null },
    attachmentMimeType: { type: String, default: null },
    attachmentSize: { type: Number, default: null },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

messageSchema.index({ roomId: 1, createdAt: -1 });
messageSchema.index({ recipientUid: 1, recipientRole: 1, readAt: 1, createdAt: -1 });

export default mongoose.model("Message", messageSchema);
