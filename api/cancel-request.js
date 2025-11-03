// api/cancel-request.js
// Sends a self-service cancel link email. Works on Vercel Serverless Functions (no Next.js).

import crypto from "crypto";

// --- CORS allowlist (include both www and bare domain if needed) ---
const ORIGINS = [
  "https://www.fortnegenacademy.nl",
  "https://fortnegenacademy.nl",
];

// Small helpers
function setCors(req, res) {
  const origin = req.headers.origin;
  if (ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}
function ok(res) {
  // Privacy-preserving success (don’t leak if email exists)
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true }));
}
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/,"");
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
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

// Optional: send email via Resend
console.log("HAS_RESEND_API_KEY:", !!process.env.RESEND_API_KEY);
console.log("MAIL_FROM:", process.env.MAIL_FROM);
console.log("REDIS KEY:", key, "FOUND:", !!ids?.mollieCustomerId, !!ids?.mollieSubscriptionId);


async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || "no-reply@fortnegenacademy.nl";
  if (!key) { console.log("[DEV] Would send email to:", to); return { ok: true }; }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html }),
  });
  return { ok: r.ok, status: r.status, text: await r.text().catch(()=> "") };
}

export default async function handler(req, res) {
  // --- CORS first (handles preflight early) ---
  setCors(req, res);
  if (req.method === "OPTIONS") { res.statusCode = 200; return res.end(); }
  if (req.method !== "POST") { res.statusCode = 405; return res.end("Method Not Allowed"); }

  try {
    const body = (req.body && typeof req.body === "object") ? req.body : await readJsonBody(req);
    const email = (body?.email || "").toLowerCase().trim();
    if (!email) return ok(res); // keep UX the same

    // Lookup mapping in Upstash (email key)
    const { Redis } = await import("@upstash/redis");
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    const key = `kajabi:email:${email}`;
    const ids = await redis.hgetall(key); // { mollieCustomerId, mollieSubscriptionId, ... }

    if (!ids?.mollieCustomerId || !ids?.mollieSubscriptionId) {
      return ok(res); // same UX, no leak
    }

    // Build signed token (30 min)
    const secret = process.env.CANCEL_LINK_SECRET || "dev-secret";
    const exp = Math.floor(Date.now()/1000) + (30 * 60);
    const token = signToken({
      email,
      customerId: ids.mollieCustomerId,
      subscriptionId: ids.mollieSubscriptionId,
      key,
      exp,
    }, secret);

    const base = process.env.PUBLIC_BASE_URL || "https://kajabi-mollie.vercel.app";
    const link = `${base}/api/cancel-complete?token=${encodeURIComponent(token)}`;

    const html = `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
        <h2 style="color:#111827;margin:0 0 8px;">Bevestig je opzegging</h2>
        <p>Klik op de knop om je abonnement te stoppen. Deze link vervalt binnen 30 minuten.</p>
        <p><a href="${link}" style="display:inline-block;background:#97c8a8;color:#fff;padding:10px 14px;border-radius:10px;text-decoration:none;">Abonnement opzeggen</a></p>
        <p style="font-size:12px;color:#6b7280;margin-top:10px;">Werkt de knop niet? Kopieer deze link:<br>${link}</p>
      </div>
    `;

    await sendEmail({ to: email, subject: "Bevestig je opzegging – Fort Negen Academy", html });
    return ok(res);
  } catch (e) {
    console.error("cancel-request error:", e);
    // still ok to the client to avoid leaking
    return ok(res);
  }
}
