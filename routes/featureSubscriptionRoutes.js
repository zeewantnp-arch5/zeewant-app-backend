import express from "express";
import crypto from "crypto";
import FeaturePayment from "../models/FeaturePayment.js";
import FeatureSubscription from "../models/FeatureSubscription.js";
import {
  FEATURE_PRICING,
  getOrInitFeatureAccess,
  activateFeatureSubscription,
  listFeatureSubscriptions,
  getFeatureRevenueStats,
} from "../services/featureSubscriptionService.js";
import { initiateKhaltiPayment, verifyKhaltiPayment } from "../services/khaltiService.js";

const router = express.Router();

const ESEWA_MERCHANT_CODE = process.env.ESEWA_MERCHANT_CODE || "EPAYTEST";
const ESEWA_SECRET        = process.env.ESEWA_SECRET        || "8gBm/:&EnhH.1/q";
const ESEWA_BASE_URL      = process.env.ESEWA_BASE_URL      || "https://rc-epay.esewa.com.np";
const BACKEND_URL         = (
  process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:5000"
).replace(/\/+$/, "");

const VALID_FEATURES = new Set(["soulway", "souljar"]);

// ── Helpers ───────────────────────────────────────────────────────────────────
function esewaSign(totalAmount, transactionUuid) {
  const msg = `total_amount=${totalAmount},transaction_uuid=${transactionUuid},product_code=${ESEWA_MERCHANT_CODE}`;
  return crypto.createHmac("sha256", ESEWA_SECRET).update(msg).digest("base64");
}

function verifyEsewaCallback(base64Data) {
  try {
    const decoded = JSON.parse(Buffer.from(base64Data, "base64").toString("utf8"));
    const { signed_field_names, signature } = decoded;
    const msg = signed_field_names.split(",").map((f) => `${f}=${decoded[f]}`).join(",");
    const expected = crypto.createHmac("sha256", ESEWA_SECRET).update(msg).digest("base64");
    return { valid: expected === signature, data: decoded };
  } catch {
    return { valid: false, data: null };
  }
}

