// /api/checkout.js
// Creates a Mollie customer + FIRST iDEAL payment (sequenceType: "first")
// and includes full metadata so your webhook can activate Kajabi immediately.

import fetch from "node-fetch";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { email, name, offerId } = req.body || {};
    if (!email) return res.status(400).json({ error: "Missing email" });

    // 1) Create (or just create anew) a Mollie customer
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

    const customer = await customerResp.json();
    if (!customer?.id) {
      console.error("Customer create error", {
        status: customerResp.status,
        body: customer,
      });
      return res.status(500).json({ error: "Could not create customer" });
    }

    // Optional: if you keep the Kajabi activation URL per-offer in env,
    // expose it to the webhook via metadata so it knows which offer to activate.
    const offerEnvKey =
      offerId && process.env[`KAJABI_ACTIVATION_URL_${offerId}`]
        ? `KAJABI_ACTIVATION_URL_${offerId}`
        : "KAJABI_ACTIVATION_URL";
    const offerActivationUrl = process.env[offerEnvKey];

    // 2) Create FIRST payment (iDEAL) to establish the mandate — €0.01
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
          redirectUrl: `${process.env.REDIRECT_URL || "https://example.com/thank-you"}`,
          webhookUrl: `${process.env.PUBLIC_BASE_URL}/api/mollie-webhook`,
          locale: "nl_NL",

          // ✅ Important: full metadata for your webhook → Kajabi activation
          metadata: {
            email,
            name: name || email,
            offerId,                    // identify which offer to activate
            externalUserId: customer.id, // stable external ID Kajabi requires
            offerActivationUrl,          // optional: direct URL for this offer
          },
        }),
      }
    );

    const payment = await paymentResp.json();
    const checkoutUrl = payment?._links?.checkout?.href;

    if (!checkoutUrl) {
      console.error("Payment create error", {
        status: paymentResp.status,
        body: payment,
      });
      return res.status(500).json({ error: "Could not create payment" });
    }

    return res.status(200).json({ checkoutUrl });
  } catch (e) {
    console.error("Checkout init failed:", e);
    return res.status(500).json({ error: "Checkout init failed" });
  }
}
