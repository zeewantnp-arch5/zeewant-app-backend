import mongoose from "mongoose";

// Tracks which students are connected to which soultee
const studentSoulteeLinkSchema = new mongoose.Schema(
  {
    studentFirebaseUid: { type: String, required: true },
    studentName: { type: String, default: "Student" },
    soulteeFirebaseUid: { type: String, required: true },
    soulteeMongoId: { type: mongoose.Schema.Types.ObjectId, ref: "Soultee" },

    // pending → soultee hasn't accepted yet
    // active  → soultee accepted, currently linked
    // ended   → session ended / unlinked
    // declined → soultee declined the request
    status: {
      type: String,
      enum: ["pending", "active", "ended", "declined"],
      default: "pending",
    },

    requestMessage: { type: String, default: "" }, // student's initial message
    requestedAt: { type: Date, default: Date.now },
    acceptedAt: Date,
    endedAt: Date,
  },
  { timestamps: true }
);

// One student can only have one active/pending link with a soultee at a time
studentSoulteeLinkSchema.index(
  { studentFirebaseUid: 1, soulteeFirebaseUid: 1 },
  { unique: true }
);

export default mongoose.model("StudentSoulteeLink", studentSoulteeLinkSchema);
