// /api/import-existing-subs.js
// One-time script to import existing *active* Mollie subscriptions into Redis,
// so they can use the self-service cancel flow.

export const config = { runtime: "nodejs" };

import { Redis } from "@upstash/redis";

const IMPORT_SECRET = process.env.IMPORT_SECRET || "dev-import-secret";

const OFFER_CONFIG = {
  // Adjust amounts/intervals if needed
  OFFER1: { amount: "12.00", interval: "1 month" },
  OFFER2: { amount: "12.00", interval: "1 month" },
  OFFER3: { amount: "120.00", interval: "1 year" },
};

async function fetchJson(url) {
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.MOLLIE_API_KEY}` },
  });
  const text = await r.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    console.error("JSON parse error for", url, text.slice(0, 200));
  }
  if (!r.ok) {
    console.error("Mollie fetch failed:", r.status, url, text.slice(0, 200));
    throw new Error("Mollie fetch failed " + r.status);
  }
  return json;
}

async function listAllMollieCustomers(limit = 250) {
  const customers = [];
  let url = `https://api.mollie.com/v2/customers?limit=${limit}`;

  while (url) {
    const page = await fetchJson(url);
    const items = page?._embedded?.customers || [];
    customers.push(...items);

    const next = page?._links?.next?.href;
    url = next || null;
  }

  return customers;
}

async function listCustomerSubscriptions(customerId, limit = 50) {
  const subs = [];
  let url = `https://api.mollie.com/v2/customers/${customerId}/subscriptions?limit=${limit}`;

  while (url) {
    const page = await fetchJson(url);
    const items = page?._embedded?.subscriptions || [];
    subs.push(...items);

    const next = page?._links?.next?.href;
    url = next || null;
  }

  return subs;
}

// Try to guess offerId from amount+interval
function guessOfferId(sub) {
  const amount = sub?.amount?.value || "";
  const interval = sub?.interval || "";

  for (const [offerId, cfg] of Object.entries(OFFER_CONFIG)) {
    if (cfg.amount === amount && cfg.interval === interval) {
      return offerId;
    }
  }

  // fallback to metadata or UNKNOWN
  return sub.metadata?.offerId || "UNKNOWN";
}

export default async function handler(req, res) {
  // Protect this endpoint
  const authHeader = req.headers["authorization"] || req.headers["Authorization"];
  const expected = `Bearer ${IMPORT_SECRET}`;
  if (authHeader !== expected) {
    res.statusCode = 401;
    return res.end("Unauthorized");
  }

  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end("Method Not Allowed");
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const force = url.searchParams.get("force") === "1"; // ?force=1 to overwrite existing

  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });

  try {
    console.log("[IMPORT] Starting import of existing active Mollie subscriptions...");
    const customers = await listAllMollieCustomers(250);
    console.log("[IMPORT] Customers fetched:", customers.length);

    const summary = {
      customersProcessed: 0,
      subsSeen: 0,
      activeSubsSeen: 0,
      recordsCreated: 0,
      recordsSkippedExisting: 0,
      recordsSkippedNoEmail: 0,
    };

    for (const c of customers) {
      summary.customersProcessed += 1;
      const customerId = c.id;
      const emailRaw = c.email || c.metadata?.email || "";
      const email = (emailRaw || "").toLowerCase().trim();

      if (!email) {
        summary.recordsSkippedNoEmail += 1;
        continue;
      }

      const subs = await listCustomerSubscriptions(customerId, 50);
      if (!subs.length) continue;

      // Only consider active / pending subscriptions
      const activeSubs =
        subs.filter((s) => ["active", "pending"].includes(s.status)) || [];
      if (!activeSubs.length) continue;

      for (const sub of activeSubs) {
        summary.subsSeen += 1;
        summary.activeSubsSeen += 1;

        const subscriptionId = sub.id;
        const key = `kajabi:email:${email}`;
        const existing = await redis.hgetall(key);

        if (existing && Object.keys(existing).length && !force) {
          summary.recordsSkippedExisting += 1;
          continue;
        }

        const offerId = guessOfferId(sub);
        const nowIso = new Date().toISOString();

        const baseFields = {
          mollieCustomerId: customerId,
          mollieSubscriptionId: subscriptionId,
          offerId,
          updatedAt: nowIso,
        };

        await redis.hset(key, baseFields);

        // Also store mapping by customerId for future lookups
        await redis.hset(`mollie:customer:${customerId}`, {
          lastEmail: email,
          lastSubscriptionId: subscriptionId,
          updatedAt: nowIso,
        });

        summary.recordsCreated += 1;
        console.log("[IMPORT] Saved mapping for", email, baseFields);
      }
    }

    console.log("[IMPORT] Finished:", summary);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: true, summary }, null, 2));
  } catch (e) {
    console.error("[IMPORT] Error:", e);
    res.statusCode = 500;
    return res.end("Import error");
  }
}
