// /api/checkout.js
// Handles Mollie payments + Kajabi activation metadata

// =========================
// Discount helper (server-side)
// =========================

// Coupon configuration (replace with Redis/DB later if needed)
const COUPONS = {
  WELKOM10: {
    type: "percent",
    value: 10, // 10%
    offers: ["CURSUS1", "CURSUS2"],
    appliesTo: ["first"], // "first" | "recurring"
    description: "10% korting",
  },
  BAKPAKKET26: {
    type: "fixed",
    valueCents: 1000, // €10
    offers: ["CURSUS1"],
    appliesTo: ["first"],
    description: "€10 korting",
  },
};

// "75.00" → 7500
function moneyValueToCents(valueStr) {
  const s = String(valueStr || "").trim().replace(",", ".");
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

// 7500 → "75.00"
function centsToMoneyValue(cents) {
  return (Number(cents) / 100).toFixed(2);
}

// Returns either { valid:true, totalCents, ... } or { valid:false, error }
function computeDiscount({ offerId, code, baseCents, appliesTo = "first" }) {
  const normalized = (code || "").trim().toUpperCase();

  // No coupon → no discount
  if (!normalized) {
    return {
      valid: true,
      code: "",
      totalCents: baseCents,
      discountCents: 0,
      coupon: null,
    };
  }

  const coupon = COUPONS[normalized];
  if (!coupon) {
    return { valid: false, error: "Kortingscode ongeldig." };
  }

  if (coupon.offers?.length && !coupon.offers.includes(offerId)) {
    return { valid: false, error: "Kortingscode niet geldig voor dit product." };
  }

  if (coupon.appliesTo?.length && !coupon.appliesTo.includes(appliesTo)) {
    return { valid: false, error: "Kortingscode niet geldig voor deze betaling." };
  }

  let discountCents = 0;

  if (coupon.type === "percent") {
    discountCents = Math.round(baseCents * (coupon.value / 100));
  } else if (coupon.type === "fixed") {
    discountCents = Number(coupon.valueCents || 0);
  } else {
    return { valid: false, error: "Ongeldige kortingscode configuratie." };
  }

  const totalCents = Math.max(0, baseCents - discountCents);

  return {
    valid: true,
    code: normalized,
    totalCents,
    discountCents: Math.min(baseCents, discountCents),
    coupon,
  };
}

export const config = { runtime: "nodejs" }; // ensure Node runtime on Vercel

// --- Lazy Redis init (reuse Upstash like in webhook) ---
let redisPromise = null;
async function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  if (!redisPromise) {
    redisPromise = (async () => {
      const { Redis } = await import("@upstash/redis");
      return new Redis({ url, token });
    })();
  }
  return redisPromise;
}

// ---- CORS ----
const ALLOWLIST = new Set([
  "https://www.fortnegenacademy.nl",
  // add dev/staging if needed
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
    description: "Fort Negen community maand",
    firstPayment: { currency: "EUR", value: "0.01" },
    recurringPayment: { currency: "EUR", value: "12.00" },
    interval: "1 month",
    activationEnv: "KAJABI_ACTIVATION_URL_OFFER1",
    type: "subscription",
  },
  OFFER2: {
    description: "Fort Negen community maand",
    firstPayment: { currency: "EUR", value: "12.00" },
    recurringPayment: { currency: "EUR", value: "12.00" },
    interval: "1 month",
    activationEnv: "KAJABI_ACTIVATION_URL_OFFER2",
    type: "subscription",
  },
  OFFER3: {
    description: "Fort Negen community jaar",
    firstPayment: { currency: "EUR", value: "120.00" },
    recurringPayment: { currency: "EUR", value: "120.00" },
    interval: "1 year",
    activationEnv: "KAJABI_ACTIVATION_URL_OFFER3",
    type: "subscription",
  },
  CURSUS1: {
    description: "Fort Negen cursus 1",
    firstPayment: { currency: "EUR", value: "75.00" },
    activationEnv: "KAJABI_ACTIVATION_URL_CURSUS1",
    type: "one_time",
  },
  CURSUS2: {
    description: "Fort Negen cursus 2",
    firstPayment: { currency: "EUR", value: "59.00" },
    activationEnv: "KAJABI_ACTIVATION_URL_CURSUS2",
    type: "one_time",
  },
};

