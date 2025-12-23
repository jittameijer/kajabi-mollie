// /api/validate.js
// Validates coupon without creating a payment

export const config = { runtime: "nodejs" };

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
      req.headers["access-control-request-headers"] || "Content-Type, Authorization"
    );
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
}

// --- Coupon configuration (keep identical to checkout.js) ---
const COUPONS = {
  WELKOM10: {
    type: "percent",
    value: 10,
    offers: ["CURSUS1", "CURSUS2"],
    appliesTo: ["first"],
    description: "10% korting",
  },
  BAKPAKKET26: {
    type: "fixed",
    valueCents: 1000,
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

function computeDiscount({ offerId, code, baseCents, appliesTo = "first" }) {
  const normalized = (code || "").trim().toUpperCase();

  if (!normalized) {
    return { valid: true, code: "", totalCents: baseCents, discountCents: 0, coupon: null };
  }

  const coupon = COUPONS[normalized];
  if (!coupon) return { valid: false, error: "Kortingscode ongeldig." };

  if (coupon.offers?.length && !coupon.offers.includes(offerId)) {
    return { valid: false, error: "Kortingscode niet geldig voor dit product." };
  }

  if (coupon.appliesTo?.length && !coupon.appliesTo.includes(appliesTo)) {
    return { valid: false, error: "Kortingscode niet geldig voor deze betaling." };
  }

  let discountCents = 0;
  if (coupon.type === "percent") discountCents = Math.round(baseCents * (coupon.value / 100));
  else if (coupon.type === "fixed") discountCents = Number(coupon.valueCents || 0);
  else return { valid: false, error: "Ongeldige kortingscode configuratie." };

  const totalCents = Math.max(0, baseCents - discountCents);

  return {
    valid: true,
    code: normalized,
    totalCents,
    discountCents: Math.min(baseCents, discountCents),
    coupon,
  };
}

// Keep offer amounts consistent with checkout.js
const OFFER_CONFIG = {
  OFFER1: { firstPayment: { value: "0.01" } },
  OFFER2: { firstPayment: { value: "12.00" } },
  OFFER3: { firstPayment: { value: "120.00" } },
  CURSUS1: { firstPayment: { value: "75.00" } },
  CURSUS2: { firstPayment: { value: "59.00" } },
};

export default function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const offerId = String(body.offerId || "").trim();
  const coupon = String(body.coupon || body.code || "").trim();

  const offer = OFFER_CONFIG[offerId];
  if (!offer) return res.status(400).json({ error: "Unknown offerId" });

  const baseCents = moneyValueToCents(offer.firstPayment?.value);
  if (baseCents == null) return res.status(500).json({ error: "Invalid offer amount" });

  const result = computeDiscount({ offerId, code: coupon, baseCents, appliesTo: "first" });
  if (!result.valid) return res.status(400).json({ error: result.error });

  return res.status(200).json({
    discountCents: result.discountCents,
    totalCents: result.totalCents,
  });
}
