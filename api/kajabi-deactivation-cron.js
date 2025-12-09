// /api/kajabi-deactivation-cron.js

import { Redis } from "@upstash/redis";

export const config = { runtime: "nodejs" };

async function deactivateKajabi({ name, email, externalUserId, deactivationUrl }) {
  if (!deactivationUrl || !email || !externalUserId) {
    console.warn("Kajabi deactivation skipped:", { email, deactivationUrl });
    return {
      ok: false,
      skipped: true,
      reason: "missing_fields",
      email,
      deactivationUrl,
    };
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

    const text = await resp.text().catch(() => "");

    if (!resp.ok) {
      console.error(
        "Kajabi deactivation failed:",
        resp.status,
        text.slice(0, 300)
      );
      return {
        ok: false,
        status: resp.status,
        body: text.slice(0, 300),
      };
    }

    console.log("Kajabi deactivated:", email);
    return { ok: true };
  } catch (e) {
    console.error("Kajabi deactivation exception:", e);
    return { ok: false, error: String(e) };
  }
}

export default async function handler(req, res) {
  // ✅ Check Authorization header from Vercel cron (and from your curl)
  const authHeader =
    req.headers["authorization"] || req.headers["Authorization"];
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

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const setKey = "kajabi:deactivation_pending";

  try {
    const emails = (await redis.smembers(setKey)) || [];

    const debug = [];

    for (const email of emails) {
      const key = `kajabi:email:${email}`;
      const data = await redis.hgetall(key);

      if (!data) {
        debug.push({ email, reason: "no_data_for_key" });
        continue;
      }

      const cancelAtDate = data.cancelAtDate;

      if (!cancelAtDate) {
        debug.push({ email, reason: "no_cancelAtDate", data });
        continue;
      }

      if (cancelAtDate > today) {
        debug.push({
          email,
          reason: "not_due_yet",
          cancelAtDate,
          today,
        });
        continue;
      }

      const externalUserId =
        data.kajabiExternalUserId || data.mollieCustomerId || email;

      const deactivationUrl =
        data.kajabiDeactivationUrl ||
        (data.offerId &&
          process.env[`KAJABI_DEACTIVATION_URL_${data.offerId}`]) ||
        process.env.KAJABI_DEACTIVATION_URL ||
        null;

      if (!deactivationUrl) {
        debug.push({
          email,
          reason: "missing_deactivationUrl",
          offerId: data.offerId || null,
        });
        continue;
      }

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

      debug.push({
        email,
        reason: "attempted_deactivation",
        result,
      });
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(
      JSON.stringify({
        ok: true,
        today,
        pending: emails.length,
        debug,
      })
    );
  } catch (e) {
    console.error("Deactivation cron error:", e);
    res.statusCode = 500;
    return res.end("Cron error");
  }
}
