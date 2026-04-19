import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema(
  {
    // Recipient
    recipientUid:  { type: String, required: true, index: true },
    recipientRole: { type: String, enum: ["student", "soultee"], required: true },

    // What kind of notification
    type: {
      type: String,
      enum: [
        "connection_request",            // soultee receives: student wants to connect
        "connection_accepted",           // student receives: soultee accepted
        "connection_declined",           // student receives: soultee declined
        "new_message",                   // either side: unread chat message
        "call_incoming",                 // either side: incoming call while offline
        "session_scheduled",             // student receives: soultee scheduled a session
        "session_cancelled",             // either side: session was cancelled
        // SOULTEE application lifecycle
        "application_approved",          // applicant receives: application approved
        "application_rejected",          // applicant receives: application rejected
        "application_revision_requested",// applicant receives: changes needed
      ],
      required: true,
    },

    title:   { type: String, required: true },
    body:    { type: String, required: true },

    // Extra context — linkId, roomId, senderUid, etc.
    // Stored as a flat string map so it matches the FCM data payload shape
    data: { type: Map, of: String, default: {} },

    read: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

// Compound index: fetch unread notifications for a user efficiently
notificationSchema.index({ recipientUid: 1, read: 1, createdAt: -1 });

export default mongoose.model("Notification", notificationSchema);
