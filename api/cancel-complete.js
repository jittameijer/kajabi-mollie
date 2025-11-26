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

  return data; // { email, customerId, subscriptionId, key, exp }
}

// -------------------- Mollie Helpers --------------------
function toIsoDate(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function fetchMollieSubscription(customerId, subscriptionId) {
  const url = `https://api.mollie.com/v2/customers/${customerId}/subscriptions/${subscriptionId}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.MOLLIE_API_KEY}` },
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    console.error("Fetch subscription failed:", r.status, text);
    return null;
  }

  return await r.json().catch(() => null);
}

/**
 * Compute the date until which the user should keep access.
 *
 * Rules:
 * - If nextPaymentDate exists -> that's the next billing date, so use that
 *   (you chose not to subtract 1 day).
 * - If no nextPaymentDate yet, but startDate exists -> use startDate
 *   (user cancelled before the first recurring charge, so they're paid until startDate).
 * - Fallback: today.
 */
async function computeCancelAtDate(customerId, subscriptionId) {
  const todayIso = toIsoDate(new Date());
  const sub = await fetchMollieSubscription(customerId, subscriptionId);
  if (!sub) return todayIso;

  // 1) Best: Mollie explicitly tells us the nextPaymentDate
  if (sub.nextPaymentDate) {
    const d = sub.nextPaymentDate;
    return d < todayIso ? todayIso : d;
  }

  // 2) No nextPaymentDate yet (e.g. cancelled before first recurring)
  //    In that case, startDate is the first recurring date = end of current paid period.
  if (sub.startDate) {
    const d = sub.startDate;
    return d < todayIso ? todayIso : d;
  }

  // 3) Fallback
  return todayIso;
}

async function cancelMollieSubscription(customerId, subscriptionId) {
  try {
    const r = await fetch(
      `https://api.mollie.com/v2/customers/${customerId}/subscriptions/${subscriptionId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${process.env.MOLLIE_API_KEY}` },
      }
    );
    return r.status; // 204/404/410 are fine from UX perspective
  } catch (e) {
    console.error("cancelMollieSubscription error:", e);
    return 0;
  }
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
    if (!token) throw new Error("Missing token");

    const { email, customerId, subscriptionId, key } = verifyToken(
      token,
      SECRET
    );

    const { Redis } = await import("@upstash/redis");
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });

    // --- Single-use guard ---
    const nonceKey = `cancel:used:${token.slice(-24)}`;
    const used = await redis.get(nonceKey);
    if (used) {
      res.statusCode = 302;
      res.setHeader("Location", SUCCESS_REDIRECT);
      return res.end();
    }
    await redis.set(nonceKey, "1", { ex: 60 * 60 * 24 * 7 }); // 7 days

    // --- Cancel primary subscription in Mollie ---
    const primaryStatus = await cancelMollieSubscription(
      customerId,
      subscriptionId
    );

    // --- Compute cancelAtDate based on Mollie subscription ---
    let cancelAtDate = await computeCancelAtDate(customerId, subscriptionId);
    if (!cancelAtDate) {
      cancelAtDate = toIsoDate(new Date());
    }

    const mappingKey = key || (email ? `kajabi:email:${email}` : null);
    const nowIso = new Date().toISOString();

    if (mappingKey) {
      await redis.hset(mappingKey, {
        canceledAt: nowIso,
        cancelAtDate,
        mollieSubscriptionStatus: "canceled",
        primaryCancelStatus: primaryStatus,
        updatedAt: nowIso,
        kajabiDeactivationPending: "true",
        kajabiDeactivatedAt: "",
      });

      if (email) {
        await redis.sadd("kajabi:deactivation_pending", email);
      }
    }

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
