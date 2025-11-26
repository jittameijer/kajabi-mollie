// /api/cancel-complete.js
import crypto from "crypto";
export const config = { runtime: "nodejs" };

const SUCCESS_REDIRECT =
  process.env.CANCEL_SUCCESS_REDIRECT ||
  "https://www.fortnegenacademy.nl/bevestiginguitschrijven";

const FAILURE_REDIRECT =
  process.env.CANCEL_FAILURE_REDIRECT ||
  "https://www.fortnegenacademy.nl/help";

const SECRET = process.env.CANCEL_LINK_SECRET || "dev-secret";

// -------------------- Base64url Helpers --------------------
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

// -------------------- Token verification --------------------
function verifyToken(token, secret) {
  const [payloadB64u, signatureB64u] = String(token || "").split(".");
  if (!payloadB64u || !signatureB64u) throw new Error("Bad token format");

  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(payloadB64u)
    .digest();
  const givenSig = b64urlToBuf(signatureB64u);

  if (
    expectedSig.length !== givenSig.length ||
    !crypto.timingSafeEqual(expectedSig, givenSig)
  ) {
    throw new Error("Bad signature");
  }

  const data = b64urlJsonDecode(payloadB64u);
  if (!data) throw new Error("Bad payload");

  const now = Math.floor(Date.now() / 1000);
  if (!data.exp || data.exp < now) throw new Error("Expired token");

  return data; // contains { email, customerId, subscriptionId, key, exp }
}

// -------------------- Mollie Helpers --------------------
async function fetchMollieSubscription(customerId, subscriptionId) {
  const url = `https://api.mollie.com/v2/customers/${customerId}/subscriptions/${subscriptionId}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.MOLLIE_API_KEY}` },
  });

  if (!r.ok) {
    console.error("Fetch subscription failed:", r.status);
    return null;
  }

  return await r.json().catch(() => null);
}

function toIsoDate(d) {
  return d.toISOString().slice(0, 10);
}

// 👉 You requested no -1 day offset
async function computeCancelAtDate(customerId, subscriptionId) {
  const sub = await fetchMollieSubscription(customerId, subscriptionId);
  if (!sub) return toIsoDate(new Date());

  // Best case: nextPaymentDate exists
  if (sub.nextPaymentDate) {
    return sub.nextPaymentDate; // no -1 day
  }

  // Fallback: startDate + interval
  if (sub.startDate && sub.interval) {
    const [countStr, unit] = sub.interval.split(" ");
    const count = parseInt(countStr, 10) || 1;
    const base = new Date(sub.startDate + "T00:00:00Z");

    if (unit.startsWith("month")) {
      base.setUTCMonth(base.getUTCMonth() + count);
    } else if (unit.startsWith("year")) {
      base.setUTCFullYear(base.getUTCFullYear() + count);
    }

    return toIsoDate(base);
  }

  // Final fallback: today
  return toIsoDate(new Date());
}

// -------------------- Buffers + Cancel Helpers --------------------

async function cancelMollieSubscription(customerId, subscriptionId) {
  const r = await fetch(
    `https://api.mollie.com/v2/customers/${customerId}/subscriptions/${subscriptionId}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${process.env.MOLLIE_API_KEY}` } }
  );

  return r.status; // 204, 404, 410 = OK from UX perspective
}

// -------------------- Main Handler --------------------
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end("Method Not Allowed");
  }

  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const token = url.searchParams.get("token");
    const { email, customerId, subscriptionId, key } = verifyToken(
      token,
      SECRET
    );

    const { Redis } = await import("@upstash/redis");
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });

    // Single-use guard
    const nonceKey = `cancel:used:${token.slice(-24)}`;
    const used = await redis.get(nonceKey);
    if (used) {
      res.statusCode = 302;
      res.setHeader("Location", SUCCESS_REDIRECT);
      return res.end();
    }
    await redis.set(nonceKey, "1", { ex: 60 * 60 * 24 * 7 });

    // Cancel primary subscription
    const primaryResult = await cancelMollieSubscription(
      customerId,
      subscriptionId
    );

    // Compute end date
    let cancelAtDate = await computeCancelAtDate(customerId, subscriptionId);

    const mappingKey = key || `kajabi:email:${email}`;
    const nowIso = new Date().toISOString();

    // Save data, mark pending for weekly cron
    await redis.hset(mappingKey, {
      canceledAt: nowIso,
      cancelAtDate,
      mollieSubscriptionStatus: "canceled",
      primaryCancelStatus: primaryResult,
      updatedAt: nowIso,
      kajabiDeactivationPending: "true",
      kajabiDeactivatedAt: "",
    });

    await redis.sadd("kajabi:deactivation_pending", email);

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
