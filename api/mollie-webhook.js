// /api/mollie-webhook.js
// Handles Mollie payment webhooks (server-to-server).
// On first successful payment: create subscription + activate Kajabi.

import fetch from "node-fetch";
// (keep your Slack alert import if present)
// import { alert } from "../lib/alert.js";

export const config = {
  api: { bodyParser: false },
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

  if (ct.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(raw);
    const id = params.get("id") || params.get("payment[id]");
    return { id, _raw: raw, _ct: ct };
  }

  if (ct.includes("application/json")) {
    try {
      const obj = JSON.parse(raw || "{}");
      return { id: obj?.id || obj?.payment?.id || null, _raw: obj, _ct: ct };
    } catch {
      return { id: null, _raw: raw, _ct: ct };
    }
  }

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
    console.warn("Kajabi activation skipped (missing fields)", { hasUrl: !!activationUrl, email, externalUserId });
    return { ok: false, skipped: true };
  }

  try {
    const resp = await fetch(activationUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name || email, email, external_user_id: externalUserId }),
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
    const { id: paymentId, _ct, _raw } = await parseWebhookId(req);
    if (!paymentId) {
      console.error("Webhook missing id. CT:", _ct, "Body:", _raw);
      return res.status(200).send("OK"); // keep 200 to avoid retries
    }

    // 1) Fetch payment
    const pResp = await fetch(`https://api.mollie.com/v2/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${process.env.MOLLIE_API_KEY}` },
    });
    const payment = await pResp.json().catch(() => ({}));
    if (!pResp.ok) {
      console.error("Fetch payment failed:", pResp.status, payment);
      return res.status(200).send("OK");
    }

    console.log("Webhook payment:", paymentId, payment.status, payment.sequenceType);

    // Only on successful 'first' payment
    if (payment.status === "paid" && payment.sequenceType === "first") {
      const customerId = payment.customerId;
      const startDate = nextMonthDate(payment.paidAt || payment.createdAt);

      // 2) Create subscription (start next cycle)
      const publicBase = process.env.PUBLIC_BASE_URL || "";
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
        // continue to Kajabi activation anyway
      } else {
        console.log("Subscription created:", subscription.id);

// ✅ Save mappings in Redis so cancel-request can find it (email) and keep other indices.
try {
  const { Redis } = await import("@upstash/redis");
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });

  // Normalize inputs
  const emailRaw =
    payment.metadata?.email ||
    payment.billingEmail ||
    payment.email ||
    "";
  const email = emailRaw.toLowerCase().trim();

  const purchaseId = payment.metadata?.kajabiPurchaseId || null; // e.g. p_TEST123
  const memberId   = payment.metadata?.kajabiMemberId   || null;
  const customerId = payment.customerId;

  // Always write the EMAIL mapping (primary for cancel flow)
  if (email) {
    await redis.hset(`kajabi:email:${email}`, {
      mollieCustomerId: customerId,
      ...(subscription?.id ? { mollieSubscriptionId: subscription.id } : {}),
      offerId: payment.metadata?.offerId || "",
      updatedAt: new Date().toISOString(),
    });
    console.log("Saved mapping in Redis:", `kajabi:email:${email}`);
  } else {
    console.warn("No email found on payment; wrote only non-email indices");
  }

  // Also write the secondary index you were using before (purchase/member/customer)
  if (purchaseId) {
    await redis.hset(`kajabi:purchase:${purchaseId}`, {
      mollieCustomerId: customerId,
      ...(subscription?.id ? { mollieSubscriptionId: subscription.id } : {}),
      offerId: payment.metadata?.offerId || "",
      updatedAt: new Date().toISOString(),
    });
    console.log("Saved mapping in Redis:", `kajabi:purchase:${purchaseId}`);
  }

  if (memberId) {
    await redis.hset(`kajabi:member:${memberId}`, {
      mollieCustomerId: customerId,
      ...(subscription?.id ? { mollieSubscriptionId: subscription.id } : {}),
      offerId: payment.metadata?.offerId || "",
      updatedAt: new Date().toISOString(),
    });
    console.log("Saved mapping in Redis:", `kajabi:member:${memberId}`);
  }

  // Fallback index on customer id (handy for debugging)
  await redis.hset(`mollie:customer:${customerId}`, {
    lastEmail: email || "",
    ...(subscription?.id ? { lastSubscriptionId: subscription.id } : {}),
    updatedAt: new Date().toISOString(),
  });
} catch (e) {
  console.error("Redis mapping save failed:", e);
}


      // 3) Activate Kajabi offer
      const name = payment.metadata?.name || payment.details?.consumerName || "";
      const email =
        (payment.metadata?.email || payment.billingEmail || payment.email || "").toLowerCase();
      const externalUserId = payment.metadata?.externalUserId || payment.customerId || customerId;
      const activationUrl =
        payment.metadata?.offerActivationUrl ||
        (payment.metadata?.offerId && process.env[`KAJABI_ACTIVATION_URL_${payment.metadata.offerId}`]) ||
        process.env.KAJABI_ACTIVATION_URL;

      const act = await activateKajabi({ name, email, externalUserId, activationUrl });
      if (!act.ok) console.warn("Kajabi activation not confirmed:", act);
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(200).send("OK");
  }
}
