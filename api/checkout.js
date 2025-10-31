// /api/checkout.js
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
        metadata: { offerId }
      }),
    });
    const customer = await customerResp.json();
    if (!customer?.id) {
      console.error("Customer create error", customer);
      return res.status(500).json({ error: "Could not create customer" });
    }

    // 2) Create FIRST payment (iDEAL) to establish mandate — €0.01
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
          metadata: { email, offerId },
          locale: "nl_NL",
        }),
      }
    );

    const payment = await paymentResp.json();
    if (!payment?._links?.checkout?.href) {
      console.error("Payment create error", payment);
      return res.status(500).json({ error: "Could not create payment" });
    }

    return res.status(200).json({ checkoutUrl: payment._links.checkout.href });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Checkout init failed" });
  }
}
