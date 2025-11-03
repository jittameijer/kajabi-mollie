// /pages/api/webhooks/kajabi.js
// Kajabi webhook: wanneer klant in Kajabi opzegt -> stop toekomstige incasso's bij Mollie

export const config = { api: { bodyParser: true } };

// ✅ simpele authorisatie (header of ?secret=...) — zet KAJABI_WEBHOOK_SECRET in Vercel
function authorized(req) {
  const need = process.env.KAJABI_WEBHOOK_SECRET;
  if (!need) return true;
  const headerOk = req.headers["x-kajabi-secret"] === need;

  const qFromQuery = req.query && req.query.secret;
  let qFromUrl = null;
  try {
    if (req.url) {
      const u = new URL(req.url, "http://localhost");
      qFromUrl = u.searchParams.get("secret");
    }
  } catch {}
  return headerOk || qFromQuery === need || qFromUrl === need;
}

async function withTimeout(promise, ms, label = "op") {
  return Promise.race([
    promise,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`Timeout na ${ms}ms tijdens ${label}`)), ms)
    ),
  ]);
}

export default async function handler(req, res) {
  const { alert } = await import("../../../lib/alert.js"); // lazy import

  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
    if (!authorized(req)) {
      await alert("warn", "Kajabi webhook unauthorized", {});
      return res.status(401).send("Unauthorized");
    }

    // Body kan al object zijn
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const event = (body?.event || "").toString();
    const payload = body?.payload || {};

    // Alleen bij cancel-events handelen; anderen ACK-en
    const isCancel =
      event === "subscription_canceled" ||
      event === "purchase_canceled" ||
      (event && (event.toLowerCase().includes("canceled") || event.toLowerCase().includes("cancelled")));

    if (!isCancel) {
      return res.status(200).json({ received: true, ignored: event || "(no-event)" });
    }

    // ——— Redis lookup keys ———
    const purchaseId = payload.purchase_id || body.id || null;
    const memberId = payload.member_id || null;
    const email = payload.email || null;

    const key =
      (purchaseId && `kajabi:purchase:${purchaseId}`) ||
      (memberId && `kajabi:member:${memberId}`) ||
      (email && `kajabi:email:${email}`) ||
      null;

    if (!key) {
      await alert("warn", "Cancel: geen sleutel om mapping te vinden", { event, hasPurchaseId: !!purchaseId, hasMemberId: !!memberId, hasEmail: !!email });
      return res.status(200).json({ received: true, missingKey: true });
    }

    // ——— Upstash Redis ———
    const { Redis } = await import("@upstash/redis");
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });

    let ids = await withTimeout(redis.hgetall(key), 3500, "Redis hgetall");
    // ids: { mollieCustomerId, mollieSubscriptionId, ... }
    if (!ids?.mollieCustomerId || !ids?.mollieSubscriptionId) {
      await alert("warn", "Cancel: mapping niet gevonden", { key, event });
      return res.status(200).json({ received: true, noMapping: true, key });
    }

    // ——— Cancel bij Mollie ———
    const url = `https://api.mollie.com/v2/customers/${ids.mollieCustomerId}/subscriptions/${ids.mollieSubscriptionId}`;

    const mRes = await withTimeout(
      fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${process.env.MOLLIE_API_KEY}` } }),
      6000,
      "Mollie DELETE subscription"
    );

    // 404 behandelen als idempotent success
    if (!mRes.ok && mRes.status !== 404) {
      const text = await mRes.text().catch(() => "");
      console.error("Mollie cancel error:", mRes.status, text);
      await alert("error", "Cancel: Mollie delete failed", {
        status: mRes.status,
        key,
      });
      return res.status(500).json({ error: `Mollie: ${mRes.status}`, details: text });
    }

    await withTimeout(
      redis.hset(key, { canceledAt: new Date().toISOString() }),
      2000,
      "Redis hset canceledAt"
    );

    await alert("info", "Subscription cancelled via Kajabi webhook", {
      key,
      alreadyCanceled: mRes.status === 404,
    });

    return res.status(200).json({ success: true, alreadyCanceled: mRes.status === 404, key });
  } catch (err) {
    console.error("Kajabi webhook fatal error:", err);
    const { alert } = await import("../../../lib/alert.js").catch(() => ({ alert: async () => {} }));
    await alert("error", "Kajabi webhook exception", { error: String(err) });
    return res.status(500).send("Internal error");
  }
}
