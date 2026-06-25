import mongoose from "mongoose";
import UserSubscription from "../models/UserSubscription.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";

// Cache valid subscriptions for 5 minutes to avoid a DB read on every message.
const _subCache = new Map();
const _SUB_TTL = 5 * 60_000;

function _subKey(userId, soulteeId) { return `${userId}:${soulteeId}`; }
function _getCachedSub(userId, soulteeId) {
  const e = _subCache.get(_subKey(userId, soulteeId));
  if (!e) return null;
  if (Date.now() - e.ts > _SUB_TTL) { _subCache.delete(_subKey(userId, soulteeId)); return null; }
  return e.sub;
}
function _cacheSub(userId, soulteeId, sub) {
  _subCache.set(_subKey(userId, soulteeId), { sub, ts: Date.now() });
  if (_subCache.size > 2000) _subCache.delete(_subCache.keys().next().value);
}
export function invalidateSubCache(userId, soulteeId) {
  _subCache.delete(_subKey(userId, soulteeId));
}

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
    // req.body is undefined on GET/DELETE requests (no JSON body sent).
    // Always default to {} to avoid "Cannot read properties of undefined" crashes.
    const body = req.body ?? {};

    const userId =
      body.senderId ||
      req.query.userId ||
      req.params.userUid ||
      req.params.userId;

    const userRole =
      body.senderRole ||
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
      body.soulteeId ||
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

    const cached = _getCachedSub(userId, soulteeId);
    if (cached) {
      req.subscription = cached;
      return next();
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

    _cacheSub(userId, soulteeId, subscription);
    req.subscription = subscription;
    next();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}
