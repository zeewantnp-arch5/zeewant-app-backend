import express from "express";
import crypto from "crypto";
import Payment from "../models/Payment.js";
import Soultee from "../models/Soultee.js";
import UserSubscription from "../models/UserSubscription.js";
import { buildEsewaFormParams, verifyEsewaCallback } from "../services/esewaService.js";
import { initiateKhaltiPayment, verifyKhaltiPayment } from "../services/khaltiService.js";
import { sendPushNotification } from "../services/fcmService.js";

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function activateSubscription(payment) {
  const startDate = new Date();
  const soultee = await Soultee.findOne({ firebaseUid: payment.soulteeId })
    .select("durationMinutes")
    .lean();
  const durationMinutes = Math.max(1, Number(soultee?.durationMinutes ?? 60));
  const expiryDate = new Date(startDate);
  expiryDate.setMinutes(expiryDate.getMinutes() + durationMinutes);

  await UserSubscription.create({
    userId:        payment.userId,
    soulteeId:     payment.soulteeId,
    planId:        payment.planId ?? null,       // optional — may be null for dynamic payments
    planName:      payment.planName ?? "session",
    paymentId:     payment._id,
    transactionId: payment.gatewayTransactionId,
    paymentMethod: payment.method,
    amountPaid:    payment.amount,
    status:        "active",
    startDate,
    expiryDate,
  });

  const expiryStr = expiryDate.toLocaleString("en-US", {
    day: "numeric", month: "long", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
  sendPushNotification(payment.userId, {
    title: "✅ Session Payment Confirmed",
    body: `Your chat session has been unlocked until ${expiryStr}.`,
    data: {
      type: "subscription_activated",
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
// Body: { userId, soulteeId, method: 'khalti' }
// Fee is fetched from the soultee's profile — never trusted from client.
router.post("/initiate", async (req, res) => {
  try {
    const { userId, soulteeId, method } = req.body;
    if (!userId || !soulteeId || !method) {
      return res.status(400).json({ message: "userId, soulteeId, and method are required" });
    }
    if (!["esewa", "khalti"].includes(method)) {
      return res.status(400).json({ message: "method must be 'esewa' or 'khalti'" });
    }

    // Fetch fee from soultee profile — client cannot manipulate this
    const soultee = await Soultee.findOne({ firebaseUid: soulteeId })
      .select("name feePerSession currency")
      .lean();
    if (!soultee) return res.status(404).json({ message: "Soultee not found" });

    const fee = Number(soultee.feePerSession ?? 0);
    if (fee <= 0) {
      return res.status(400).json({ message: "This Soultee has not set a consultation fee yet." });
    }

    const transactionUuid = crypto.randomBytes(6).toString("hex");

    const payment = await Payment.create({
      userId,
      soulteeId,
      planId:   null,
      planName: "session",
      amount:   fee,
      method,
      transactionUuid,
    });

    if (method === "esewa") {
      const { formAction, fields } = buildEsewaFormParams(fee, transactionUuid);
      return res.json({
        method: "esewa",
        transactionUuid,
        amount: fee,
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
      planDisplayName: `Session with ${soultee.name}`,
    });
    await Payment.findByIdAndUpdate(payment._id, { khaltiPidx: pidx });

    return res.json({
      method: "khalti",
      transactionUuid,
      paymentUrl,
      amount: fee,
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
    const isTest = !(process.env.ESEWA_BASE_URL || "").includes("epay.esewa.com.np");
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

export default router;
