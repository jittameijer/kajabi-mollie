// lib/discounts.js

// Coupon definitions (replace with Redis/DB later if you want)
export const COUPONS = {
  WEL10: {
    type: "percent",
    value: 10, // 10%
    offers: ["CURSUS1", "CURSUS2"],
    appliesTo: ["first"], // "first" | "recurring" | both
    description: "10% korting",
  },
  BAKPAKKET26: {
    type: "fixed",
    valueCents: 1000, // €10
    offers: ["CURSUS1"],
    appliesTo: ["first"],
    description: "€10 korting",
  },
  MONTHFREE: {
    type: "fixed",
    valueCents: 1200, // example: €12 off
    offers: ["OFFER2"],
    appliesTo: ["first"],
    description: "Eerste maand korting",
  },
};

// Helpers: "75.00" => 7500 cents, cents => "75.00"
export function moneyValueToCents(valueStr) {
  const s = String(valueStr || "").trim().replace(",", ".");
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}
export function centsToMoneyValue(cents) {
  return (Number(cents) / 100).toFixed(2);
}

export function computeDiscount({ offerId, code, baseCents }) {
  const normalized = (code || "").trim().toUpperCase();
  if (!normalized) {
    return { valid: true, code: "", totalCents: baseCents, discountCents: 0, coupon: null };
  }

  const coupon = COUPONS[normalized];
  if (!coupon) return { valid: false, error: "Kortingscode ongeldig." };
  if (coupon.offers?.length && !coupon.offers.includes(offerId)) {
    return { valid: false, error: "Kortingscode niet geldig voor dit product." };
  }

  let discountCents = 0;
  if (coupon.type === "percent") {
    discountCents = Math.round(baseCents * (coupon.value / 100));
  } else if (coupon.type === "fixed") {
    discountCents = Number(coupon.valueCents || 0);
  } else {
    return { valid: false, error: "Kortingscode configuratie ongeldig." };
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
