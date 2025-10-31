// /pages/api/webhooks/kajabi.js
// NOTE: Do NOT import "node-fetch" — Next.js already provides fetch().
// import fetch from "node-fetch";  <-- remove this line if you had it

export const config = { api: { bodyParser: true } };

function authorized(req) {
  const need = process.env.KAJABI_WEBHOOK_SECRET;
  if (!need) return true;

  // Header path (if Kajabi can send headers)
  const headerOk = req.headers["x-kajabi-secret"] === need;

  // Query path (works in Kajabi URL field: ?secret=...)
  // Prefer req.query (Pages Router); fall back to parsing req.url safely.
  const qFromQuery = req.query && req.query.secret;
  let qFromUrl = null;
  try {
    if (req.url) {
      // Use a dummy origin so URL() doesn’t need Host
      const u = new URL(req.url, "http://localhost");
      qFromUrl = u.searchParams.get("secret");
    }
  } catch {
    // ignore
  }

  return headerOk || qFromQuery === need || qFromUrl === need;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
    if (!authorized(req)) return res.status(401).send("Unauthorized");

    // Body may already be an object in Next.js
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const event = body?.event ?? "";
    const payload = body?.payload ?? {};

    // Log lightly to Vercel (check Deployments → Logs)
    console.log("Kajabi webhook event:", event, "payload keys:", Object.keys(payload || {}));

    // Only cancel on "cancel" type events; ack others
    const isCancel =
      event === "subscription_canceled" ||
      event === "purchase_canceled" ||
      (typeof event === "string" && (event.toLowerCase().includes("canceled") || event.toLowerCase().includes("cancelled")));

    if (!isCancel) {
      return res.status(200).json({ received: true, ignored: event || "(no-event)" });
    }

    // ---- Lookup mapping (Upstash Redis) ----
    // Lazy import to avoid cold-start ESM glitches
    const { Redis } = await import("@upstash/redis");
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });

    const purchaseId = payload.purchase_id || body.id || null;
    const memberId = payload.member_id || null;
    const email = payload.email || null;

    const key =
      (purchaseId && `kajabi:purchase:${purchaseId}`) ||
      (memberId && `kajabi:member:${memberId}`) ||
      (email && `kajabi:email:${email}`) ||
      null;

    if (!key) return res.status(200).json({ received: true, missingKey: true });

    const ids = await redis.hgetall(key); // { mollieCustomerId, mollieSubscriptionId }
    if (!ids?.mollieCustomerId || !ids?.mollieSubscriptionId) {
      return res.status(200).json({ received: true, noMapping: true, key });
    }

    // ---- Cancel at Mollie ----
    const url = `https://api.mollie.com/v2/customers/${ids.mollieCustomerId}/subscriptions/${ids.mollieSubscriptionId}`;
    const mRes = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${process.env.MOLLIE_API_KEY}` },
    });

    // Treat 404 as idempotent success
    if (!mRes.ok && mRes.status !== 404) {
      const text = await mRes.text().catch(() => "");
      console.error("Mollie error:", mRes.status, text);
      return res.status(500).json({ error: `Mollie: ${mRes.status}`, details: text });
    }

    await redis.hset(key, { canceledAt: new Date().toISOString() });
    return res.status(200).json({ success: true, alreadyCanceled: mRes.status === 404, key });
  } catch (err) {
    console.error("Kajabi webhook fatal error:", err);
    return res.status(500).send("Internal error");
  }
}
