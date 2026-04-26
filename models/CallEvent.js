import mongoose from "mongoose";

const callEventSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, index: true },
    callerId: { type: String, required: true, index: true },
    callerRole: { type: String, enum: ["student", "soultee"], required: true },
    callerName: { type: String, default: "" },
    receiverId: { type: String, required: true, index: true },
    receiverRole: { type: String, enum: ["student", "soultee"], required: true },
    callType: { type: String, enum: ["audio", "video"], default: "audio" },
    status: {
      type: String,
      enum: ["incoming", "missed", "accepted", "rejected", "ended", "cancelled"],
      default: "incoming",
      index: true,
    },
    initiatedAt: { type: Date, default: Date.now },
    answeredAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    durationSec: { type: Number, default: 0 },
    notifiedAt: { type: Date, default: null, index: true },
    agoraChannel: { type: String, default: null },
  },
  { timestamps: true }
);

callEventSchema.index({ receiverId: 1, receiverRole: 1, status: 1, notifiedAt: 1, createdAt: -1 });
callEventSchema.index({ roomId: 1, createdAt: -1 });

export default mongoose.model("CallEvent", callEventSchema);
