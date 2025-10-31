// /api/mollie-webhook.js
// Handles Mollie payment webhooks.
// When the first payment succeeds, it creates a Mollie subscription
// and immediately activates the Kajabi offer via its Inbound Activation URL.

import fetch from "node-fetch";

export const config = { api: { bodyParser: true } };

// --- Helper: calculate start date for next month's subscription ---
function nextMonthDate(iso) {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(y, m + 1, 1));
  const maxDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  target.setUTCDate(Math.min(day, maxDay));
  return target.toISOString().slice(0, 10); // YYYY-MM-DD
}

// --- Helper: call Kajabi's Activation URL ---
async function activateKajabi({ name, email, externalUserId, activationUrl }) {
  if (!activationUrl || !email || !externalUserId) {
    console.warn("Skipping Kajabi activation (missing fields)", {
      hasUrl: !!activationUrl,
      email,
      externalUserId,
    });
    return { ok: false, skipped: true };
  }

  const body = {
    name: name || email,
    email,
    external_user_id: externalUserId,
  };

  try {
    const resp = await fetch(activationUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error("Kajabi activation failed:", resp.status, text);
      return { ok: false, status: resp.status, text };
    }

    console.log("Kajabi activation success for", email);
    return { ok: true };
  } catch (err) {
    console.error("Kajabi activation error:", err);
    return { ok: false, error: String(err) };
  }
}

export default async function handler(req, res) {
  try {
    const paymentId = req.body?.id || req.query?.id;
    if (!paymentId) return res.status(400).send("Missing id");

    // 1️⃣ Fetch the latest payment info from Mollie
    const pResp = await fetch(`https://api.mollie.com/v2/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${process.env.MOLLIE_API_KEY}` },
    });
    const payment = await pResp.json();

    // Only act on successful "first" payments
    if (payment.status === "paid" && payment.sequenceType === "first") {
      const customerId = payment.customerId;
      const startDate = nextMonthDate(payment.paidAt || payment.createdAt);

      // 2️⃣ Create recurring subscription starting next month
      const subResp = await fetch(
        `https://api.mollie.com/v2/customers/${customerId}/subscriptions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.MOLLIE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            amount: { currency: "EUR", value: "12.00" },
            interval: "1 month",
            description: "Course subscription (€12/month after intro)",
            startDate,
            metadata: payment.metadata,
            webhookUrl: `${process.env.PUBLIC_BASE_URL}/api/mollie-webhook`,
          }),
        }
      );

      const subscription = await subResp.json();
      if (!subscription?.id) {
        console.error("Subscription creation failed", subscription);
      }

      // 3️⃣ Activate Kajabi offer
      const name = payment.metadata?.name || payment.details?.consumerName || "";
      const email =
        payment.metadata?.email ||
        payment.billingEmail ||
        payment.email ||
        "";
      const externalUserId =
        payment.metadata?.externalUserId ||
        payment.customerId ||
        customerId;
      const activationUrl =
        payment.metadata?.offerActivationUrl ||
        (payment.metadata?.offerId &&
          process.env[`KAJABI_ACTIVATION_URL_${payment.metadata.offerId}`]) ||
        process.env.KAJABI_ACTIVATION_URL;

      const act = await activateKajabi({
        name,
        email,
        externalUserId,
        activationUrl,
      });
      if (!act.ok) {
        console.warn("Kajabi activation not confirmed:", act);
      }

      return res.status(200).send("OK");
    }

    // For all other statuses (failed, refunded, etc.)
    return res.status(200).send("IGNORED");
  } catch (err) {
    console.error("Webhook error:", err);
    // Always return 200 so Mollie doesn’t retry endlessly
    return res.status(200).send("OK");
  }
}
