import rateLimit from "express-rate-limit";

// Generic response shape so a rate-limited request looks like any other
// generic failure — never reveal that throttling kicked in.
const throttledResponse = (_req, res) => {
  res.status(429).json({ message: "Too many requests. Please try again later." });
};

// Applied globally to /api/* — stops scripted abuse without affecting normal use.
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: throttledResponse,
});

// Applied to login / password / OTP endpoints — tuned so a real user retrying
// a mistyped password a few times never notices, but a credential-stuffing
// or OTP brute-force script gets stopped fast.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: throttledResponse,
});

// Applied to OTP-send endpoints specifically — prevents flooding a victim's
// phone/device with push notifications.
export const otpSendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: throttledResponse,
});
