import FollowUpCode from "../models/FollowUpCode.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";

export async function runFollowUpExpiryJob(io) {
  try {
    const now = new Date();
    const expired = await FollowUpCode.find({ status: "active", expiresAt: { $lte: now } }).lean();

    for (const fu of expired) {
      await FollowUpCode.updateOne({ _id: fu._id }, { status: "expired" });
      await StudentSoulteeLink.updateOne({ _id: fu.roomId }, { chatLocked: true });

      if (io) {
        io.to(fu.roomId).emit("followup_expired",  { roomId: fu.roomId });
        io.to(fu.roomId).emit("chat_relocked",      { roomId: fu.roomId });
      }
      console.log(`[followUpExpiry] Code ${fu.code} expired → room ${fu.roomId} relocked`);
    }

    if (expired.length > 0) {
      console.log(`[followUpExpiry] Expired ${expired.length} follow-up code(s)`);
    }
  } catch (err) {
    console.error("[followUpExpiry] Job error:", err.message);
  }
}
