import crypto from "crypto";

const ESEWA_MERCHANT_CODE = process.env.ESEWA_MERCHANT_CODE || "EPAYTEST";
const ESEWA_SECRET = process.env.ESEWA_SECRET || "8gBm/:&EnhH.1/q";
const ESEWA_BASE_URL =
  process.env.ESEWA_BASE_URL || "https://rc-epay.esewa.com.np";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:5000";

function generateSignature(totalAmount, transactionUuid, productCode) {
  const message = `total_amount=${totalAmount},transaction_uuid=${transactionUuid},product_code=${productCode}`;
  return crypto
    .createHmac("sha256", ESEWA_SECRET)
    .update(message)
    .digest("base64");
}

function verifySignature(fields, signature) {
  const message = fields;
  const expected = crypto
    .createHmac("sha256", ESEWA_SECRET)
    .update(message)
    .digest("base64");
  return expected === signature;
}

/**
 * Returns the form parameters needed to initiate an eSewa payment.
 */
export function buildEsewaFormParams(amount, transactionUuid) {
  const totalAmount = amount;
  const signature = generateSignature(
    totalAmount,
    transactionUuid,
    ESEWA_MERCHANT_CODE
  );

  return {
    formAction: `${ESEWA_BASE_URL}/api/epay/main/v2/form`,
    fields: {
      amount: String(amount),
      tax_amount: "0",
      total_amount: String(totalAmount),
      transaction_uuid: transactionUuid,
      product_code: ESEWA_MERCHANT_CODE,
      product_service_charge: "0",
      product_delivery_charge: "0",
      success_url: `${BACKEND_URL}/api/payments/esewa/success`,
      failure_url: `${BACKEND_URL}/api/payments/esewa/failure`,
      signed_field_names: "total_amount,transaction_uuid,product_code",
      signature,
    },
  };
}

/**
 * Verifies the base64-encoded response data that eSewa sends to success_url.
 * Returns { valid, data } where data is the decoded response object.
 */
export function verifyEsewaCallback(base64Data) {
  try {
    const decoded = JSON.parse(Buffer.from(base64Data, "base64").toString("utf8"));
    const { signed_field_names, signature, ...rest } = decoded;

    const fieldNames = signed_field_names.split(",");
    const message = fieldNames.map((f) => `${f}=${decoded[f]}`).join(",");
    const valid = verifySignature(message, signature);

    return { valid, data: decoded };
  } catch {
    return { valid: false, data: null };
  }
}
