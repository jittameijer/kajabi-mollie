// /api/cancel-complete.js
import crypto from "crypto";

export const config = { runtime: "nodejs" };

const SUCCESS_REDIRECT =
  process.env.CANCEL_SUCCESS_REDIRECT ||
  "https://www.fortnegenacademy.nl/annuleren-bedankt"; // Kajabi page with Page Automation → add tag
const FAILURE_REDIRECT =
  process.env.CANCEL_FAILURE_REDIRECT ||
  "https://www.fortnegenacademy.nl/help";

const SECRET = process.env.CANCEL_LINK_SECRET || "dev-secret";

// --- base64url helpers ---
function b64urlToBuf(s) {
  s = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}
function b64urlJsonDecode(s) {
  try {
    return JSON.parse(b64urlToBuf(s).toString("utf8"));
  } catch {
    return null;
  }
}

// --- token verify (matches your /api/cancel-request signing) ---
function verify(token, secret) {
  const [payloadB64u, signatureB64u] = String(token || "").split(".");
  if (!payloadB64u || !signatureB64u) throw new Error("Bad token");

  // You sign the *base64url string* itself:
  const expected = crypto.createHmac("sha256", secret).update(payloadB64u).digest();
  const given = b64urlToBuf(signatureB64u);

  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    throw new Error("Bad sig");
  }

  const data = b64urlJsonDecode(payloadB64u);
  if (!data) throw new Error("Bad payload");
  if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) throw new Error("Expired");
  return data; // { email, customerId, subscriptionId, key, exp }
}

async function listActiveSubs(customerId) {
  const r = await fetch(
    `https://api.mollie.com/v2/customers/${customerId}/subscriptions?limit=50`,
    { headers: { Authorization: `Bearer ${process.env.MOLLIE_API_KEY}` } }
  );
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({}));
  return (j?._embedded?.subscriptions || []).filter(s => ["active","pending"].includes(s.status));
}

async function cancelSub(customerId, subscriptionId) {
  const url = `https://api.mollie.com/v2/customers/${customerId}/subscriptions/${subscriptionId}`;
  const r = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${process.env.MOLLIE_API_KEY}` },
  });
  return r.status; // 204 success; 404/410 already canceled; other 4xx/5xx error
}

async function loadRedis() {
  const { Redis } = await import("@upstash/redis");
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    const data = verify(token, SECRET);
    const { customerId, subscriptionId, key, email } = data;

    // Optional: single-use guard (best effort)
    try {
      const redis = await loadRedis();
      const nonceKey = `cancel:used:${token.slice(-24)}`;
      const used = await redis.get(nonceKey);
      if (used) {
        res.statusCode = 302;
        res.setHeader("Location", SUCCESS_REDIRECT);
        return res.end();
      }
      await redis.set(nonceKey, "1", { ex: 60 * 60 * 24 * 7 });
    } catch {}

    // Try the provided subscriptionId first
    let results = [];
    if (customerId && subscriptionId) {
      const st = await cancelSub(customerId, subscriptionId);
      results.push({ subscriptionId, httpStatus: st });
    }

    // If not successful, also cancel any other active subs
    const last = results.at(-1);
    const needFallback =
      !results.length || (last && ![204, 404, 410].includes(last.httpStatus));
    if (customerId && needFallback) {
      const actives = await listActiveSubs(customerId);
      for (const s of actives) {
        if (s.id === subscriptionId) continue; // already attempted
        const st = await cancelSub(customerId, s.id);
        results.push({ subscriptionId: s.id, httpStatus: st });
      }
    }

    // Audit in Redis (and mark mapping)
    try {
      const redis = await loadRedis();
      const mappingKey = key || (email ? `kajabi:email:${email}` : null);
      if (mappingKey) {
        await redis.hset(mappingKey, {
          canceledAt: new Date().toISOString(),
          lastCancelResults: JSON.stringify(results),
        });
      }
      if (email) {
        await redis.hset(`audit:cancel:${email}`, {
          ts: new Date().toISOString(),
          email,
          customerId,
          results: JSON.stringify(results),
          source: "email_link",
        });
      }
    } catch {}

    // Always redirect to Kajabi so your tag gets added via Page Automation
    res.statusCode = 302;
    res.setHeader("Location", SUCCESS_REDIRECT);
    return res.end();
  } catch (e) {
    console.error("cancel-complete error:", e);
    res.statusCode = 302;
    res.setHeader("Location", FAILURE_REDIRECT);
    return res.end();
  }
}
