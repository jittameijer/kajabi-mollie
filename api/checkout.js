// /api/checkout.js
// Handles first Mollie iDEAL payment + Kajabi activation metadata

export const config = { runtime: "nodejs" }; // ensure Node runtime on Vercel

// ---- CORS ----
const ALLOWLIST = new Set([
  "https://www.fortnegenacademy.nl",
  // add dev/staging if needed:
  // "http://localhost:3000",
  // "https://staging.fortnegenacademy.nl",
]);

function setCors(req, res) {
  const origin = req.headers.origin || "";
  res.setHeader("Vary", "Origin");
  if (ALLOWLIST.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      req.headers["access-control-request-headers"] ||
        "Content-Type, Authorization"
    );
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
}

// --- Offer Configuration ---
const OFFER_CONFIG = {
  OFFER1: {
    name: "Fort Negen community maand",
    description: "Fort Negen community maand",
    firstPayment: { currency: "EUR", value: "0.01" },
    recurringPayment: { currency: "EUR", value: "12.00" },
    activationEnv: "KAJABI_ACTIVATION_URL_OFFER1",
  },
  OFFER2: {
    name: "Fort Negen community maand",
    description: "Fort Negen community maand",
    firstPayment: { currency: "EUR", value: "12.00" },
    recurringPayment: { currency: "EUR", value: "12.00" },
    activationEnv: "KAJABI_ACTIVATION_URL_OFFER2",
  },
  OFFER3: {
    name: "Fort Negen community jaar",
    description: "Fort Negen community jaar",
    firstPayment: { currency: "EUR", value: "120.00" },
    recurringPayment: { currency: "EUR", value: "120.00" },
    activationEnv: "KAJABI_ACTIVATION_URL_OFFER3",
  },
};

// Lazy alert import with safe fallback
async function getAlert() {
  try {
    const mod = await import("../lib/alert.js");
    return typeof mod.alert === "function"
      ? mod.alert
      : () => Promise.resolve();
  } catch {
    return () => Promise.resolve(); // no-op
  }
}

export default async function handler(req, res) {
  setCors(req, res);

  // Preflight
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method Not Allowed" });

  const alert = await getAlert();

  try {
    const body =
      req.body && typeof req.body === "object" ? req.body : {};
    const { email, name, offerId } = body;

    if (!email) {
      await alert("warn", "Checkout: missing email", {});
      return res.status(400).json({ error: "Missing email" });
    }

    // 1) Validate offerId
    const offer = OFFER_CONFIG[offerId];
    if (!offer) {
      await alert("warn", "Checkout: unknown offerId", { offerId });
      return res.status(400).json({ error: "Unknown offerId" });
    }

    // 2) Create customer in Mollie
    const customerResp = await fetch("https://api.mollie.com/v2/customers", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MOLLIE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: name || email,
        email,
        metadata: { offerId },
      }),
    });

    const customer = await customerResp.json().catch(() => ({}));
    if (!customer?.id) {
      console.error("Customer create error", customerResp.status, customer);
      await alert("error", "Checkout: could not create customer", {
        status: customerResp.status,
      });
      return res.status(500).json({ error: "Could not create customer" });
    }

    // 3) Activation URL
    const offerActivationUrl =
      process.env[offer.activationEnv] ||
      process.env.KAJABI_ACTIVATION_URL;

    // 4) Create first payment (mandate)
    const paymentResp = await fetch(
      `https://api.mollie.com/v2/customers/${customer.id}/payments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.MOLLIE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          method: "ideal",
          amount: offer.firstPayment,
          description: `${offer.description} – eerste betaling`,
          sequenceType: "first",
          redirectUrl:
            process.env.REDIRECT_URL ||
            "https://www.fortnegenacademy.nl/bedankt",
          webhookUrl: `${process.env.PUBLIC_BASE_URL}/api/mollie-webhook`,
          locale: "nl_NL",
          metadata: {
            email,
            name: name || email,
            offerId,
            externalUserId: customer.id,
            offerActivationUrl,
            recurringAmount: offer.recurringPayment.value,
          },
        }),
      }
    );

    const payment = await paymentResp.json().catch(() => ({}));
    const checkoutUrl = payment?._links?.checkout?.href;

    if (!checkoutUrl) {
      console.error("Payment create error", paymentResp.status, payment);
      await alert("error", "Checkout: could not create payment", {
        status: paymentResp.status,
        customerId: customer.id,
      });
      return res.status(500).json({ error: "Could not create payment" });
    }

    await alert("info", "Checkout: payment created", {
      customerId: customer.id,
      offerId,
    });

    res.setHeader("Content-Type", "application/json");
    return res.status(200).json({ checkoutUrl });
  } catch (e) {
    console.error("Checkout init failed:", e);
    await alert("error", "Checkout: exception", { error: String(e) });
    return res.status(500).json({ error: "Checkout init failed" });
  }
}
