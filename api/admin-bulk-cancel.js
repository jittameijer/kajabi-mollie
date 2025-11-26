// /api/admin-bulk-cancel.js
// Admin-only endpoint: cancel subscriptions for a list of emails
// WITHOUT sending them an email / magic link.
// It mirrors /api/cancel-complete.js logic, but is triggered manually.

export const config = { runtime: "nodejs" };

import { Redis } from "@upstash/redis";

const ADMIN_CANCEL_SECRET =
  process.env.ADMIN_CANCEL_SECRET || "dev-admin-cancel-secret";

function toIsoDate(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function fetchMollieSubscription(customerId, subscriptionId) {
  const url = `https://api.mollie.com/v2/customers/${customerId}/subscriptions/${subscriptionId}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.MOLLIE_API_KEY}` },
  });

  const text = await r.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    console.error("JSON parse error for subscription", url, text.slice(0, 200));
  }

  if (!r.ok) {
    console.error("Fetch subscription failed:", r.status, url, text.slice(0, 200));
    return null;
  }

  return json;
}

async function listCustomerSubscriptions(customerId) {
  const url = `https://api.mollie.com/v2/customers/${customerId}/subscriptions?limit=50`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.MOLLIE_API_KEY}` },
  });

  const text = await r.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    console.error("JSON parse error for subs list", url, text.slice(0, 200));
  }

  if (!r.ok) {
    console.error("List subscriptions failed:", r.status, url, text.slice(0, 200));
    return [];
  }

  return json?._embedded?.subscriptions || [];
}

/**
 * Compute the date until which the user should keep access,
 * based on the Mollie subscription.
 *
 * Logic:
 * - If nextPaymentDate exists -> that's the next billing date, use it (no -1 day).
 * - Else if startDate exists -> user cancelled before first recurring charge,
 *   so they're paid until startDate.
 * - Fallback: today.
 */
async function computeCancelAtDate(customerId, subscriptionId) {
  const todayIso = toIsoDate(new Date());
  const sub = await fetchMollieSubscription(customerId, subscriptionId);
  if (!sub) return todayIso;

  if (sub.nextPaymentDate) {
    const d = sub.nextPaymentDate;
    return d < todayIso ? todayIso : d;
  }

  if (sub.startDate) {
    const d = sub.startDate;
    return d < todayIso ? todayIso : d;
  }

  return todayIso;
}

async function cancelMollieSubscription(customerId, subscriptionId) {
  try {
    const url = `https://api.mollie.com/v2/customers/${customerId}/subscriptions/${subscriptionId}`;
    const r = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${process.env.MOLLIE_API_KEY}` },
    });
    return r.status; // 204/404/410 all acceptable
  } catch (e) {
    console.error("cancelMollieSubscription error:", e);
    return 0;
  }
}

async function parseJsonBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

export default async function handler(req, res) {
  // Auth: Admin secret
  const auth = req.headers["authorization"] || req.headers["Authorization"];
  const expected = `Bearer ${ADMIN_CANCEL_SECRET}`;
  if (auth !== expected) {
    res.statusCode = 401;
    return res.end("Unauthorized");
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end("Method Not Allowed");
  }

  const body =
    req.body && typeof req.body === "object"
      ? req.body
      : await parseJsonBody(req);

  const emailsRaw = body?.emails || [];
  const emails = Array.isArray(emailsRaw)
    ? emailsRaw.map((e) => String(e || "").toLowerCase().trim()).filter(Boolean)
    : [];

  if (!emails.length) {
    res.statusCode = 400;
    return res.end("Missing emails[]");
  }

  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });

  const results = [];

  for (const email of emails) {
    const key = `kajabi:email:${email}`;
    const record = await redis.hgetall(key);

    if (!record || !record.mollieCustomerId) {
      results.push({
        email,
        ok: false,
        reason: "no_redis_mapping_or_customerId",
      });
      continue;
    }

    let customerId = record.mollieCustomerId;
    let subscriptionId = record.mollieSubscriptionId || null;

    // If we don't have a subscriptionId yet, try to find an active one in Mollie
    if (!subscriptionId) {
      const subs = await listCustomerSubscriptions(customerId);
      const active =
        subs.find((s) => ["active", "pending"].includes(s.status)) || subs[0];

      if (!active) {
        results.push({
          email,
          ok: false,
          reason: "no_active_subscription",
        });
        continue;
      }

      subscriptionId = active.id;

      // Backfill Redis with this subscriptionId
      await redis.hset(key, {
        mollieSubscriptionId: subscriptionId,
        updatedAt: new Date().toISOString(),
      });
    }

    // Cancel in Mollie
    const status = await cancelMollieSubscription(customerId, subscriptionId);

    // Compute cancelAtDate
    const cancelAtDate = await computeCancelAtDate(customerId, subscriptionId);
    const nowIso = new Date().toISOString();

    // Update Redis: mark as cancelled + pending deactivation
    await redis.hset(key, {
      canceledAt: nowIso,
      cancelAtDate,
      mollieSubscriptionStatus: "canceled",
      primaryCancelStatus: status,
      updatedAt: nowIso,
      kajabiDeactivationPending: "true",
      kajabiDeactivatedAt: "",
    });

    // Add to deactivation set for cron job
    await redis.sadd("kajabi:deactivation_pending", email);

    results.push({
      email,
      ok: true,
      customerId,
      subscriptionId,
      cancelAtDate,
      mollieCancelStatus: status,
    });
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  return res.end(JSON.stringify({ ok: true, results }, null, 2));
}
