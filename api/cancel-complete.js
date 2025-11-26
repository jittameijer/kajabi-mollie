// /api/cancel-complete.js
// Handles the final step when a user clicks the "cancel subscription" link
// from the email sent by /api/cancel-request.

import crypto from "crypto";

export const config = { runtime: "nodejs" };

// Where to send the user after handling the cancel link
const SUCCESS_REDIRECT =
  process.env.CANCEL_SUCCESS_REDIRECT ||
  "https://www.fortnegenacademy.nl/bevestiginguitschrijven";

const FAILURE_REDIRECT =
  process.env.CANCEL_FAILURE_REDIRECT ||
  "https://www.fortnegenacademy.nl/help";

const SECRET = process.env.CANCEL_LINK_SECRET || "dev-secret";

// --- base64url helpers (mirror /api/cancel-request) ---

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

// --- token verification (must match /api/cancel-request signing) ---
//
// In /api/cancel-request, you sign:
//   payload = base64url(JSON)
//   sig = HMAC_SHA256(secret, payload)
//   token = payload + "." + base64url(sig)
//
// Here we verify in the same way.
function verifyToken(token, secret) {
  const [payloadB64u, signatureB64u] = String(token || "").split(".");
  if (!payloadB64u || !signatureB64u) {
    throw new Error("Bad token format");
  }

  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(payloadB64u)
    .digest();
  const givenSig = b64urlToBuf(signatureB64u);

  if (
    expectedSig.length !== givenSig.length ||
    !crypto.timingSafeEqual(expectedSig, givenSig)
  ) {
    throw new Error("Invalid signature");
  }

  const data = b64urlJsonDecode(payloadB64u);
  if (!data) throw new Error("Invalid payload");

  const now = Math.floor(Date.now() / 1000);
  if (!data.exp || data.exp < now) {
    throw new Error("Token expired");
  }

  return data; // { email, customerId, subscriptionId, key, exp }
}

// --- Mollie helpers ---

async function listActiveSubs(customerId) {
  try {
    const r = await fetch(
      `https://api.mollie.com/v2/customers/${customerId}/subscriptions?limit=50`,
      {
        headers: {
          Authorization: `Bearer ${process.env.MOLLIE_API_KEY}`,
        },
      }
    );

    if (!r.ok) {
      console.error("listActiveSubs Mollie error:", r.status);
      return [];
    }

    const j = await r.json().catch(() => ({}));
    const subs = Array.isArray(j?._embedded?.subscriptions)
      ? j._embedded.subscriptions
      : [];
    return subs.filter((s) => ["active", "pending"].includes(s.status));
  } catch (e) {
    console.error("listActiveSubs exception:", e);
    return [];
  }
}

async function cancelSub(customerId, subscriptionId) {
  try {
    const url = `https://api.mollie.com/v2/customers/${customerId}/subscriptions/${subscriptionId}`;
    const r = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${process.env.MOLLIE_API_KEY}` },
    });
    // 204: success, 404/410: already canceled/not found (we treat as success UX-wise)
    return r.status;
  } catch (e) {
    console.error("cancelSub exception:", e);
    return 0; // 0 = network/unknown error
  }
}

// --- Redis helper ---

async function loadRedis() {
  const { Redis } = await import("@upstash/redis");
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

// --- Main handler ---

export default async function handler(req, res) {
  // Only GET from the email link
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.end("Method Not Allowed");
  }

  try {
    // Parse token from query string
    const url = new URL(req.url, `https://${req.headers.host}`);
    const token = url.searchParams.get("token");
    if (!token) {
      throw new Error("Missing token");
    }

    const data = verifyToken(token, SECRET);
    const { customerId, subscriptionId, key, email } = data;

    if (!customerId) {
      throw new Error("Missing customerId in token");
    }

    // --- Single-use guard (best effort)
    try {
      const redis = await loadRedis();
      const nonceKey = `cancel:used:${token.slice(-24)}`; // tail is enough entropy

      const used = await redis.get(nonceKey);
      if (used) {
        // Already used link → just send them to success page for UX
        res.statusCode = 302;
        res.setHeader("Location", SUCCESS_REDIRECT);
        return res.end();
      }
      // Mark as used for 7 days
      await redis.set(nonceKey, "1", { ex: 60 * 60 * 24 * 7 });
    } catch (e) {
      console.error("Single-use guard failed:", e);
      // Non-fatal; still try to cancel
    }

    // --- Cancellation attempts ---
    const results = [];

    // 1) Try subscriptionId from the token first (if present)
    if (subscriptionId) {
      const st = await cancelSub(customerId, subscriptionId);
      results.push({ subscriptionId, httpStatus: st });
    }

    // 2) Fallback: cancel any other active/pending subscriptions if needed.
    const last = results.at(-1);
    const needFallback =
      !results.length || (last && ![204, 404, 410].includes(last.httpStatus));

    if (needFallback) {
      const activeSubs = await listActiveSubs(customerId);
      for (const s of activeSubs) {
        if (s.id === subscriptionId) continue; // already attempted
        const st = await cancelSub(customerId, s.id);
        results.push({ subscriptionId: s.id, httpStatus: st });
      }
    }

    // --- Audit & mapping updates in Redis ---
    try {
      const redis = await loadRedis();
      const mappingKey = key || (email ? `kajabi:email:${email}` : null);
      const nowIso = new Date().toISOString();

      if (mappingKey) {
        await redis.hset(mappingKey, {
          canceledAt: nowIso,
          mollieSubscriptionStatus: "canceled",
          lastCancelResults: JSON.stringify(results),
          updatedAt: nowIso,
        });
      }

      if (email) {
        await redis.hset(`audit:cancel:${email}`, {
          ts: nowIso,
          email,
          customerId,
          results: JSON.stringify(results),
          source: "email_link",
        });
      }
    } catch (e) {
      console.error("Redis audit/update failed:", e);
      // Non-fatal
    }

    // --- Always redirect to Kajabi success page (UX + automations) ---
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
