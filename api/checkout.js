// /api/checkout.js
// iDEAL "first" betaling + klant aanmaken bij Mollie.
// Inclusief CORS, extra velden, coupon & server-side prijsberekening.
// Metadata bevat alles voor je mollie-webhook om Kajabi te activeren.

import fetch from "node-fetch";

// ---- CORS ----
function setCors(res) {
  // Zet hier desgewenst jouw Kajabi-domein i.p.v. "*"
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ---- Hulpfuncties prijs ----
function toMoneyStr(n) {
  const v = Math.max(0.01, Math.round(Number(n) * 100) / 100);
  return v.toFixed(2);
}

function computePricing({ offerId, coupon }) {
  // Basisprijs (per offer overschrijfbaar)
  const baseStr =
    process.env[`PRICE_EUR_${offerId}`] ??
    process.env.PRICE_EUR ??
    "12.00";
  const base = Number(baseStr);

  // Korting (of percentage of vast bedrag — kies er één per offer)
  const pct = Number(
    process.env[`DISCOUNT_PERCENT_${offerId}`] ??
      process.env.DISCOUNT_PERCENT ??
      "0"
  );
  const off = Number(
    process.env[`DISCOUNT_EUR_${offerId}`] ??
      process.env.DISCOUNT_EUR ??
      "0"
  );

  // Eenvoudige coupon (optioneel)
  let extraPct = 0;
  let extraOff = 0;
  if (coupon) {
    if (
      process.env.COUPON_CODE_PERCENT &&
      process.env.COUPON_CODE_PERCENT === coupon
    ) {
      extraPct = Number(process.env.COUPON_VALUE_PERCENT || "0");
    }
    if (
      process.env.COUPON_CODE_EUR &&
      process.env.COUPON_CODE_EUR === coupon
    ) {
      extraOff = Number(process.env.COUPON_VALUE_EUR || "0");
    }
  }

  let afterPct = base * (1 - pct / 100) * (1 - extraPct / 100);
  let finalNum = afterPct - off - extraOff;

  return {
    base: toMoneyStr(base),
    final: toMoneyStr(finalNum),
    discountSummary: {
      percentTotal: pct + (extraPct ? extraPct : 0),
      eurTotal: toMoneyStr(off + extraOff),
    },
  };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const { email, name, offerId, coupon, extra } = req.body || {};
    if (!email) return res.status(400).json({ error: "Missing email" });
    if (!offerId) return res.status(400).json({ error: "Missing offerId" });

    // 1) Server-side prijsberekening
    const pricing = computePricing({ offerId, coupon });
    const amountStr = pricing.final;

    // 2) Mollie customer aanmaken (of opnieuw aanmaken is ok)
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

    // 3) (optioneel) Offer-specifieke Kajabi-activatie URL opnemen in metadata
    const envKey =
      offerId && process.env[`KAJABI_ACTIVATION_URL_${offerId}`]
        ? `KAJABI_ACTIVATION_URL_${offerId}`
        : "KAJABI_ACTIVATION_URL";
    const offerActivationUrl = process.env[envKey];

    // 4) Eerste iDEAL betaling (sequenceType: "first")
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
          amount: { currency: "EUR", value: amountStr },
          description: `Eerste betaling (basis €${pricing.base}, korting toegepast)`,
          sequenceType: "first",
          redirectUrl: `${
            process.env.REDIRECT_URL || "https://example.com/thank-you"
          }`,
          webhookUrl: `${process.env.PUBLIC_BASE_URL}/api/mollie-webhook`,
          locale: "nl_NL",
          metadata: {
            // Nodig voor je Kajabi-activatie webhook
            email,
            name: name || email,
            offerId,
            coupon: coupon || null,
            pricing, // handig voor logging/debug
            externalUserId: customer.id, // stabiele ID voor Kajabi
            offerActivationUrl, // directe activatie-URL per offer (optioneel)

            // Extra adresvelden uit je formulier
            address: {
              voornaam: extra?.voornaam || null,
              achternaam: extra?.achternaam || null,
              adres: extra?.adres || null,
              woonplaats: extra?.woonplaats || null,
            },
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
