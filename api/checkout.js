// /api/checkout.js
import fetch from "node-fetch";
import { alert } from "../lib/alert.js";

export const config = { runtime: "nodejs" }; // ensure Node runtime on Vercel

const ALLOWLIST = new Set([
  "https://www.fortnegenacademy.nl",
  // add any staging or local origins you actually use:
  // "http://localhost:3000",
  // "https://staging.fortnegenacademy.nl",
]);

function setCors(req, res) {
  const origin = req.headers.origin || "";
  const allowedOrigin = ALLOWLIST.has(origin) ? origin : null;

  // Always vary on Origin
  res.setHeader("Vary", "Origin");

  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    // Mirror requested headers (fallback to common ones)
    const reqHeaders = req.headers["access-control-request-headers"];
    res.setHeader(
      "Access-Control-Allow-Headers",
      reqHeaders || "Content-Type, Authorization"
    );
    // If you send or expect cookies/credentials from the page:
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Max-Age", "86400"); // cache preflight for 24h
  }
}

export default async function handler(req, res) {
  setCors(req, res);

  // Preflight
  if (req.method === "OPTIONS") {
    // Important: return 204/200 WITH the CORS headers already set
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { email, name, offerId } = (req.body && typeof req.body === "object")
      ? req.body
      : {};

    if (!email) {
      await alert("warn", "Checkout: missing email", {});
      return res.status(400).json({ error: "Missing email" });
    }

    // 1) Create customer in Mollie
    const customerResp = await fetch("https://api.mollie.com/v2/customers", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MOLLIE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: name || email, email, metadata: { offerId } }),
    });
    const customer = await customerResp.json();

    if (!customer?.id) {
      console.error("Customer create error", customerResp.status, customer);
      await alert("error", "Checkout: could not create customer", {
        status: customerResp.status,
      });
      return res.status(500).json({ error: "Could not create customer" });
    }

    // 2) Pick activation URL
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

    const payment = await paymentResp.json();
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
    return res.status(500).json({ error: "Checkout init failed" });
  }
}
