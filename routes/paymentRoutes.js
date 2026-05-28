import express from "express";
import crypto from "crypto";
import Payment from "../models/Payment.js";
import SubscriptionPlan from "../models/SubscriptionPlan.js";
import UserSubscription from "../models/UserSubscription.js";
import { buildEsewaFormParams, verifyEsewaCallback } from "../services/esewaService.js";
import { initiateKhaltiPayment, verifyKhaltiPayment } from "../services/khaltiService.js";

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function activateSubscription(payment) {
  const plan = await SubscriptionPlan.findById(payment.planId).lean();
  const startDate = new Date();
  const expiryDate = new Date(startDate);
  expiryDate.setDate(expiryDate.getDate() + (plan?.durationDays ?? 30));

  await UserSubscription.create({
    userId: payment.userId,
    planId: payment.planId,
    planName: payment.planName,
    paymentId: payment._id,
    transactionId: payment.gatewayTransactionId,
    paymentMethod: payment.method,
    amountPaid: payment.amount,
    status: "active",
    startDate,
    expiryDate,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  INITIATION
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/payments/initiate
// Body: { userId, planName, method: 'esewa' | 'khalti' }
// Returns payment URL / form params for the client to open
router.post("/initiate", async (req, res) => {
  try {
    const { userId, planName, method } = req.body;
    if (!userId || !planName || !method) {
      return res.status(400).json({ message: "userId, planName, and method are required" });
    }
    if (!["esewa", "khalti"].includes(method)) {
      return res.status(400).json({ message: "method must be 'esewa' or 'khalti'" });
    }

    const plan = await SubscriptionPlan.findOne({ name: planName, isActive: true }).lean();
    if (!plan) return res.status(404).json({ message: "Plan not found" });

    // eSewa productId has a length limit — use 12-char hex instead of full UUID
    const transactionUuid = crypto.randomBytes(6).toString('hex'); // e.g. "a3f9c2d1b04e"

    const payment = await Payment.create({
      userId,
      planId: plan._id,
      planName: plan.name,
      amount: plan.price,
      method,
      transactionUuid,
    });

    if (method === "esewa") {
      const { formAction, fields } = buildEsewaFormParams(plan.price, transactionUuid);
      return res.json({
        method: "esewa",
        transactionUuid,
        formUrl: `${process.env.BACKEND_URL || "http://localhost:5000"}/api/payments/esewa/form/${transactionUuid}`,
        formAction,
        fields,
      });
    }

    // Khalti
    const { pidx, paymentUrl } = await initiateKhaltiPayment({
      amount: plan.price,
      transactionUuid,
      planDisplayName: plan.displayName,
    });
    await Payment.findByIdAndUpdate(payment._id, { khaltiPidx: pidx });

    return res.json({ method: "khalti", transactionUuid, paymentUrl });
  } catch (err) {
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
//  ESEWA SDK  — Flutter SDK verification (called directly from mobile app)
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

    // Choose base URL: test if ESEWA_BASE_URL contains 'rc-epay', live otherwise
    const isTest = !(process.env.ESEWA_BASE_URL || "").includes("epay.esewa.com.np");
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
    const { pidx, status, purchase_order_id: transactionUuid } = req.query;
    if (!pidx || status !== "Completed") {
      await Payment.findOneAndUpdate(
        { transactionUuid, status: "pending" },
        { status: "failed", gatewayResponse: req.query }
      );
      return _khaltiResultPage(res, false, "Payment was cancelled or not completed.");
    }

    const lookup = await verifyKhaltiPayment(pidx);
    if (lookup.status !== "Completed") {
      return _khaltiResultPage(res, false, "Payment verification failed.");
    }

    const payment = await Payment.findOneAndUpdate(
      { transactionUuid, status: "pending" },
      {
        status: "completed",
        gatewayTransactionId: lookup.transaction_id,
        khaltiPidx: pidx,
        gatewayResponse: lookup,
        verifiedAt: new Date(),
      },
      { new: true }
    );

    if (!payment) return _khaltiResultPage(res, false, "Payment already processed.");

    await activateSubscription(payment);
    _khaltiResultPage(res, true);
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
    const payment = await Payment.findOne({
      transactionUuid: req.params.transactionUuid,
    }).lean();

    if (!payment) return res.status(404).json({ message: "Payment not found" });

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

export default router;