// --- Lazy alert import ---
async function getAlert() {
  try {
    const mod = await import("../lib/alert.js");
    return typeof mod.alert === "function"
      ? mod.alert
      : () => Promise.resolve();
  } catch {
    return () => Promise.resolve();
  }
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method Not Allowed" });

  const alert = await getAlert();

  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const {
      email: rawEmail,
      name,
      offerId,
      coupon: rawCoupon,
      code: rawCode,
      action, // ✅ NEW: "validate" or undefined
    } = body;

    const couponCode = (rawCoupon || rawCode || "").trim();
    const email = (rawEmail || "").toLowerCase().trim();

    // In validate mode we do NOT require email
    const isValidateOnly = String(action || "").toLowerCase() === "validate";

    if (!isValidateOnly && !email) {
      await alert("warn", "Checkout: missing email", {});
      return res.status(400).json({ error: "Missing email" });
    }

    const offer = OFFER_CONFIG[offerId];
    if (!offer) {
      await alert("warn", "Checkout: unknown offerId", { offerId });
      return res.status(400).json({ error: "Unknown offerId" });
    }

    // --- Apply discount to first payment (server-side) ---
    const baseCents = moneyValueToCents(offer.firstPayment?.value);
    if (baseCents == null) {
      await alert("error", "Checkout: invalid offer amount", {
        offerId,
        value: offer.firstPayment?.value,
      });
      return res.status(500).json({ error: "Invalid offer amount" });
    }

    const discountResult = computeDiscount({
      offerId,
      code: couponCode,
      baseCents,
      appliesTo: "first",
    });

    if (!discountResult.valid) {
      return res.status(400).json({ error: discountResult.error });
    }

    // ✅ Validate-only mode: return discount info, do NOT touch Mollie/Redis
    if (isValidateOnly) {
      res.setHeader("Content-Type", "application/json");
      return res.status(200).json({
        discountCents: discountResult.discountCents || 0,
        totalCents: discountResult.totalCents,
        code: discountResult.code || "",
        description: discountResult.coupon?.description || "",
      });
    }

    const finalFirstPayment = {
      currency: offer.firstPayment.currency,
      value: centsToMoneyValue(discountResult.totalCents),
    };

    // --- Try to reuse existing Mollie customer from Redis ---
    let customerId = null;
    try {
      const redis = await getRedis();
      if (redis) {
        const key = `kajabi:email:${email}`;
        const mapping = await redis.hgetall(key);
        if (mapping?.mollieCustomerId) {
          customerId = mapping.mollieCustomerId;
          console.log("Checkout: reusing Mollie customer from Redis", {
            email,
            customerId,
          });
        }
      }
    } catch (e) {
      console.error("Checkout: Redis lookup failed", e);
    }

    let customer;

    if (customerId) {
      // Reuse existing customer from Mollie
      const customerResp = await fetch(
        `https://api.mollie.com/v2/customers/${encodeURIComponent(customerId)}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.MOLLIE_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );
      customer = await customerResp.json().catch(() => ({}));

      if (!customerResp.ok || !customer?.id) {
        console.warn(
          "Checkout: existing customerId invalid, will create new one",
          customerResp.status,
          customer
        );
        customerId = null;
      }
    }

    // If no valid existing customer → create a new one (old behaviour)
    if (!customerId) {
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

      customer = await customerResp.json().catch(() => ({}));
      if (!customer?.id) {
        console.error("Customer create error", customerResp.status, customer);
        await alert("error", "Checkout: could not create customer", {
          status: customerResp.status,
        });
        return res.status(500).json({ error: "Could not create customer" });
      }

      customerId = customer.id;

      // Store mapping immediately for next time
      try {
        const redis = await getRedis();
        if (redis) {
          await redis.hset(`kajabi:email:${email}`, {
            mollieCustomerId: customerId,
            updatedAt: new Date().toISOString(),
          });
          await redis.hset(`mollie:customer:${customerId}`, {
            lastEmail: email,
            updatedAt: new Date().toISOString(),
          });
        }
      } catch (e) {
        console.error("Checkout: failed to store mapping in Redis", e);
      }
    }

    // 2) Choose activation URL
    const offerActivationUrl =
      process.env[offer.activationEnv] || process.env.KAJABI_ACTIVATION_URL;

    // 3) Determine payment type
    const isSubscription = offer.type === "subscription";
    const sequenceType = isSubscription ? "first" : "oneoff";

    // 4) Create payment
    const paymentResp = await fetch(
      `https://api.mollie.com/v2/customers/${customerId}/payments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.MOLLIE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          method: ["ideal", "bancontact", "creditcard", "applepay"],
          amount: finalFirstPayment, // discounted first payment
          description: offer.description,
          sequenceType,
          redirectUrl:
            process.env.REDIRECT_URL ||
            "https://www.fortnegenacademy.nl/bedankt",
          webhookUrl: `${process.env.PUBLIC_BASE_URL}/api/mollie-webhook`,
          locale: "nl_NL",
          metadata: {
            email,
            name: name || email,
            offerId,
            externalUserId: customerId,
            offerActivationUrl,
            recurringAmount: offer.recurringPayment?.value || null,
            interval: offer.interval || null,
            type: offer.type,

            // discount metadata
            couponCode: discountResult.code || "",
            discountCents: discountResult.discountCents || 0,
            baseCents,
            totalCents: discountResult.totalCents,
            discountDescription: discountResult.coupon?.description || "",
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
        customerId,
      });
      return res.status(500).json({ error: "Could not create payment" });
    }

    await alert("info", "Checkout: payment created", {
      customerId,
      offerId,
      couponCode: discountResult.code || "",
      totalCents: discountResult.totalCents,
    });

    res.setHeader("Content-Type", "application/json");
    return res.status(200).json({ checkoutUrl });
  } catch (e) {
    console.error("Checkout init failed:", e);
    const alert = await getAlert();
    await alert("error", "Checkout: exception", { error: String(e) });
    return res.status(500).json({ error: "Checkout init failed" });
  }
}
