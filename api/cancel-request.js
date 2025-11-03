// api/cancel-request.js
// Sends a self-service cancel link email. Vercel Serverless (no Next.js).

import crypto from "crypto";

export const config = { runtime: "nodejs" }; // ensure Node runtime

// --- CORS ---
const ALLOW_ORIGIN = "https://www.fortnegenacademy.nl";
function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}
function ok(res) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true }));
}

// Helpers
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
function signToken(obj, secret) {
  const payload = b64url(Buffer.from(JSON.stringify(obj)));
  const sig = crypto.createHmac("sha256", secret).update(payload).digest();
  return `${payload}.${b64url(sig)}`;
}
async function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

// Email via Resend (optional)
async function sendEmail({ to, subject, html }) {
  const resendKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || "no-reply@fortnegenacademy.nl";
  if (!resendKey) { console.log("[DEV] Would send email to:", to); return { ok: true, dev: true }; }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html }),
  });
  const text = await r.text().catch(()=> "");
  console.log("Resend status:", r.status, text.slice(0, 160));
  return { ok: r.ok, status: r.status, text };
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.statusCode = 200; return res.end(); }
  if (req.method !== "POST")    { res.statusCode = 405; return res.end("Method Not Allowed"); }

  try {
    const body  = (req.body && typeof req.body === "object") ? req.body : await readJsonBody(req);
    const email = (body?.email || "").toLowerCase().trim();
    if (!email) return ok(res); // privacy-preserving

    const { Redis } = await import("@upstash/redis");
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });

    // 1) Try Redis first
    const redisKey = `kajabi:email:${email}`;
    let ids = await redis.hgetall(redisKey); // { mollieCustomerId, mollieSubscriptionId, ... }
    console.log("REDIS KEY:", redisKey, "FOUND:", !!ids?.mollieCustomerId, !!ids?.mollieSubscriptionId);

    let customerId = ids?.mollieCustomerId || null;
    let subscriptionId = ids?.mollieSubscriptionId || null;

    if (!customerId) {
      // No mapping at all → do not leak existence
      return ok(res);
    }

    // 2) Fallback: look up subscription from Mollie if missing
    if (!subscriptionId) {
      try {
        const mRes = await fetch(`https://api.mollie.com/v2/customers/${customerId}/subscriptions`, {
          headers: { Authorization: `Bearer ${process.env.MOLLIE_API_KEY}` },
        });
        const list = await mRes.json().catch(() => ({}));
        const items = Array.isArray(list?._embedded?.subscriptions) ? list._embedded.subscriptions : [];
        const active = items.find(s => s.status === "active") || items[0];
        if (!active) {
          // No subscription to cancel → still OK to user
          return ok(res);
        }
        subscriptionId = active.id;

        // Backfill Redis for next time
        try {
          await redis.hset(redisKey, {
            mollieCustomerId: customerId,
            mollieSubscriptionId: subscriptionId,
            updatedAt: new Date().toISOString(),
          });
          console.log("Backfilled Redis subscriptionId for", redisKey, subscriptionId);
        } catch (e) {
          console.error("Redis backfill failed:", e);
        }
      } catch (e) {
        console.error("Mollie subscriptions fetch failed:", e);
        return ok(res);
      }
    }

    // 3) Build signed token (30 minutes)
    const secret = process.env.CANCEL_LINK_SECRET || "dev-secret";
    const exp    = Math.floor(Date.now()/1000) + (30 * 60);
    const token  = signToken({ email, customerId, subscriptionId, key: redisKey, exp }, secret);

    const base = process.env.PUBLIC_BASE_URL || "https://kajabi-mollie.vercel.app";
    const link = `${base}/api/cancel-complete?token=${encodeURIComponent(token)}`;

    // 4) Send email
    const html = `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
        <h2 style="color:#111827;margin:0 0 8px;">Bevestig je opzegging</h2>
        <p>Klik op de knop om je abonnement te stoppen. Deze link vervalt binnen 30 minuten.</p>
        <p><a href="${link}" style="display:inline-block;background:#97c8a8;color:#fff;padding:10px 14px;border-radius:10px;text-decoration:none;">Abonnement opzeggen</a></p>
        <p style="font-size:12px;color:#6b7280;margin-top:10px;">Werkt de knop niet? Kopieer deze link:<br>${link}</p>
      </div>
    `;
    const result = await sendEmail({ to: email, subject: "Bevestig je opzegging – Fort Negen Academy", html });
    console.log("SendEmail result ok?:", !!result?.ok);

    return ok(res);
  } catch (e) {
    console.error("cancel-request error:", e);
    return ok(res); // privacy-preserving OK
  }
}