const KHALTI_SUCCESS = new Set(["Completed"]);
const KHALTI_FAILED  = new Set(["User canceled", "Expired", "Refunded", "Partially Refunded", "Partially refunded"]);

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/feature-subscriptions/status/:userId/:feature
//  Returns access status. Auto-creates trial on first call.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/status/:userId/:feature", async (req, res) => {
  const { userId, feature } = req.params;
  if (!VALID_FEATURES.has(feature))
    return res.status(400).json({ message: "Invalid feature. Use 'soulway' or 'souljar'." });
  try {
    const access = await getOrInitFeatureAccess(userId, feature);
    res.json({ ...access, feature, userId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/feature-subscriptions/dashboard/:userId
//  Returns access for both features in one call (for dashboard display).
// ─────────────────────────────────────────────────────────────────────────────
router.get("/dashboard/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    const [soulway, souljar] = await Promise.all([
      getOrInitFeatureAccess(userId, "soulway"),
      getOrInitFeatureAccess(userId, "souljar"),
    ]);
    // Recent payments for payment history
    const payments = await FeaturePayment.find({ userId, status: "completed" })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    res.json({ soulway, souljar, payments });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/feature-subscriptions/payment/initiate
//  Body: { userId, feature, method }
//  Returns: { transactionId, paymentUrl } for Khalti
//           { transactionId, formUrl }    for eSewa
// ─────────────────────────────────────────────────────────────────────────────
router.post("/payment/initiate", async (req, res) => {
  const { userId, feature, method } = req.body;

  if (!userId || !feature || !method)
    return res.status(400).json({ message: "userId, feature, and method are required." });
  if (!VALID_FEATURES.has(feature))
    return res.status(400).json({ message: "Invalid feature." });
  if (!["esewa", "khalti"].includes(method))
    return res.status(400).json({ message: "method must be 'esewa' or 'khalti'." });

  // Server-side price — never trust client
  const amount = FEATURE_PRICING[feature];

  const transactionUuid = `FSB-${feature.toUpperCase()}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

  try {
    const payment = await FeaturePayment.create({
      userId, feature, amount, method, transactionUuid,
    });

    if (method === "khalti") {
      const featureName = feature === "soulway" ? "SoulWay" : "SoulJar";
      const { pidx, paymentUrl } = await initiateKhaltiPayment({
        amount,
        transactionUuid,
        planDisplayName: `${featureName} Monthly Plan`,
      });

      await FeaturePayment.updateOne({ _id: payment._id }, { khaltiPidx: pidx });

      return res.json({
        transactionId: transactionUuid,
        method: "khalti",
        paymentUrl,
      });
    }

    // eSewa — return form URL (backend auto-submits form)
    return res.json({
      transactionId: transactionUuid,
      method: "esewa",
      formUrl: `${BACKEND_URL}/api/feature-subscriptions/payment/esewa/form/${transactionUuid}`,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/feature-subscriptions/payment/esewa/form/:transactionUuid
//  Serves an auto-submitting HTML form to initiate eSewa payment.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/payment/esewa/form/:transactionUuid", async (req, res) => {
  const { transactionUuid } = req.params;
  const payment = await FeaturePayment.findOne({ transactionUuid, method: "esewa" }).lean();
  if (!payment) return res.status(404).send("Payment not found.");
  if (payment.status !== "pending") return res.status(400).send("Payment already processed.");

  const totalAmount = payment.amount;
  const signature   = esewaSign(totalAmount, transactionUuid);
  const successUrl  = `${BACKEND_URL}/api/feature-subscriptions/payment/esewa/success`;
  const failureUrl  = `${BACKEND_URL}/api/feature-subscriptions/payment/esewa/failure`;
  const formAction  = `${ESEWA_BASE_URL}/api/epay/main/v2/form`;

  res.send(`<!DOCTYPE html><html><body>
    <p style="font-family:sans-serif;text-align:center;margin-top:40px">
      Redirecting to eSewa…</p>
    <form id="f" method="POST" action="${formAction}">
      <input type="hidden" name="amount"                   value="${totalAmount}"/>
      <input type="hidden" name="tax_amount"               value="0"/>
      <input type="hidden" name="total_amount"             value="${totalAmount}"/>
      <input type="hidden" name="transaction_uuid"         value="${transactionUuid}"/>
      <input type="hidden" name="product_code"             value="${ESEWA_MERCHANT_CODE}"/>
      <input type="hidden" name="product_service_charge"   value="0"/>
      <input type="hidden" name="product_delivery_charge"  value="0"/>
      <input type="hidden" name="success_url"              value="${successUrl}"/>
      <input type="hidden" name="failure_url"              value="${failureUrl}"/>
      <input type="hidden" name="signed_field_names"       value="total_amount,transaction_uuid,product_code"/>
      <input type="hidden" name="signature"                value="${signature}"/>
    </form>
    <script>document.getElementById('f').submit();</script>
  </body></html>`);
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/feature-subscriptions/payment/esewa/success?data=<base64>
// ─────────────────────────────────────────────────────────────────────────────
router.get("/payment/esewa/success", async (req, res) => {
  const { data } = req.query;
  if (!data) return res.status(400).send("Missing data.");

  const { valid, data: esewaData } = verifyEsewaCallback(data);
  if (!valid) return res.status(400).send("Invalid eSewa signature.");

  const transactionUuid = esewaData.transaction_uuid;
  const payment = await FeaturePayment.findOneAndUpdate(
    { transactionUuid, status: "pending" },
    {
      status: "completed",
      gatewayTransactionId: esewaData.transaction_code,
      gatewayResponse: esewaData,
      verifiedAt: new Date(),
    },
    { new: true }
  );

  if (!payment) {
    // Already processed — just show success
    return res.send(_successPage("Payment already confirmed!"));
  }

  await activateFeatureSubscription(payment);
  res.send(_successPage("Payment successful! Your subscription is now active."));
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/feature-subscriptions/payment/esewa/failure
// ─────────────────────────────────────────────────────────────────────────────
router.get("/payment/esewa/failure", async (req, res) => {
  const { data } = req.query;
  if (data) {
    try {
      const decoded = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
      const txnId = decoded.transaction_uuid;
      if (txnId) {
        await FeaturePayment.updateOne({ transactionUuid: txnId, status: "pending" }, { status: "failed" });
      }
    } catch (_) {}
  }
  res.send(_failurePage("Payment failed or was cancelled. Please try again."));
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/feature-subscriptions/payment/khalti/callback
// ─────────────────────────────────────────────────────────────────────────────
router.get("/payment/khalti/callback", async (req, res) => {
  const { pidx, status, purchase_order_id } = req.query;

  const payment = await FeaturePayment.findOne({
    $or: [{ khaltiPidx: pidx }, { transactionUuid: purchase_order_id }],
  });

  if (!payment) return res.send(_failurePage("Payment record not found."));
  if (payment.status === "completed") return res.send(_successPage("Payment already confirmed!"));

  const lookup = await verifyKhaltiPayment(pidx || payment.khaltiPidx).catch(() => null);
  const khaltiStatus = lookup?.status;

  if (KHALTI_SUCCESS.has(khaltiStatus)) {
    const updated = await FeaturePayment.findOneAndUpdate(
      { _id: payment._id, status: "pending" },
      {
        status: "completed",
        gatewayTransactionId: lookup.transaction_id,
        gatewayResponse: lookup,
        verifiedAt: new Date(),
      },
      { new: true }
    );
    if (updated) await activateFeatureSubscription(updated);
    return res.send(_successPage("Payment successful! Your subscription is now active."));
  }

  if (KHALTI_FAILED.has(khaltiStatus)) {
    await FeaturePayment.updateOne({ _id: payment._id }, { status: "failed", gatewayResponse: lookup });
    return res.send(_failurePage("Payment was not completed. Please try again."));
  }

  res.send(_failurePage("Payment status unknown. Please contact support."));
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/feature-subscriptions/payment/verify/:transactionId
//  Flutter polls this after opening the payment URL to detect completion.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/payment/verify/:transactionId", async (req, res) => {
  const payment = await FeaturePayment.findOne({
    transactionUuid: req.params.transactionId,
  }).lean();

  if (!payment) return res.status(404).json({ message: "Payment not found." });

  // For Khalti: try to reconcile if still pending
  if (payment.status === "pending" && payment.method === "khalti" && payment.khaltiPidx) {
    try {
      const lookup = await verifyKhaltiPayment(payment.khaltiPidx);
      if (KHALTI_SUCCESS.has(lookup?.status)) {
        const updated = await FeaturePayment.findOneAndUpdate(
          { _id: payment._id, status: "pending" },
          {
            status: "completed",
            gatewayTransactionId: lookup.transaction_id,
            gatewayResponse: lookup,
            verifiedAt: new Date(),
          },
          { new: true }
        );
        if (updated) {
          await activateFeatureSubscription(updated);
          return res.json({ status: "completed", feature: payment.feature });
        }
      }
      if (KHALTI_FAILED.has(lookup?.status)) {
        await FeaturePayment.updateOne({ _id: payment._id }, { status: "failed" });
        return res.json({ status: "failed" });
      }
    } catch (_) {}
  }

  res.json({ status: payment.status, feature: payment.feature });
});

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/feature-subscriptions/admin/stats
router.get("/admin/stats", async (_req, res) => {
  try {
    const stats = await getFeatureRevenueStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/feature-subscriptions/admin/list?feature=soulway&status=active&page=1
router.get("/admin/list", async (req, res) => {
  const { feature, status, page = "1", limit = "50" } = req.query;
  try {
    const result = await listFeatureSubscriptions({
      feature: feature || null,
      status:  status  || null,
      page:    parseInt(page,  10),
      limit:   parseInt(limit, 10),
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/feature-subscriptions/admin/payments?feature=soulway&page=1
router.get("/admin/payments", async (req, res) => {
  const { feature, page = "1", limit = "50" } = req.query;
  try {
    const filter = { status: "completed" };
    if (feature) filter.feature = feature;
    const [payments, total] = await Promise.all([
      FeaturePayment.find(filter)
        .sort({ createdAt: -1 })
        .skip((parseInt(page, 10) - 1) * parseInt(limit, 10))
        .limit(parseInt(limit, 10))
        .lean(),
      FeaturePayment.countDocuments(filter),
    ]);
    res.json({ payments, total });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── HTML helpers ──────────────────────────────────────────────────────────────
function _successPage(msg) {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px">
    <div style="color:#00897B;font-size:48px">✅</div>
    <h2 style="color:#00897B">${msg}</h2>
    <p style="color:#555">You can close this tab and return to the Zeewant app.</p>
  </body></html>`;
}

function _failurePage(msg) {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px">
    <div style="font-size:48px">❌</div>
    <h2 style="color:#e53935">${msg}</h2>
    <p style="color:#555">You can close this tab and return to the Zeewant app.</p>
  </body></html>`;
}

export default router;
