// /api/mollie-webhook.js
// Handles Mollie payment webhooks (server-to-server).
// On first successful payment: create subscription + activate Kajabi.

import fetch from "node-fetch";
import { alert } from "../lib/alert.js"; // ✅ Slack alerts

export const config = {
  api: {
    // We parsen zelf (werkt voor x-www-form-urlencoded én JSON)
    bodyParser: false,
  },
};

// ——— Helpers ———
function nextMonthDate(iso) {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const firstNext = new Date(Date.UTC(y, m + 1, 1));
  const maxDay = new Date(Date.UTC(firstNext.getUTCFullYear(), firstNext.getUTCMonth() + 1, 0)).getUTCDate();
  firstNext.setUTCDate(Math.min(day, maxDay));
  return firstNext.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function parseWebhookId(req) {
  const raw = await readRawBody(req);
  const ct = (req.headers["content-type"] || "").toLowerCase();

  // 1) application/x-www-form-urlencoded (Mollie default)
  if (ct.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(raw);
    const id = params.get("id") || params.get("payment[id]");
    return { id, _raw: raw, _ct: ct };
  }

  // 2) JSON (voor handmatige tests)
  if (ct.includes("application/json")) {
    try {
      const obj = JSON.parse(raw || "{}");
      return { id: obj?.id || obj?.payment?.id || null, _raw: obj, _ct: ct };
    } catch {
      return { id: null, _raw: raw, _ct: ct };
    }
  }

  // 3) Fallback
  try {
    const params = new URLSearchParams(raw);
    const id = params.get("id");
    return { id, _raw: raw, _ct: ct || "unknown" };
  } catch {
    return { id: null, _raw: raw, _ct: ct || "unknown" };
  }
}

async function activateKajabi({ name, email, externalUserId, activationUrl }) {
  if (!activationUrl || !email || !externalUserId) {
    console.warn("Kajabi activation skipped (missing fields)", {
      hasUrl: !!activationUrl,
      email,
      externalUserId,
    });
    return { ok: false, skipped: true };
  }

  try {
    const resp = await fetch(activationUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name || email,
        email,
        external_user_id: externalUserId,
      }),
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

// ——— Handler ———
export default async function handler(req, res) {
  try {
    // Parse id uit form-url-encoded of JSON
    const { id: paymentId, _ct, _raw } = await parseWebhookId(req);
    if (!paymentId) {
      console.error("Webhook missing id. CT:", _ct, "Body:", _raw);
      await alert("warn", "Webhook: missing payment id", { contentType: _ct });
      return res.status(200).send("OK"); // altijd 200 zodat Mollie niet blijft retried
    }

    // 1️⃣ Haal definitieve payment op bij Mollie
    const pResp = await fetch(`https://api.mollie.com/v2/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${process.env.MOLLIE_API_KEY}` },
    });
    const payment = await pResp.json().catch(() => ({}));
    if (!pResp.ok) {
      console.error("Fetch payment failed:", pResp.status, payment);
      await alert("error", "Webhook: fetch payment failed", { paymentId, status: pResp.status });
      return res.status(200).send("OK");
    }

    console.log("Webhook payment:", paymentId, payment.status, payment.sequenceType);

    // Alleen bij geslaagde 'first' betaling
    if (payment.status === "paid" && payment.sequenceType === "first") {
      const customerId = payment.customerId;
      const startDate = nextMonthDate(payment.paidAt || payment.createdAt);

      // 2️⃣ Maak abonnement aan (start volgende maand)
      const publicBase = process.env.PUBLIC_BASE_URL || ""; // bv. https://kajabi-mollie.vercel.app
      const webhookUrl = publicBase ? `${publicBase}/api/mollie-webhook` : undefined;

      const subResp = await fetch(`https://api.mollie.com/v2/customers/${customerId}/subscriptions`, {
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
          ...(webhookUrl ? { webhookUrl } : {}),
        }),
      });
      const subscription = await subResp.json().catch(() => ({}));
      if (!subResp.ok || !subscription?.id) {
        console.error("Subscription creation failed:", subResp.status, subscription);
        await alert("error", "Webhook: subscription creation failed", {
          paymentId,
          customerId,
          status: subResp.status,
        });
        // toch door met Kajabi-activatie; abonnement kun je later repareren
      } else {
        console.log("Subscription created:", subscription.id);
        await alert("info", "Webhook: subscription created", {
          subscriptionId: subscription.id,
          customerId,
        });
      }

      // 3️⃣ Activeer Kajabi offer
      const name = payment.metadata?.name || payment.details?.consumerName || "";
      const email = payment.metadata?.email || payment.billingEmail || payment.email || "";
      const externalUserId = payment.metadata?.externalUserId || payment.customerId || customerId;
      const activationUrl =
        payment.metadata?.offerActivationUrl ||
        (payment.metadata?.offerId && process.env[`KAJABI_ACTIVATION_URL_${payment.metadata.offerId}`]) ||
        process.env.KAJABI_ACTIVATION_URL;

      const act = await activateKajabi({ name, email, externalUserId, activationUrl });
      if (!act.ok) {
        console.warn("Kajabi activation not confirmed:", act);
        await alert("warn", "Webhook: Kajabi activation not confirmed", {
          paymentId,
          customerId,
          status: act.status || null,
        });
      } else {
        await alert("info", "Webhook: Kajabi activation success", { customerId });
      }
    } else {
      // Andere statussen (failed, refunded, open, pending, second, etc.)
      await alert("info", "Webhook: ignored payment status", {
        paymentId,
        status: payment.status,
        sequenceType: payment.sequenceType,
      });
    }

    // Antwoord altijd 200
    return res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook error:", err);
    await alert("error", "Webhook: exception", { error: String(err) });
    return res.status(200).send("OK");
  }
}
