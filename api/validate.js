import { computeDiscount, moneyValueToCents } from "./checkout";

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const { offerId, coupon } = req.body;

  const OFFER_PRICES = {
    CURSUS1: "75.00",
    CURSUS2: "59.00",
  };

  const baseValue = OFFER_PRICES[offerId];
  if (!baseValue) {
    return res.status(400).json({ error: "Onbekend product" });
  }

  const baseCents = moneyValueToCents(baseValue);

  const result = computeDiscount({
    offerId,
    code: coupon,
    baseCents,
    appliesTo: "first"
  });

  if (!result.valid) {
    return res.status(400).json({ error: result.error });
  }

  res.status(200).json({
    discountCents: result.discountCents,
    totalCents: result.totalCents
  });
}
