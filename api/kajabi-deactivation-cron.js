// /api/kajabi-deactivation-cron.js
export const config = { runtime: "nodejs" };

import { Redis } from "@upstash/redis";

async function deactivateKajabi({ name, email, externalUserId, deactivationUrl }) {
  if (!deactivationUrl || !email || !externalUserId) {
    console.warn("Kajabi deactivation skipped:", { email, deactivationUrl });
    return { ok: false, skipped: true };
  }

  try {
    const resp = await fetch(deactivationUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name || email,
        email,
        external_user_id: externalUserId,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error("Kajabi deactivation failed:", resp.status, text);
      return { ok: false };
    }

    console.log("Kajabi deactivated:", email);
    return { ok: true };
  } catch (e) {
    console.error("Kajabi deactivation exception:", e);
    return { ok: false };
  }
}

export default async function handler(req, res) {
  // ✅ Check Authorization header from Vercel cron
  const authHeader = req.headers["authorization"] || req.headers["Authorization"];
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (authHeader !== expected) {
    res.statusCode = 401;
    return res.end("Unauthorized");
  }

  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end("Method Not Allowed");
  }

  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });

  const today = new Date().toISOString().slice(0, 10);
  const setKey = "kajabi:deactivation_pending";

  try {
const emails = (await redis.smembers(setKey)) || [];
console.log("Cron: pending emails:", emails.length, emails);

const results = [];

for (const email of emails) {
  const emails = (await redis.smembers(setKey)) || [];
  console.log("Cron: pending emails:", emails.length);

  const results = [];

  for (const email of emails) {
    const key = `kajabi:email:${email}`;
    const data = await redis.hgetall(key);

    if (!data) continue;
    if (data.kajabiDeactivationPending !== "true") continue;
    if (!data.cancelAtDate || data.cancelAtDate > today) continue;

    const externalUserId =
      data.kajabiExternalUserId ||
      data.mollieCustomerId ||
      email; // fallback

    const deactivationUrl =
      data.kajabiDeactivationUrl ||
      (data.offerId &&
        process.env[`KAJABI_DEACTIVATION_URL_${data.offerId}`]) ||
      process.env.KAJABI_DEACTIVATION_URL ||
      null;

    const result = await deactivateKajabi({
      name: data.name || email,
      email,
      externalUserId,
      deactivationUrl,
    });

    if (result.ok) {
      await redis.hset(key, {
        kajabiDeactivationPending: "false",
        kajabiDeactivatedAt: new Date().toISOString(),
      });
      await redis.srem(setKey, email);
    }

    results.push({ email, ok: result.ok });
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  return res.end(JSON.stringify({ ok: true, results }));



    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: true, results }));
  } catch (e) {
    console.error("Deactivation cron error:", e);
    res.statusCode = 500;
    return res.end("Cron error");
  }
}
