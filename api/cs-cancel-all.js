// /api/cs-cancel-all.js
// For internal customer service:
// Cancel ALL active/pending/suspended subscriptions for a Mollie customer,
// verify email, and update Redis/Kajabi deactivation state.

export const config = { runtime: "nodejs" };

// --- CORS (similar pattern as cancel-request) ---
const ALLOW_ORIGIN =
  process.env.CS_PANEL_ORIGIN || "https://www.fortnegenacademy.nl";

function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

// --- Helpers ---
async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
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

function toIsoDate(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// Compute cancelAtDate for a subscription based on nextPaymentDate/startDate
function computeCancelAtDateFromSub(sub) {
  const todayIso = toIsoDate(new Date());

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

// Lazy Redis init (same Upstash approach you use elsewhere)
let redisPromise = null;
async function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  if (!redisPromise) {
    redisPromise = (async () => {
      const { Redis } = await import("@upstash/redis");
      return new Redis({ url, token });
    })();
  }
  return redisPromise;
}

// Optional alert logger (reuse your ../lib/alert.js pattern)
async function getAlert() {
  try {
    const mod = await import("../lib/alert.js");
    return typeof mod.alert === "function"
      ? mod.alert
      : () => Promise.resolve();
  } catch {
    return () => Promise.resolve();
  }
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end("Method Not Allowed");
  }

  const alert = await getAlert();

  try {
    const body = await readJsonBody(req);
    const customerId = String(body.customerId || "").trim();
    const email = String(body.email || "").toLowerCase().trim();

    if (!customerId || !email) {
      await alert("warn", "CS Cancel: missing customerId or email", {
        customerIdPresent: !!customerId,
        emailPresent: !!email,
      });
      res.statusCode = 400;
      return res.json({ error: "Missing customerId or email" });
    }

    // 1) Fetch customer from Mollie to verify email
    const customerResp = await fetch(
      `https://api.mollie.com/v2/customers/${encodeURIComponent(customerId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.MOLLIE_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const customer = await customerResp.json().catch(() => ({}));

    if (!customerResp.ok || !customer?.id) {
      console.error(
        "CS Cancel: customer fetch failed",
        customerResp.status,
        customer
      );
      await alert("warn", "CS Cancel: customer not found", {
        status: customerResp.status,
        customerId,
      });
      res.statusCode = 404;
      return res.json({ error: "Customer not found in Mollie" });
    }

    const mollieEmail = String(customer.email || "").trim().toLowerCase();
    if (!mollieEmail || mollieEmail !== email) {
      await alert("warn", "CS Cancel: email mismatch", {
        customerId,
        mollieEmail,
        givenEmail: email,
      });
      res.statusCode = 400;
      return res.json({
        error: "CustomerId and email do not match",
      });
    }

    // 2) List subscriptions for this customer
    const subsResp = await fetch(
      `https://api.mollie.com/v2/customers/${encodeURIComponent(
        customerId
      )}/subscriptions?limit=50`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.MOLLIE_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const subs = await subsResp.json().catch(() => ({}));

    if (!subsResp.ok || !subs?._embedded?.subscriptions) {
      console.error(
        "CS Cancel: list subscriptions failed",
        subsResp.status,
        subs
      );
      await alert("error", "CS Cancel: could not list subscriptions", {
        status: subsResp.status,
        customerId,
      });
      res.statusCode = 500;
      return res.json({ error: "Could not fetch subscriptions" });
    }

    const items = subs._embedded.subscriptions;

    // Active-ish subscriptions that we want to cancel
    const toCancel = items.filter((sub) =>
      ["active", "pending", "suspended"].includes(sub.status)
    );

    if (toCancel.length === 0) {
      await alert("info", "CS Cancel: no active subscriptions", {
        customerId,
        email,
      });
      res.statusCode = 200;
      return res.json({
        message: "No active subscriptions found for this customer",
        canceledCount: 0,
        canceledIds: [],
      });
    }

    // 3) Compute combined cancelAtDate (max of all)
    let cancelAtDate = null;
    const todayIso = toIsoDate(new Date());
    for (const sub of toCancel) {
      const subCancelDate = computeCancelAtDateFromSub(sub);
      if (!cancelAtDate || subCancelDate > cancelAtDate) {
        cancelAtDate = subCancelDate;
      }
    }
    if (!cancelAtDate || cancelAtDate < todayIso) {
      cancelAtDate = todayIso;
    }

    // 4) Cancel each subscription at Mollie
    const canceledIds = [];
    const failures = [];

    for (const sub of toCancel) {
      try {
        const r = await fetch(
          `https://api.mollie.com/v2/customers/${encodeURIComponent(
            customerId
          )}/subscriptions/${encodeURIComponent(sub.id)}`,
          {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${process.env.MOLLIE_API_KEY}`,
              "Content-Type": "application/json",
            },
          }
        );
        if (r.ok || [404, 410].includes(r.status)) {
          canceledIds.push(sub.id);
        } else {
          const text = await r.text().catch(() => "");
          console.error(
            "CS Cancel: cancel subscription failed",
            sub.id,
            r.status,
            text
          );
          failures.push({ id: sub.id, status: r.status });
        }
      } catch (e) {
        console.error("CS Cancel: exception canceling subscription", sub.id, e);
        failures.push({ id: sub.id, error: String(e) });
      }
    }

    // 5) Update Redis / Kajabi deactivation state
    const redis = await getRedis();
    const nowIso = new Date().toISOString();
    let redisUpdated = false;

    if (redis) {
      try {
        const mappingKey = `kajabi:email:${email}`;
        const existing = await redis.hgetall(mappingKey);

        const baseUpdate = {
          canceledAt: nowIso,
          cancelAtDate,
          mollieSubscriptionStatus: "canceled",
          updatedAt: nowIso,
          kajabiDeactivationPending: "true",
          kajabiDeactivatedAt: "",
          csCancelled: "true",
          csCanceledIds: JSON.stringify(canceledIds),
        };

        if (existing && Object.keys(existing).length > 0) {
          await redis.hset(mappingKey, baseUpdate);
        } else {
          // Create a minimal mapping if none exists yet
          await redis.hset(mappingKey, {
            ...baseUpdate,
            mollieCustomerId: customerId,
          });
        }

        // Also keep a customer-level record (similar to your webhook)
        await redis.hset(`mollie:customer:${customerId}`, {
          lastEmail: email,
          lastSubscriptionId: canceledIds[0] || "",
          updatedAt: nowIso,
        });

        await redis.sadd("kajabi:deactivation_pending", email);
        redisUpdated = true;
      } catch (e) {
        console.error("CS Cancel: Redis update failed:", e);
      }
    }

    await alert("info", "CS Cancel: subscriptions canceled", {
      customerId,
      email,
      canceledCount: canceledIds.length,
      canceledIds,
      failures,
      redisUpdated,
      cancelAtDate,
    });

    res.statusCode = 200;
    return res.json({
      message: "Cancellation completed",
      canceledCount: canceledIds.length,
      canceledIds,
      failures,
      cancelAtDate,
      redisUpdated,
    });
  } catch (e) {
    console.error("CS Cancel: exception", e);
    await alert("error", "CS Cancel: exception", { error: String(e) });
    res.statusCode = 500;
    return res.json({ error: "Cancellation failed" });
  }
}
