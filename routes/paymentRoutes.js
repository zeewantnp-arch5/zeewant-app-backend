import express from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import Payment from "../models/Payment.js";
import Soultee from "../models/Soultee.js";
import UserSubscription from "../models/UserSubscription.js";
import SubscriptionPlan from "../models/SubscriptionPlan.js";
import Session from "../models/Session.js";
import SystemSettings from "../models/SystemSettings.js";
import StudentSoulteeLink from "../models/StudentSoulteeLink.js";
import FollowUpOtp from "../models/FollowUpCode.js";
import { buildEsewaFormParams, verifyEsewaCallback } from "../services/esewaService.js";
import { initiateKhaltiPayment, verifyKhaltiPayment } from "../services/khaltiService.js";
import { sendPushNotification } from "../services/fcmService.js";
import PDFDocument from "pdfkit";

const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret";

function requireAdminJwt(req, res, next) {
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ message: "No token provided" });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

async function getCommissionRate() {
  const s = await SystemSettings.findOne({ key: "platform_commission_rate" }).lean();
  const rate = Number(s?.value);
  return Number.isFinite(rate) && rate >= 0 && rate <= 100 ? rate : 10;
}

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function activateSubscription(payment) {
  const startDate = new Date();
  const soultee = await Soultee.findOne({ firebaseUid: payment.soulteeId })
    .select("durationMinutes feePerSession")
    .lean();

  // Determine subscription duration from the plan if one is set,
  // otherwise default to 24 h (single session-based payments).
  let durationDays = 0;
  if (payment.planId) {
    try {
      const plan = await SubscriptionPlan.findById(payment.planId).select("durationDays").lean();
      if (plan?.durationDays > 0) durationDays = plan.durationDays;
    } catch (_) {}
  }

  const expiryDate = new Date(startDate);
  if (durationDays > 0) {
    expiryDate.setDate(expiryDate.getDate() + durationDays);
  } else {
    expiryDate.setHours(expiryDate.getHours() + 24);
  }

  await UserSubscription.create({
    userId:        payment.userId,
    soulteeId:     payment.soulteeId,
    planId:        payment.planId ?? null,
    planName:      payment.planName ?? "session",
    paymentId:     payment._id,
    transactionId: payment.gatewayTransactionId,
    paymentMethod: payment.method,
    amountPaid:    payment.amount,
    status:        "active",
    startDate,
    expiryDate,
  });

  // Create an upcoming session — pre-calculate soulteeEarnings using DB commission rate
  let existingLink = null;
  try {
    const commissionRate    = await getCommissionRate();
    const soulteeEarnings   = +(payment.amount * (1 - commissionRate / 100)).toFixed(2);
    const platformEarnings  = +(payment.amount * commissionRate / 100).toFixed(2);

    // New payment = full reset: unlock chat, reactivate ended link, expire old OTPs
    existingLink = await StudentSoulteeLink.findOne({
      soulteeFirebaseUid: payment.soulteeId,
      studentFirebaseUid: payment.userId,
    }).lean().catch(() => null);
    if (existingLink) {
      const resetFields = { chatLocked: false };
      if (existingLink.status === "ended") resetFields.status = "active";
      await StudentSoulteeLink.updateOne({ _id: existingLink._id }, resetFields).catch(() => {});
      await FollowUpOtp.updateMany(
        { roomId: existingLink._id.toString(), status: { $in: ["ACTIVE", "USED"] } },
        { status: "EXPIRED" }
      ).catch(() => {});
    }

    // Use payment.durationMinutes if the student chose a specific duration,
    // otherwise fall back to the soultee's default session length.
    const sessionDuration = (payment.durationMinutes && payment.durationMinutes > 0)
      ? payment.durationMinutes
      : (soultee?.durationMinutes || 30);

    const sess = await Session.create({
      soulteeFirebaseUid: payment.soulteeId,
      studentFirebaseUid: payment.userId,
      studentName:      existingLink?.studentName || "Student",
      scheduledAt:      new Date(),
      durationMinutes:  sessionDuration,
      sessionFee:       payment.amount,
      commissionRate,
      soulteeEarnings,
      platformEarnings,
      sessionType:      "chat",
      status:           "upcoming",
    });

    // Notify soultee that a new session is ready to start
    if (existingLink) {
      const { createNotification } = await import("../services/notificationService.js");
      createNotification({
        recipientUid:  payment.soulteeId,
        recipientRole: "soultee",
        type:          "session_paid",
        title:         "Session Ready to Start",
        body:          `${existingLink.studentName || "A student"} has paid for a ${sessionDuration}-min session. Tap to start.`,
        data: {
          type:       "session_paid",
          roomId:     existingLink._id.toString(),
          sessionId:  sess._id.toString(),
          studentUid: payment.userId,
          durationMinutes: String(sessionDuration),
          screen:     "chat",
        },
      }).catch(() => {});
    }

    console.log(`[Payment] Session created: ${sess._id} duration=${sessionDuration}min fee=${sess.sessionFee} commission=${commissionRate}% soulteeEarnings=${soulteeEarnings} soultee=${payment.soulteeId}`);
  } catch (err) {
    console.error("[activateSubscription] Session create error:", err.message);
  }

  const expiryStr = expiryDate.toLocaleString("en-US", {
    day: "numeric", month: "long", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
  const isCos = payment.method === "cos";
  sendPushNotification(payment.userId, {
    title: isCos ? "✅ Cash on Service Verified" : "✅ Session Payment Confirmed",
    body: isCos
      ? `Your Cash on Service payment has been verified. Chat access is now enabled until ${expiryStr}.`
      : `Your chat session has been unlocked until ${expiryStr}.`,
    data: {
      type: isCos ? "cos_approved" : "subscription_activated",
      soulteeId: payment.soulteeId,
      expiryDate: expiryDate.toISOString(),
      screen: "chat",
    },
  }).catch(() => {});
}

const KHALTI_SUCCESS_STATUSES = new Set(["Completed"]);
const KHALTI_FAILED_STATUSES = new Set([
  "User canceled",
  "Expired",
  "Refunded",
  "Partially Refunded",
  "Partially refunded",
]);

async function reconcileKhaltiPayment(payment) {
  if (!payment?.khaltiPidx) {
    return { status: payment?.status || "pending" };
  }

  const lookup = await verifyKhaltiPayment(payment.khaltiPidx);
  const khaltiStatus = lookup?.status;

  if (KHALTI_SUCCESS_STATUSES.has(khaltiStatus)) {
    const completedPayment = await Payment.findOneAndUpdate(
      { _id: payment._id, status: "pending" },
      {
        status: "completed",
        gatewayTransactionId: lookup.transaction_id,
        khaltiPidx: payment.khaltiPidx,
        gatewayResponse: lookup,
        verifiedAt: new Date(),
      },
      { new: true }
    );

    if (completedPayment) {
      await activateSubscription(completedPayment);
      return { status: "completed", payment: completedPayment, lookup };
    }

    return { status: "completed", payment, lookup };
  }

  if (KHALTI_FAILED_STATUSES.has(khaltiStatus)) {
    const failedPayment = await Payment.findOneAndUpdate(
      { _id: payment._id, status: "pending" },
      {
        status: "failed",
        gatewayResponse: lookup,
        verifiedAt: new Date(),
      },
      { new: true }
    );

    return { status: failedPayment?.status || payment.status, payment: failedPayment || payment, lookup };
  }

  // Keep pending for statuses like Pending/Initiated/Refunded/Partially Refunded.
  await Payment.findByIdAndUpdate(payment._id, { gatewayResponse: lookup });
  return { status: "pending", payment, lookup };
}

// ─────────────────────────────────────────────────────────────────────────────
//  INITIATION
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/payments/initiate
// Body: { userId, soulteeId, method: 'khalti'|'esewa', durationMinutes? }
// Fee is fetched from the soultee's profile — never trusted from client.
// durationMinutes overrides the soultee's default; fee is scaled per-minute.
router.post("/initiate", async (req, res) => {
  try {
    const { userId, soulteeId, method, durationMinutes: chosenDuration } = req.body;
    if (!userId || !soulteeId || !method) {
      return res.status(400).json({ message: "userId, soulteeId, and method are required" });
    }
    if (!["esewa", "khalti"].includes(method)) {
      return res.status(400).json({ message: "method must be 'esewa' or 'khalti'" });
    }

    // Fetch fee from soultee profile — client cannot manipulate this
    const soultee = await Soultee.findOne({ firebaseUid: soulteeId })
      .select("name feePerSession currency durationMinutes")
      .lean();
    if (!soultee) return res.status(404).json({ message: "Soultee not found" });

    const baseFee = Number(soultee.feePerSession ?? 0);
    if (baseFee <= 0) {
      return res.status(400).json({ message: "This Soultee has not set a consultation fee yet." });
    }

    // Scale fee proportionally if student chose a different duration
    const validDurations = [5, 10, 15, 20, 30, 45, 60, 90, 120];
    const baseDuration = Number(soultee.durationMinutes) > 0 ? Number(soultee.durationMinutes) : 60;
    const chosenNum = Number(chosenDuration);
    const resolvedDuration = validDurations.includes(chosenNum) ? chosenNum : baseDuration;
    const fee = resolvedDuration === baseDuration
      ? baseFee
      : Math.max(1, Math.round((baseFee / baseDuration) * resolvedDuration));

    const transactionUuid = crypto.randomBytes(6).toString("hex");

    const payment = await Payment.create({
      userId,
      soulteeId,
      planId:          null,
      planName:        "session",
      durationMinutes: resolvedDuration,
      amount:          fee,
      method,
      transactionUuid,
    });

    if (method === "esewa") {
      const { formAction, fields } = buildEsewaFormParams(fee, transactionUuid);
      return res.json({
        method: "esewa",
        transactionUuid,
        amount: fee,
        durationMinutes: resolvedDuration,
        currency: soultee.currency ?? "NPR",
        formUrl: `${process.env.BACKEND_URL || "http://localhost:5000"}/api/payments/esewa/form/${transactionUuid}`,
        formAction,
        fields,
      });
    }

    // Khalti
    const { pidx, paymentUrl } = await initiateKhaltiPayment({
      amount: fee,
      transactionUuid,
      planDisplayName: `${resolvedDuration}-min session with ${soultee.name}`,
    });
    await Payment.findByIdAndUpdate(payment._id, { khaltiPidx: pidx });

    return res.json({
      method: "khalti",
      transactionUuid,
      pidx,
      paymentUrl,
      amount: fee,
      durationMinutes: resolvedDuration,
      currency: soultee.currency ?? "NPR",
    });
  } catch (err) {
    console.error("[Payments Initiate]", err);
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  ESEWA  — form page + callbacks
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/payments/esewa/form/:transactionUuid
// Serves an auto-submitting HTML form that redirects the browser to eSewa
router.get("/esewa/form/:transactionUuid", async (req, res) => {
  try {
    const payment = await Payment.findOne({
      transactionUuid: req.params.transactionUuid,
      method: "esewa",
      status: "pending",
    }).lean();
    if (!payment) return res.status(404).send("<h2>Payment not found or already processed.</h2>");

    const { formAction, fields } = buildEsewaFormParams(payment.amount, payment.transactionUuid);
    const inputs = Object.entries(fields)
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${v}">`)
      .join("\n    ");

    res.setHeader("Content-Type", "text/html");
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Redirecting to eSewa...</title>
  <style>
    body { font-family: sans-serif; display: flex; align-items: center;
           justify-content: center; height: 100vh; margin: 0; background: #f0faf5; }
    .card { text-align: center; padding: 32px; background: white;
            border-radius: 16px; box-shadow: 0 4px 24px rgba(0,128,0,0.1); }
    .logo { font-size: 48px; margin-bottom: 16px; }
    p { color: #555; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">💚</div>
    <h2>Redirecting to eSewa…</h2>
    <p>Please wait while we redirect you to the payment gateway.</p>
  </div>
  <form id="esewaForm" method="POST" action="${formAction}">
    ${inputs}
  </form>
  <script>document.getElementById('esewaForm').submit();</script>
</body>
</html>`);
  } catch (err) {
    res.status(500).send(`<h2>Error: ${err.message}</h2>`);
  }
});

// GET /api/payments/esewa/success?data=<base64>
router.get("/esewa/success", async (req, res) => {
  try {
    const { data } = req.query;
    if (!data) return _esewaResultPage(res, false, "Missing payment data.");

    const { valid, data: decoded } = verifyEsewaCallback(data);
    if (!valid || decoded?.status !== "COMPLETE") {
      return _esewaResultPage(res, false, "Payment verification failed.");
    }

    const payment = await Payment.findOneAndUpdate(
      { transactionUuid: decoded.transaction_uuid, status: "pending" },
      {
        status: "completed",
        gatewayTransactionId: decoded.transaction_code,
        gatewayResponse: decoded,
        verifiedAt: new Date(),
      },
      { new: true }
    );

    if (!payment) return _esewaResultPage(res, false, "Payment already processed.");

    await activateSubscription(payment);
    _esewaResultPage(res, true);
  } catch (err) {
    _esewaResultPage(res, false, err.message);
  }
});

// GET /api/payments/esewa/failure?data=<base64>
router.get("/esewa/failure", async (req, res) => {
  try {
    const { data } = req.query;
    if (data) {
      const { data: decoded } = verifyEsewaCallback(data);
      if (decoded?.transaction_uuid) {
        await Payment.findOneAndUpdate(
          { transactionUuid: decoded.transaction_uuid, status: "pending" },
          { status: "failed", gatewayResponse: decoded }
        );
      }
    }
    _esewaResultPage(res, false, "Payment was cancelled or failed.");
  } catch {
    _esewaResultPage(res, false, "Payment failed.");
  }
});

function _esewaResultPage(res, success, message = "") {
  const icon = success ? "✅" : "❌";
  const title = success ? "Payment Successful!" : "Payment Failed";
  const body = success
    ? "Your Zeewant subscription has been activated. You can now return to the app and start chatting!"
    : `Payment could not be completed. ${message} Please return to the app and try again.`;
  const bg = success ? "#f0faf5" : "#fff5f5";
  const color = success ? "#008080" : "#e53e3e";

  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>
    body { font-family: sans-serif; display: flex; align-items: center;
           justify-content: center; height: 100vh; margin: 0; background: ${bg}; }
    .card { text-align: center; padding: 40px; background: white; max-width: 400px;
            border-radius: 20px; box-shadow: 0 4px 32px rgba(0,0,0,0.08); }
    .icon { font-size: 64px; margin-bottom: 16px; }
    h2 { color: ${color}; margin: 0 0 12px; }
    p { color: #666; line-height: 1.6; }
    .note { margin-top: 24px; font-size: 13px; color: #999; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h2>${title}</h2>
    <p>${body}</p>
    <p class="note">You may close this window and return to the Zeewant app.</p>
  </div>
</body>
</html>`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  ESEWA SDK  — Trusted activation (SDK already verified on-device)
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/payments/esewa/activate
// Body: { productId, refId, totalAmount, status }
// Called after EsewaFlutterSdk onPaymentSuccess fires — the SDK has already
// confirmed the transaction with eSewa servers. We trust the SDK result and
// simply record + activate the subscription.
router.post("/esewa/activate", async (req, res) => {
  try {
    const { productId, refId, totalAmount, status } = req.body;

    if (!productId || !refId) {
      return res.status(400).json({ message: "productId and refId are required" });
    }

    if (status !== "COMPLETE") {
      return res.status(400).json({
        message: `eSewa payment status is not COMPLETE: ${status}`,
      });
    }

    const payment = await Payment.findOneAndUpdate(
      { transactionUuid: productId, status: "pending" },
      {
        status: "completed",
        gatewayTransactionId: refId,
        gatewayResponse: { productId, refId, totalAmount, status },
        verifiedAt: new Date(),
      },
      { new: true }
    );

    if (!payment) {
      // Already processed (duplicate callback) — return success
      return res.json({ success: true, message: "Already activated" });
    }

    await activateSubscription(payment);
    res.json({ success: true, message: "Subscription activated" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  ESEWA SDK  — Legacy server-side verification (kept for reference)
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/payments/esewa/sdk-verify
// Body: { productId (= our transactionUuid), refId, totalAmount }
// Called by the Flutter app after EsewaFlutterSdk.initPayment() onPaymentSuccess fires.
//
// eSewa verification API (Method 1 — by refId):
//   GET https://rc.esewa.com.np/mobile/transaction?txnRefId={refId}   (test)
//   GET https://esewa.com.np/mobile/transaction?txnRefId={refId}       (live)
//
// Success response (array):
//   [{ code: "00", transactionDetails: { status: "COMPLETE", referenceId, date } }]
router.post("/esewa/sdk-verify", async (req, res) => {
  try {
    const { productId, refId, totalAmount } = req.body;
    if (!productId || !refId) {
      return res.status(400).json({ message: "productId and refId are required" });
    }

    // "rc-epay" is present only in the test URL; the live URL is just "epay.esewa.com.np"
    const isTest = (process.env.ESEWA_BASE_URL || "").includes("rc-epay");
    const verifyBase = isTest ? "https://rc.esewa.com.np" : "https://esewa.com.np";

    // Method 1: verify by refId (referenceId from SDK success result)
    const verifyUrl = `${verifyBase}/mobile/transaction?txnRefId=${encodeURIComponent(refId)}`;
    const verifyRes = await fetch(verifyUrl);

    if (!verifyRes.ok) {
      return res.status(400).json({ message: `eSewa verification call failed (${verifyRes.status})` });
    }

    // Response is always an array
    const verifyData = await verifyRes.json();
    const entry = Array.isArray(verifyData) ? verifyData[0] : verifyData;
    const txnDetails = entry?.transactionDetails;
    const code = entry?.code;

    // Require both status COMPLETE AND code "00"
    if (txnDetails?.status !== "COMPLETE" || code !== "00") {
      return res.status(400).json({
        message: "Transaction verification failed",
        status: txnDetails?.status,
        code,
      });
    }

    // Mark payment complete and activate subscription
    const payment = await Payment.findOneAndUpdate(
      { transactionUuid: productId, status: "pending" },
      {
        status: "completed",
        gatewayTransactionId: refId,
        gatewayResponse: entry,
        verifiedAt: new Date(),
      },
      { new: true }
    );

    if (!payment) {
      // Already processed (duplicate callback) — still return success
      return res.json({ success: true, message: "Already activated" });
    }

    await activateSubscription(payment);
    res.json({ success: true, message: "Subscription activated" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  KHALTI  — callback
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/payments/khalti/callback?pidx=...&status=...&purchase_order_id=...
router.get("/khalti/callback", async (req, res) => {
  try {
    const { pidx, purchase_order_id: transactionUuid } = req.query;
    if (!pidx) {
      return _khaltiResultPage(res, false, "Missing pidx in Khalti callback.");
    }

    const payment = await Payment.findOne({
      $or: [{ transactionUuid }, { khaltiPidx: pidx }],
      method: "khalti",
    });

    if (!payment) {
      return _khaltiResultPage(res, false, "Payment record not found.");
    }

    if (!payment.khaltiPidx) {
      await Payment.findByIdAndUpdate(payment._id, { khaltiPidx: pidx, gatewayResponse: req.query });
      payment.khaltiPidx = pidx;
    }

    if (payment.status === "completed") {
      return _khaltiResultPage(res, true);
    }

    const result = await reconcileKhaltiPayment(payment);

    if (result.status === "completed") {
      return _khaltiResultPage(res, true);
    }

    if (result.status === "failed") {
      return _khaltiResultPage(res, false, "Payment was cancelled, expired, or not completed.");
    }

    return _khaltiResultPage(
      res,
      false,
      "Payment is pending confirmation. Please return to app and wait for final status."
    );
  } catch (err) {
    _khaltiResultPage(res, false, err.message);
  }
});

function _khaltiResultPage(res, success, message = "") {
  return _esewaResultPage(res, success, message); // same template
}

// ─────────────────────────────────────────────────────────────────────────────
//  POLLING
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/payments/verify/:transactionUuid
// App polls this after opening payment URL to detect completion
router.get("/verify/:transactionUuid", async (req, res) => {
  try {
    let payment = await Payment.findOne({
      transactionUuid: req.params.transactionUuid,
    });

    if (!payment) return res.status(404).json({ message: "Payment not found" });

    if (payment.method === "khalti" && payment.status === "pending" && payment.khaltiPidx) {
      const result = await reconcileKhaltiPayment(payment);
      payment = (result.payment || payment);
      payment.status = result.status;
    }

    res.json({
      transactionUuid: payment.transactionUuid,
      status: payment.status,
      method: payment.method,
      amount: payment.amount,
      planName: payment.planName,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  ESEWA — Recovery: re-verify a pending payment using eSewa API
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/payments/esewa/recover
// Body: { transactionUuid }
// Called from the Flutter "Check My Payment" button on the failure screen.
// Verifies the pending payment with eSewa using Method 2 (productId + amount)
// and activates the subscription if COMPLETE.
router.post("/esewa/recover", async (req, res) => {
  try {
    const { transactionUuid } = req.body;
    if (!transactionUuid) {
      return res.status(400).json({ message: "transactionUuid is required" });
    }

    const payment = await Payment.findOne({
      transactionUuid,
      method: "esewa",
      status: "pending",
    });

    if (!payment) {
      // Check if already completed — return success so Flutter unblocks
      const done = await Payment.findOne({ transactionUuid, status: "completed" });
      if (done) return res.json({ success: true, message: "Already activated" });
      return res.status(404).json({ message: "Payment not found" });
    }

    // Verify with eSewa using Method 2: productId + amount
    const isTest = (process.env.ESEWA_BASE_URL || "").includes("rc-epay");
    const verifyBase = isTest ? "https://rc.esewa.com.np" : "https://esewa.com.np";
    const url = `${verifyBase}/mobile/transaction?productId=${encodeURIComponent(transactionUuid)}&amount=${payment.amount}`;

    const verifyRes = await fetch(url);

    if (!verifyRes.ok) {
      return res.status(400).json({
        message: `eSewa verification failed (${verifyRes.status}). If money was deducted contact support.`,
      });
    }

    const verifyData = await verifyRes.json();
    const entry = Array.isArray(verifyData) ? verifyData[0] : verifyData;
    const txnDetails = entry?.transactionDetails;

    if (txnDetails?.status !== "COMPLETE" || entry?.code !== "00") {
      return res.status(400).json({
        message: "eSewa payment not confirmed as COMPLETE.",
        status: txnDetails?.status,
      });
    }

    const updated = await Payment.findOneAndUpdate(
      { transactionUuid, status: "pending" },
      {
        status: "completed",
        gatewayTransactionId: txnDetails.referenceId || "",
        gatewayResponse: entry,
        verifiedAt: new Date(),
      },
      { new: true }
    );

    if (!updated) {
      return res.json({ success: true, message: "Already activated" });
    }

    await activateSubscription(updated);
    res.json({ success: true, message: "Subscription activated via recovery" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  DEBUG — create session for already-completed payments that missed it
//  POST /api/payments/fix-sessions
//  Body: { soulteeId }   — creates upcoming sessions for all completed payments missing a session
// ─────────────────────────────────────────────────────────────────────────────
router.post("/fix-sessions", async (req, res) => {
  try {
    const { soulteeId } = req.body;
    if (!soulteeId) return res.status(400).json({ message: "soulteeId required" });

    const payments = await Payment.find({ soulteeId, status: "completed" }).lean();
    let created = 0;

    for (const payment of payments) {
      const existing = await Session.findOne({
        soulteeFirebaseUid: payment.soulteeId,
        studentFirebaseUid: payment.userId,
        sessionFee: payment.amount,
      });
      if (!existing) {
        const syncLink = await StudentSoulteeLink.findOne({
          soulteeFirebaseUid: payment.soulteeId,
          studentFirebaseUid: payment.userId,
        }).lean().catch(() => null);
        await Session.create({
          soulteeFirebaseUid: payment.soulteeId,
          studentFirebaseUid: payment.userId,
          studentName:  syncLink?.studentName || "Student",
          scheduledAt:  payment.createdAt || new Date(),
          durationMinutes: 30,
          sessionFee:   payment.amount,
          sessionType:  "chat",
          status:       "upcoming",
        });
        created++;
      }
    }

    res.json({ message: `Fixed: ${created} sessions created out of ${payments.length} payments`, created });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  CASH ON SERVICE (COS)
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/payments/cos
// Body: { userId, soulteeId, durationMinutes? }
router.post("/cos", async (req, res) => {
  try {
    const { userId, soulteeId, durationMinutes: chosenDuration } = req.body;
    if (!userId || !soulteeId) {
      return res.status(400).json({ message: "userId and soulteeId are required" });
    }

    const soultee = await Soultee.findOne({ firebaseUid: soulteeId })
      .select("name feePerSession currency durationMinutes")
      .lean();
    if (!soultee) return res.status(404).json({ message: "Soultee not found" });

    const baseFee = Number(soultee.feePerSession ?? 0);
    if (baseFee <= 0) {
      return res.status(400).json({ message: "This Soultee has not set a consultation fee yet." });
    }

    const validDurations = [5, 10, 15, 20, 30, 45, 60, 90, 120];
    const baseDuration = Number(soultee.durationMinutes) > 0 ? Number(soultee.durationMinutes) : 60;
    const chosenNum = Number(chosenDuration);
    const resolvedDuration = validDurations.includes(chosenNum) ? chosenNum : baseDuration;
    const fee = resolvedDuration === baseDuration
      ? baseFee
      : Math.max(1, Math.round((baseFee / baseDuration) * resolvedDuration));

    const backendUrl = process.env.BACKEND_URL || "http://localhost:5000";

    // Return existing pending COS instead of creating a duplicate
    const existingPending = await Payment.findOne({
      userId,
      soulteeId,
      method: "cos",
      verificationStatus: "pending_verification",
    }).lean();
    if (existingPending) {
      return res.json({
        success:         true,
        transactionUuid: existingPending.transactionUuid,
        amount:          existingPending.amount,
        durationMinutes: existingPending.durationMinutes ?? resolvedDuration,
        currency:        soultee.currency ?? "NPR",
        invoiceUrl:      `${backendUrl}/api/payments/invoice/${existingPending.transactionUuid}`,
        message:         "You already have a pending Cash on Service request.",
        isExisting:      true,
      });
    }

    const transactionUuid = crypto.randomBytes(6).toString("hex");

    await Payment.create({
      userId,
      soulteeId,
      planId:          null,
      planName:        "session",
      durationMinutes: resolvedDuration,
      amount:          fee,
      method:          "cos",
      transactionUuid,
      paymentStatus:      "pending",
      verificationStatus: "pending_verification",
    });

    return res.json({
      success:         true,
      transactionUuid,
      amount:          fee,
      durationMinutes: resolvedDuration,
      currency:        soultee.currency ?? "NPR",
      invoiceUrl:      `${backendUrl}/api/payments/invoice/${transactionUuid}`,
      message:         "Your Cash on Service request has been submitted successfully.",
      isExisting:      false,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/payments/upload-proof
// Body: { transactionUuid, proofUrl, fileType }
// Student uploads Firebase Storage URL of payment proof screenshot/voucher
router.post("/upload-proof", async (req, res) => {
  try {
    const { transactionUuid, proofUrl, fileType } = req.body;
    if (!transactionUuid || !proofUrl) {
      return res.status(400).json({ message: "transactionUuid and proofUrl are required" });
    }

    const payment = await Payment.findOne({ transactionUuid });
    if (!payment) return res.status(404).json({ message: "Payment not found" });

    payment.proofUpload = {
      url:        proofUrl,
      uploadedAt: new Date(),
      fileType:   fileType || "image",
    };
    await payment.save();

    return res.json({ success: true, message: "Proof uploaded successfully." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/payments/verify-cos
// Body: { transactionUuid, action: 'approve'|'reject', reason? }
// Admin-only: approve or reject a pending COS request
router.post("/verify-cos", requireAdminJwt, async (req, res) => {
  try {
    const { transactionUuid, action, reason } = req.body;
    if (!transactionUuid || !["approve", "reject"].includes(action)) {
      return res.status(400).json({ message: "transactionUuid and action (approve|reject) are required" });
    }

    const payment = await Payment.findOne({ transactionUuid, method: "cos" });
    if (!payment) return res.status(404).json({ message: "COS payment not found" });
    if (payment.status === "completed") {
      return res.json({ success: true, message: "Already approved" });
    }

    if (action === "approve") {
      const updated = await Payment.findOneAndUpdate(
        { transactionUuid, method: "cos" },
        {
          status:             "completed",
          paymentStatus:      "approved",
          verificationStatus: "verified",
          approvedBy:         req.admin.username || req.admin.id || "admin",
          approvedAt:         new Date(),
          verifiedAt:         new Date(),
        },
        { new: true }
      );
      await activateSubscription(updated);
      return res.json({ success: true, message: "COS payment approved and subscription activated." });
    }

    await Payment.findOneAndUpdate(
      { transactionUuid, method: "cos" },
      {
        status:             "failed",
        paymentStatus:      "rejected",
        verificationStatus: "rejected",
        rejectionReason:    reason || "Payment verification failed",
      }
    );
    sendPushNotification(payment.userId, {
      title: "Payment Update",
      body: reason
        ? `Your Cash on Service payment was rejected. Reason: ${reason}`
        : "Your Cash on Service payment was rejected. Please re-upload a valid proof.",
      data: { type: "cos_rejected", transactionUuid, screen: "cos_status" },
    }).catch(() => {});
    return res.json({ success: true, message: "COS payment rejected." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/payments/pending-cos?status=pending|approved|rejected&page=1&limit=20
// Admin-only: list COS requests
router.get("/pending-cos", requireAdminJwt, async (req, res) => {
  try {
    const { status = "all", page = "1", limit = "20" } = req.query;
    const pageNum  = Math.max(1, parseInt(page, 10)  || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));

    const filter = { method: "cos" };
    if (status === "pending")  filter.verificationStatus = "pending_verification";
    else if (status === "approved") filter.verificationStatus = "verified";
    else if (status === "rejected") filter.verificationStatus = "rejected";

    const [total, payments] = await Promise.all([
      Payment.countDocuments(filter),
      Payment.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
    ]);

    return res.json({ success: true, total, payments });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/payments/esewa/:transactionUuid — Admin hard-delete an eSewa record
router.delete("/esewa/:transactionUuid", requireAdminJwt, async (req, res) => {
  try {
    const payment = await Payment.findOneAndDelete({
      transactionUuid: req.params.transactionUuid,
      method: "esewa",
    });
    if (!payment) return res.status(404).json({ message: "eSewa payment not found." });
    return res.json({ success: true, message: "eSewa record deleted." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/payments/khalti/:transactionUuid — Admin hard-delete a Khalti record
router.delete("/khalti/:transactionUuid", requireAdminJwt, async (req, res) => {
  try {
    const payment = await Payment.findOneAndDelete({
      transactionUuid: req.params.transactionUuid,
      method: "khalti",
    });
    if (!payment) return res.status(404).json({ message: "Khalti payment not found." });
    return res.json({ success: true, message: "Khalti record deleted." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/payments/cos/:transactionUuid — Admin hard-delete a COS record
router.delete("/cos/:transactionUuid", requireAdminJwt, async (req, res) => {
  try {
    const payment = await Payment.findOneAndDelete({
      transactionUuid: req.params.transactionUuid,
      method: "cos",
    });
    if (!payment) return res.status(404).json({ message: "COS payment not found." });

    return res.json({ success: true, message: "COS record deleted." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/payments/pending-cos-check?userId=&soulteeId=
// Student polls this to check if they have a pending COS request (before opening payment gate)
router.get("/pending-cos-check", async (req, res) => {
  try {
    const { userId, soulteeId } = req.query;
    if (!userId || !soulteeId) {
      return res.status(400).json({ message: "userId and soulteeId are required" });
    }
    const backendUrl = process.env.BACKEND_URL || "http://localhost:5000";
    const payment = await Payment.findOne({
      userId,
      soulteeId,
      method: "cos",
      verificationStatus: "pending_verification",
    }).lean();

    if (!payment) {
      return res.json({ hasPending: false });
    }

    return res.json({
      hasPending: true,
      transactionUuid: payment.transactionUuid,
      amount: payment.amount,
      invoiceUrl: `${backendUrl}/api/payments/invoice/${payment.transactionUuid}`,
      createdAt: payment.createdAt,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/payments/cos-status/:transactionUuid
// Returns current COS verification status for the student's polling.
router.get("/cos-status/:transactionUuid", async (req, res) => {
  try {
    const payment = await Payment.findOne({
      transactionUuid: req.params.transactionUuid,
    }).lean();
    if (!payment) return res.status(404).json({ message: "Payment not found" });

    return res.json({
      status:             payment.status,
      verificationStatus: payment.verificationStatus,
      paymentStatus:      payment.paymentStatus,
      rejectionReason:    payment.rejectionReason || null,
      approvedAt:         payment.approvedAt || null,
      proofUploaded:      !!payment.proofUpload?.url,
      amount:             payment.amount,
      durationMinutes:    payment.durationMinutes ?? null,
      method:             payment.method,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  STATEMENTS  (JSON data for download/display)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/payments/statements/esewa?userId=...&start=...&end=...&page=1&limit=50
router.get("/statements/esewa", async (req, res) => {
  try {
    const { userId, start, end, page = "1", limit = "50" } = req.query;
    const filter = { method: "esewa" };
    if (userId) filter.userId = userId;
    if (start || end) {
      filter.createdAt = {};
      if (start) filter.createdAt.$gte = new Date(start);
      if (end)   filter.createdAt.$lte = new Date(end);
    }
    const pageNum  = Math.max(1, parseInt(page,  10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

    const [total, payments, successCount, failCount, revPipe] = await Promise.all([
      Payment.countDocuments(filter),
      Payment.find(filter).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum).lean(),
      Payment.countDocuments({ ...filter, status: "completed" }),
      Payment.countDocuments({ ...filter, status: "failed" }),
      Payment.aggregate([{ $match: { ...filter, status: "completed" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
    ]);

    return res.json({
      method: "esewa",
      summary: { total, successful: successCount, failed: failCount, pending: total - successCount - failCount, revenue: revPipe[0]?.total ?? 0 },
      payments: payments.map((p) => ({
        id: p._id, transactionUuid: p.transactionUuid, gatewayTransactionId: p.gatewayTransactionId,
        amount: p.amount, status: p.status, userId: p.userId, soulteeId: p.soulteeId,
        createdAt: p.createdAt, verifiedAt: p.verifiedAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/payments/statements/khalti
router.get("/statements/khalti", async (req, res) => {
  try {
    const { userId, start, end, page = "1", limit = "50" } = req.query;
    const filter = { method: "khalti" };
    if (userId) filter.userId = userId;
    if (start || end) {
      filter.createdAt = {};
      if (start) filter.createdAt.$gte = new Date(start);
      if (end)   filter.createdAt.$lte = new Date(end);
    }
    const pageNum  = Math.max(1, parseInt(page,  10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

    const [total, payments, successCount, failCount, revPipe] = await Promise.all([
      Payment.countDocuments(filter),
      Payment.find(filter).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum).lean(),
      Payment.countDocuments({ ...filter, status: "completed" }),
      Payment.countDocuments({ ...filter, status: "failed" }),
      Payment.aggregate([{ $match: { ...filter, status: "completed" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
    ]);

    return res.json({
      method: "khalti",
      summary: { total, successful: successCount, failed: failCount, pending: total - successCount - failCount, revenue: revPipe[0]?.total ?? 0 },
      payments: payments.map((p) => ({
        id: p._id, transactionUuid: p.transactionUuid, gatewayTransactionId: p.gatewayTransactionId,
        khaltiPidx: p.khaltiPidx, amount: p.amount, status: p.status, userId: p.userId, soulteeId: p.soulteeId,
        createdAt: p.createdAt, verifiedAt: p.verifiedAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/payments/statements/cos
router.get("/statements/cos", async (req, res) => {
  try {
    const { userId, start, end, page = "1", limit = "50" } = req.query;
    const filter = { method: "cos" };
    if (userId) filter.userId = userId;
    if (start || end) {
      filter.createdAt = {};
      if (start) filter.createdAt.$gte = new Date(start);
      if (end)   filter.createdAt.$lte = new Date(end);
    }
    const pageNum  = Math.max(1, parseInt(page,  10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

    const [total, payments, revPipe] = await Promise.all([
      Payment.countDocuments(filter),
      Payment.find(filter).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum).lean(),
      Payment.aggregate([{ $match: { ...filter, status: "completed" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
    ]);

    const pending  = payments.filter((p) => p.verificationStatus === "pending_verification").length;
    const approved = payments.filter((p) => p.verificationStatus === "verified").length;
    const rejected = payments.filter((p) => p.verificationStatus === "rejected").length;

    return res.json({
      method: "cos",
      summary: { total, pending, approved, rejected, revenue: revPipe[0]?.total ?? 0 },
      payments: payments.map((p) => ({
        id: p._id, transactionUuid: p.transactionUuid, amount: p.amount, status: p.status,
        paymentStatus: p.paymentStatus, verificationStatus: p.verificationStatus,
        userId: p.userId, soulteeId: p.soulteeId, proofUploaded: !!p.proofUpload?.url,
        proofUrl: p.proofUpload?.url || null, approvedBy: p.approvedBy, approvedAt: p.approvedAt,
        rejectionReason: p.rejectionReason, createdAt: p.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/payments/my-payments/:userId
// Student's payment history (last 50)
router.get("/my-payments/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ message: "userId required" });

    const payments = await Payment.find({ userId }).sort({ createdAt: -1 }).limit(50).lean();
    const backendUrl = process.env.BACKEND_URL || "http://localhost:5000";

    return res.json({
      userId,
      payments: payments.map((p) => ({
        id:                 p._id,
        transactionUuid:    p.transactionUuid,
        amount:             p.amount,
        method:             p.method,
        status:             p.status,
        paymentStatus:      p.paymentStatus,
        verificationStatus: p.verificationStatus,
        planName:           p.planName,
        rejectionReason:    p.rejectionReason,
        approvedAt:         p.approvedAt,
        createdAt:          p.createdAt,
        invoiceUrl:  `${backendUrl}/api/payments/invoice/${p.transactionUuid}`,
        receiptUrl:  p.status === "completed"
          ? `${backendUrl}/api/payments/receipt/${p.transactionUuid}`
          : null,
      })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  INVOICE  (printable HTML)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/payments/invoice/:transactionUuid  — downloads as PDF
router.get("/invoice/:transactionUuid", async (req, res) => {
  try {
    const payment = await Payment.findOne({ transactionUuid: req.params.transactionUuid }).lean();
    if (!payment) return res.status(404).json({ message: "Invoice not found." });

    const soultee = await Soultee.findOne({ firebaseUid: payment.soulteeId }).select("name").lean();
    const date    = new Date(payment.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const methodLabel = payment.method === "esewa" ? "eSewa" : payment.method === "khalti" ? "Khalti" : "Cash on Service";
    const statusLabel = payment.status === "completed" ? "PAID" : payment.status === "failed" ? "FAILED" : "PENDING";
    const txnId = payment.transactionUuid.toUpperCase();

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="invoice-${txnId}.pdf"`);
    doc.pipe(res);

    // ── Header bar ──
    doc.rect(0, 0, doc.page.width, 90).fill("#008080");
    doc.fillColor("#ffffff").fontSize(26).font("Helvetica-Bold").text("ZEEWANT", 50, 28);
    doc.fontSize(11).font("Helvetica").text("Payment Invoice", 50, 58);
    doc.fillColor("#2d3748");

    // ── Invoice title + ID ──
    doc.moveDown(3);
    doc.fontSize(13).font("Helvetica-Bold").fillColor("#008080").text("INVOICE", 50, 110);
    doc.fontSize(10).font("Helvetica").fillColor("#718096").text(`#${txnId}`, 50, 127);

    // ── Divider ──
    doc.moveTo(50, 148).lineTo(545, 148).strokeColor("#e2e8f0").lineWidth(1).stroke();

    // ── Helper: row ──
    const row = (label, value, y) => {
      doc.fontSize(10).font("Helvetica").fillColor("#718096").text(label, 50, y);
      doc.fontSize(10).font("Helvetica-Bold").fillColor("#2d3748").text(value, 250, y, { width: 295, align: "right" });
    };

    let y = 162;
    doc.fontSize(11).font("Helvetica-Bold").fillColor("#2d3748").text("Invoice Details", 50, y); y += 20;
    row("Invoice No.",     `#${txnId}`,                  y); y += 18;
    row("Date",            date,                          y); y += 18;
    row("Payment Method",  methodLabel,                   y); y += 18;
    row("Status",          statusLabel,                   y); y += 18;
    if (payment.gatewayTransactionId) {
      row("Gateway Ref",   payment.gatewayTransactionId,  y); y += 18;
    }

    y += 10;
    doc.moveTo(50, y).lineTo(545, y).strokeColor("#edf2f7").stroke(); y += 16;

    doc.fontSize(11).font("Helvetica-Bold").fillColor("#2d3748").text("Session Details", 50, y); y += 20;
    row("Service",    "Consultation Session",               y); y += 18;
    row("Counselor",  soultee?.name || "Zeewant Soultee",   y); y += 18;
    row("Plan",       payment.planName || "Session",        y); y += 18;

    y += 16;
    // ── Amount box ──
    doc.rect(50, y, 495, 54).fill("#f0faf5");
    doc.fontSize(13).font("Helvetica-Bold").fillColor("#2d3748").text("Total Amount", 70, y + 18);
    doc.fontSize(22).font("Helvetica-Bold").fillColor("#008080").text(`NPR ${payment.amount}`, 70, y + 12, { width: 455, align: "right" });

    y += 80;
    doc.moveTo(50, y).lineTo(545, y).strokeColor("#edf2f7").stroke(); y += 14;
    doc.fontSize(9).font("Helvetica").fillColor("#a0aec0")
       .text("This invoice is generated by Zeewant  •  Simraungadh Office, Bara, Nepal", 50, y, { align: "center", width: 495 });

    doc.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  RECEIPT  (printable HTML — only for completed payments)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/payments/receipt/:transactionUuid  — downloads as PDF
router.get("/receipt/:transactionUuid", async (req, res) => {
  try {
    const payment = await Payment.findOne({ transactionUuid: req.params.transactionUuid, status: "completed" }).lean();
    if (!payment) return res.status(404).json({ message: "Receipt not found or payment not completed." });

    const soultee = await Soultee.findOne({ firebaseUid: payment.soulteeId }).select("name").lean();
    const date = new Date(payment.verifiedAt || payment.updatedAt).toLocaleDateString("en-US", {
      year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
    const methodLabel = payment.method === "esewa" ? "eSewa" : payment.method === "khalti" ? "Khalti" : "Cash on Service";
    const txnId = payment.transactionUuid.toUpperCase();

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="receipt-${txnId}.pdf"`);
    doc.pipe(res);

    // ── Header bar ──
    doc.rect(0, 0, doc.page.width, 100).fill("#008080");
    doc.fillColor("#ffffff").fontSize(22).font("Helvetica-Bold").text("Payment Successful", 50, 26, { align: "center", width: 495 });
    doc.fontSize(11).font("Helvetica").text("Official Receipt — Zeewant", 50, 54, { align: "center", width: 495 });
    doc.fillColor("#2d3748");

    // ── Amount ──
    doc.moveDown(4.5);
    doc.fontSize(36).font("Helvetica-Bold").fillColor("#008080")
       .text(`NPR ${payment.amount}`, 50, 122, { align: "center", width: 495 });

    // ── Dashed divider ──
    doc.moveTo(50, 172).lineTo(545, 172).dash(4, { space: 4 }).strokeColor("#e2e8f0").lineWidth(1).stroke();
    doc.undash();

    // ── Helper: row ──
    const row = (label, value, y) => {
      doc.fontSize(10).font("Helvetica").fillColor("#718096").text(label, 50, y);
      doc.fontSize(10).font("Helvetica-Bold").fillColor("#2d3748").text(value, 250, y, { width: 295, align: "right" });
    };

    let y = 186;
    row("Receipt No.",   `#${txnId}`,                       y); y += 20;
    row("Date & Time",   date,                               y); y += 20;
    row("Payment Via",   methodLabel,                        y); y += 20;
    if (payment.gatewayTransactionId) {
      row("Transaction ID", payment.gatewayTransactionId,   y); y += 20;
    }
    row("Counselor",     soultee?.name || "Zeewant Soultee", y); y += 20;
    row("Service",       "Consultation Session",             y); y += 20;

    // ── Dashed divider ──
    doc.moveTo(50, y + 4).lineTo(545, y + 4).dash(4, { space: 4 }).strokeColor("#e2e8f0").lineWidth(1).stroke();
    doc.undash();
    y += 18;

    // ── PAID badge ──
    doc.fontSize(11).font("Helvetica-Bold").fillColor("#718096").text("Status", 50, y);
    doc.fontSize(11).font("Helvetica-Bold").fillColor("#008080").text("PAID", 250, y, { width: 295, align: "right" });

    y += 40;
    doc.moveTo(50, y).lineTo(545, y).strokeColor("#edf2f7").lineWidth(1).stroke(); y += 14;
    doc.fontSize(9).font("Helvetica").fillColor("#a0aec0")
       .text("Thank you for using Zeewant  •  Simraungadh Office, Bara, Nepal", 50, y, { align: "center", width: 495 });

    doc.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  SESSION COMPLETION REPORT
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/payments/reports/session/:sessionId
router.get("/reports/session/:sessionId", async (req, res) => {
  try {
    const session = await Session.findById(req.params.sessionId).lean();
    if (!session) return res.status(404).json({ message: "Session not found" });

    const [payment, soultee] = await Promise.all([
      Payment.findOne({ userId: session.studentFirebaseUid, soulteeId: session.soulteeFirebaseUid })
        .sort({ createdAt: -1 }).lean(),
      Soultee.findOne({ firebaseUid: session.soulteeFirebaseUid }).select("name").lean(),
    ]);

    return res.json({
      success: true,
      report: {
        sessionId:        session._id,
        studentName:      session.studentName || "Student",
        studentId:        session.studentFirebaseUid,
        counselorName:    soultee?.name || "Soultee",
        counselorId:      session.soulteeFirebaseUid,
        sessionDate:      session.scheduledAt,
        startTime:        session.startedAt || session.scheduledAt,
        endTime:          session.updatedAt,
        durationMinutes:  session.durationMinutes,
        sessionType:      session.sessionType,
        status:           session.status,
        paymentMethod:    payment?.method  || null,
        paymentStatus:    payment?.status  || null,
        amountPaid:       payment?.amount  ?? session.sessionFee,
        transactionId:    payment?.transactionUuid || null,
        commissionRate:   session.commissionRate,
        soulteeEarnings:  session.soulteeEarnings,
        platformEarnings: session.platformEarnings,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
