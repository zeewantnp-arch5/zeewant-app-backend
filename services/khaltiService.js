const KHALTI_SECRET_KEY = process.env.KHALTI_SECRET_KEY || "test_secret_key_dc74e0fd57cb46cd93832aee0a390234";
const KHALTI_BASE_URL = process.env.KHALTI_BASE_URL || "https://dev.khalti.com";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:5000";

function _normalizeAmountToPaisa(amountNpr) {
  // Khalti expects integer amount in paisa.
  return Math.round(Number(amountNpr) * 100);
}

async function _readKhaltiError(response) {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text);
    return parsed?.detail || parsed?.message || parsed?.error_key || text;
  } catch {
    return text;
  }
}

/**
 * Initiates a Khalti payment and returns { pidx, payment_url }.
 */
export async function initiateKhaltiPayment({ amount, transactionUuid, planDisplayName }) {
  const amountInPaisa = _normalizeAmountToPaisa(amount);
  if (!Number.isInteger(amountInPaisa) || amountInPaisa < 1000) {
    throw new Error("Khalti requires amount >= NPR 10 (1000 paisa)");
  }

  const body = {
    return_url: `${BACKEND_URL}/api/payments/khalti/callback`,
    website_url: BACKEND_URL,
    amount: amountInPaisa,
    purchase_order_id: transactionUuid,
    purchase_order_name: `Zeewant ${planDisplayName}`,
  };

  const response = await fetch(`${KHALTI_BASE_URL}/api/v2/epayment/initiate/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${KHALTI_SECRET_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await _readKhaltiError(response);
    throw new Error(`Khalti initiation failed: ${err}`);
  }

  const data = await response.json();
  return { pidx: data.pidx, paymentUrl: data.payment_url };
}

/**
 * Verifies a Khalti payment by pidx. Returns the lookup response object.
 */
export async function verifyKhaltiPayment(pidx) {
  const response = await fetch(`${KHALTI_BASE_URL}/api/v2/epayment/lookup/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${KHALTI_SECRET_KEY}`,
    },
    body: JSON.stringify({ pidx }),
  });

  if (!response.ok) {
    const err = await _readKhaltiError(response);
    throw new Error(`Khalti verification failed: ${err}`);
  }

  return response.json();
}
