import FollowUpOtp from "../models/FollowUpCode.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";

export async function runFollowUpExpiryJob() {
  try {
    const now = new Date();
    // Find OTPs that were USED (follow-up active) and have now passed their 7-day window
    const expired = await FollowUpOtp.find({ status: "USED", expiresAt: { $lte: now } }).lean();

    for (const record of expired) {
      await FollowUpOtp.updateOne({ _id: record._id }, { status: "EXPIRED" });
      await StudentSoulteeLink.updateOne({ _id: record.roomId }, { chatLocked: true });

      console.log(`[followUpExpiry] OTP ${record.otp} expired → room ${record.roomId} relocked`);
    }

    if (expired.length > 0) {
      console.log(`[followUpExpiry] Expired ${expired.length} follow-up OTP(s)`);
    }
  } catch (err) {
    console.error("[followUpExpiry] Job error:", err.message);
  }
}
