// /pages/api/webhooks/kajabi.js
import fetch from "node-fetch";
import { Redis } from "@upstash/redis";

export const config = { api: { bodyParser: true } };

// Simple shared-secret auth (set the same value in Kajabi request header)
function authorized(req) {
  const need = process.env.KAJABI_WEBHOOK_SECRET;
  if (!need) return true; // allow if not configured
  const got = req.headers["x-kajabi-secret"];
  return got && got === need;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
  if (!authorized(req)) return res.status(401).send("Unauthorized");

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const event = body?.event ?? "";
    const payload = body?.payload ?? {};

    // accept common cancel names; adjust if your payload uses a specific string
    const isCancel =
      event === "subscription_canceled" ||
      event === "purchase_canceled" ||
      event?.toLowerCase()?.includes("canceled") ||
      event?.toLowerCase()?.includes("cancelled");

    // Ack non-cancel events so Kajabi doesn't retry
    if (!isCancel) return res.status(200).json({ received: true, ignored: event });

    // Choose the best lookup key you get from Kajabi
    const purchaseId = payload.purchase_id || body.id; // some Kajabi payloads put id at root
    const memberId = payload.member_id;
    const email = payload.email;

    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });

    // Build the first existing key among purchase/member/email
    const key =
      (purchaseId && `kajabi:purchase:${purchaseId}`) ||
      (memberId && `kajabi:member:${memberId}`) ||
      (email && `kajabi:email:${email}`);

    if (!key) return res.status(200).json({ received: true, missingKey: true });

    // Fetch the saved mapping from your Upstash Redis
    const ids = await redis.hgetall(key); // { mollieCustomerId, mollieSubscriptionId, ... }
    if (!ids?.mollieCustomerId || !ids?.mollieSubscriptionId) {
      // Nothing to cancel — don't retry forever
      return res.status(200).json({ received: true, noMapping: true });
    }

    // Cancel future Mollie charges for this subscription
    const url = `https://api.mollie.com/v2/customers/${ids.mollieCustomerId}/subscriptions/${ids.mollieSubscriptionId}`;
    const mRes = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${process.env.MOLLIE_API_KEY}` },
    });

    // Treat 404 as idempotent success (already canceled)
    if (!mRes.ok && mRes.status !== 404) {
      const text = await mRes.text().catch(() => "");
      // 500 -> let Kajabi retry if Mollie was temporarily unavailable
      return res.status(500).json({ error: `Mollie: ${mRes.status} ${text}` });
    }

    // Optional: mark it canceled for debugging/idempotency
    await redis.hset(key, { canceledAt: new Date().toISOString() });

    return res.status(200).json({ success: true, alreadyCanceled: mRes.status === 404 });
  } catch (err) {
    console.error("Kajabi webhook error:", err);
    // 500 encourages Kajabi to retry on transient issues
    return res.status(500).json({ error: "Internal error" });
  }
}
