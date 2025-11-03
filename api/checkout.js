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
      req.headers["access-control-request-headers"] || "Content-Type, Authorization"
    );
    // if your frontend uses credentials: 'include', keep this true
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
}

// Lazy alert import with safe fallback
async function getAlert() {
  try {
    const mod = await import("../lib/alert.js");
    return typeof mod.alert === "function" ? mod.alert : (() => Promise.resolve());
  } catch {
    return () => Promise.resolve(); // no-op
  }
}

export default async function handler(req, res) {
  setCors(req, res);

  // Preflight: return early with headers
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const alert = await getAlert(); // safe

  try {
    // Ensure req.body is an object (Vercel usually parses JSON automatically)
    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const { email, name, offerId } = body;

    if (!email) {
      await alert("warn", "Checkout: missing email", {});
      return res.status(400).json({ error: "Missing email" });
    }

    // 1) Create customer in Mollie (use global fetch on Node 18+)
    const customerResp = await fetch("https://api.mollie.com/v2/customers", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MOLLIE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: name || email, email, metadata: { offerId } }),
    });

    const customer = await customerResp.json().catch(() => ({}));
    if (!customer?.id) {
      console.error("Customer create error", customerResp.status, customer);
      await alert("error", "Checkout: could not create customer", {
        status: customerResp.status,
      });
      return res.status(500).json({ error: "Could not create customer" });
    }

    // 2) Choose activation URL
    const offerEnvKey =
      offerId && process.env[`KAJABI_ACTIVATION_URL_${offerId}`]
        ? `KAJABI_ACTIVATION_URL_${offerId}`
        : "KAJABI_ACTIVATION_URL";
    const offerActivationUrl = process.env[offerEnvKey];

    // 3) Create first payment (mandate)
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
          amount: { currency: "EUR", value: "0.01" },
          description: "Intro month (first payment)",
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
    return res.status(200).end(JSON.stringify({ checkoutUrl }));
  } catch (e) {
    console.error("Checkout init failed:", e);
    await alert("error", "Checkout: exception", { error: String(e) });
    // Still return JSON with CORS headers
    return res.status(500).json({ error: "Checkout init failed" });
  }
}
