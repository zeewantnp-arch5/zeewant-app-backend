import UserSubscription from "../models/UserSubscription.js";

/**
 * Middleware: block students who lack an active subscription.
 * Soultees bypass this check — they never need to pay to respond.
 *
 * Reads userId/userRole from:
 *   req.body   (POST routes — senderId / senderRole)
 *   req.query  (GET routes — userId / userRole)
 *   req.params (param-based routes — userUid, with userRole in query)
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

    const now = new Date();
    const subscription = await UserSubscription.findOne({
      userId,
      status: "active",
      expiryDate: { $gt: now },
    }).lean();

    if (!subscription) {
      return res.status(403).json({
        message: "An active subscription is required to access chat",
        code: "SUBSCRIPTION_REQUIRED",
      });
    }

    req.subscription = subscription;
    next();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}
