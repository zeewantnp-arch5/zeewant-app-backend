import mongoose from "mongoose";
import UserSubscription from "../models/UserSubscription.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";

/**
 * Middleware: block students who lack an active subscription for the specific
 * student-soultee pair being accessed.
 *
 * Soultees bypass this check — they never need to pay to respond.
 *
 * soulteeId resolution order:
 *   1. req.params.roomId  → look up StudentSoulteeLink.soulteeFirebaseUid
 *   2. req.body.soulteeId / req.query.soulteeId (fallback)
 *
 * userId resolution order:
 *   req.body.senderId → req.query.userId → req.params.userUid / userId
 */
export async function requireSubscription(req, res, next) {
  try {
    const userId =
      req.body.senderId ||
      req.query.userId ||
      req.params.userUid ||
      req.params.userId;

    const userRole =
      req.body.senderRole ||
      req.query.userRole ||
      req.params.userRole;

    // Soultees are never gated
    if (userRole === "soultee") return next();

    if (!userId) {
      return res.status(401).json({
        message: "Authentication required",
        code: "UNAUTHENTICATED",
      });
    }

    // Resolve soulteeId — prefer room lookup so client doesn't have to send it
    let soulteeId =
      req.body.soulteeId ||
      req.query.soulteeId;

    if (!soulteeId && req.params.roomId) {
      try {
        const isValidObjectId = mongoose.Types.ObjectId.isValid(req.params.roomId);
        if (isValidObjectId) {
          const link = await StudentSoulteeLink
            .findById(req.params.roomId)
            .select("soulteeFirebaseUid")
            .lean();
          soulteeId = link?.soulteeFirebaseUid;
        }
      } catch {
        // Non-fatal — subscription check will fail below if soulteeId is still missing
      }
    }

    if (!soulteeId) {
      return res.status(400).json({
        message: "soulteeId could not be resolved for this request",
        code: "MISSING_SOULTEE_ID",
      });
    }

    const now = new Date();
    const subscription = await UserSubscription.findOne({
      userId,
      soulteeId,
      status: "active",
      expiryDate: { $gt: now },
    }).lean();

    if (!subscription) {
      return res.status(403).json({
        message: "An active subscription is required to chat with this Soultee",
        code: "SUBSCRIPTION_REQUIRED",
      });
    }

    req.subscription = subscription;
    next();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}
