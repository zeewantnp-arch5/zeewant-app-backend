const KHALTI_SECRET_KEY = process.env.KHALTI_SECRET_KEY || "test_secret_key_dc74e0fd57cb46cd93832aee0a390234";
const KHALTI_BASE_URL = process.env.KHALTI_BASE_URL || "https://dev.khalti.com";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:5000";

/**
 * Initiates a Khalti payment and returns { pidx, payment_url }.
 */
export async function initiateKhaltiPayment({ amount, transactionUuid, planDisplayName }) {
  const body = {
    return_url: `${BACKEND_URL}/api/payments/khalti/callback`,
    website_url: BACKEND_URL,
    amount: amount * 100, // Khalti expects paisa (1 NPR = 100 paisa)
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
    const err = await response.text();
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
    const err = await response.text();
    throw new Error(`Khalti verification failed: ${err}`);
  }

  return response.json();
}
