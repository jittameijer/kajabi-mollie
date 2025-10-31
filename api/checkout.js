// /api/checkout.js
// Handles first Mollie iDEAL payment + Kajabi activation metadata

import fetch from "node-fetch";

export default async function handler(req, res) {
  // === CORS FIX ===
  const allowedOrigin = "https://www.fortnegenacademy.nl";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400"); // cache preflight 1 dag
  res.setHeader("Vary", "Origin");

  // === Preflight (OPTIONS) ===
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // === Alleen POST toegestaan ===
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { email, name, offerId } = req.body || {};
    if (!email) return res.status(400).json({ error: "Missing email" });

    // 1) Maak klant aan in Mollie
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
      console.error("Customer create error", customerResp.status, customer);
      return res.status(500).json({ error: "Could not create customer" });
    }

    // 2) Activeer juiste offer-URL (optioneel)
    const offerEnvKey =
      offerId && process.env[`KAJABI_ACTIVATION_URL_${offerId}`]
        ? `KAJABI_ACTIVATION_URL_${offerId}`
        : "KAJABI_ACTIVATION_URL";
    const offerActivationUrl = process.env[offerEnvKey];

    // 3) Eerste betaling (mandaat) aanmaken
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
          redirectUrl: `${process.env.REDIRECT_URL || "https://www.fortnegenacademy.nl/bedankt"}`,
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

    const payment = await paymentResp.json();
    const checkoutUrl = payment?._links?.checkout?.href;

    if (!checkoutUrl) {
      console.error("Payment create error", paymentResp.status, payment);
      return res.status(500).json({ error: "Could not create payment" });
    }

    return res.status(200).json({ checkoutUrl });
  } catch (e) {
    console.error("Checkout init failed:", e);
    return res.status(500).json({ error: "Checkout init failed" });
  }
}
