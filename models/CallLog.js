import mongoose from "mongoose";

// One document per individual voice/video call attempt (ad-hoc, free,
// happens inside an already-paid chat Session). Distinct from Session,
// which tracks the paid chat booking itself.
const callLogSchema = new mongoose.Schema(
  {
    callId:   { type: String, required: true, unique: true }, // ZEGOCLOUD invitation callID
    roomId:   { type: String, default: "" },

    callerUid:  { type: String, required: true },
    calleeUid:  { type: String, required: true },
    callerName: { type: String, default: "" },
    calleeName: { type: String, default: "" },
    calleeRole: { type: String, enum: ["student", "soultee"], default: "soultee" },

    callType: { type: String, enum: ["voice", "video"], required: true },

    // ringing → ongoing → completed, or ringing → missed/rejected/busy/cancelled
    status: {
      type: String,
      enum: ["ringing", "ongoing", "completed", "missed", "rejected", "busy", "cancelled"],
      default: "ringing",
    },

    startedAt:   { type: Date, default: Date.now },
    acceptedAt:  { type: Date, default: null },
    endedAt:     { type: Date, default: null },
    durationSeconds: { type: Number, default: 0 },

    missedReason: { type: String, default: "" },
  },
  { timestamps: true }
);

callLogSchema.index({ callerUid: 1, startedAt: -1 });
callLogSchema.index({ calleeUid: 1, startedAt: -1 });

export default mongoose.model("CallLog", callLogSchema);
