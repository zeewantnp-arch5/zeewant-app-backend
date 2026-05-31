const KHALTI_SECRET_KEY = (process.env.KHALTI_SECRET_KEY || "").trim();
const KHALTI_BASE_URL = (process.env.KHALTI_BASE_URL || "").trim();
// Render auto-injects RENDER_EXTERNAL_URL; fall back to BACKEND_URL for local dev.
const BACKEND_URL = (
  process.env.BACKEND_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  "http://localhost:5000"
).trim().replace(/\/+$/, "");

function _resolveKhaltiBaseUrl() {
  if (KHALTI_BASE_URL) {
    return KHALTI_BASE_URL.replace(/\/+$/, "");
  }

  // Choose sensible defaults based on key type when base URL is not provided.
  if (KHALTI_SECRET_KEY.startsWith("test_secret_key_")) {
    return "https://a.khalti.com";
  }

  return "https://khalti.com";
}

function _assertKhaltiConfig() {
  if (!KHALTI_SECRET_KEY) {
    throw new Error(
      "Khalti is not configured. Set KHALTI_SECRET_KEY in backend .env"
    );
  }
}

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
  _assertKhaltiConfig();

  const amountInPaisa = _normalizeAmountToPaisa(amount);
  if (!Number.isInteger(amountInPaisa) || amountInPaisa < 1000) {
    throw new Error("Khalti requires amount >= NPR 10 (1000 paisa)");
  }

  const khaltiBaseUrl = _resolveKhaltiBaseUrl();

  const returnUrl = `${BACKEND_URL}/api/payments/khalti/callback`;
  console.log(`[Khalti] initiating — amount=${amountInPaisa} paisa, return_url=${returnUrl}`);

  const body = {
    return_url: returnUrl,
    website_url: BACKEND_URL,
    amount: amountInPaisa,
    purchase_order_id: transactionUuid,
    purchase_order_name: `Zeewant ${planDisplayName}`,
  };

  const response = await fetch(`${khaltiBaseUrl}/api/v2/epayment/initiate/`, {
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
  _assertKhaltiConfig();

  const khaltiBaseUrl = _resolveKhaltiBaseUrl();
  const response = await fetch(`${khaltiBaseUrl}/api/v2/epayment/lookup/`, {
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
