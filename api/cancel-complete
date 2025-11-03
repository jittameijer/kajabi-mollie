// api/cancel-complete.js
import crypto from "crypto";

function b64urlToBuf(s){ s=s.replace(/-/g,"+").replace(/_/g,"/"); while(s.length%4)s+="="; return Buffer.from(s,"base64"); }
function verify(token, secret){
  const [payload, signature] = String(token||"").split(".");
  if (!payload || !signature) throw new Error("Bad token");
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  const sigBuf = b64urlToBuf(signature);
  if (expected.length !== sigBuf.length || !crypto.timingSafeEqual(expected, sigBuf)) throw new Error("Bad sig");
  const data = JSON.parse(Buffer.from(payload, "base64").toString());
  if (!data.exp || data.exp < Math.floor(Date.now()/1000)) throw new Error("Expired");
  return data;
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");
    const data = verify(token, process.env.CANCEL_LINK_SECRET || "dev-secret");
    const { customerId, subscriptionId, key, email } = data;

    const mUrl = `https://api.mollie.com/v2/customers/${customerId}/subscriptions/${subscriptionId}`;
    const mRes = await fetch(mUrl, { method: "DELETE", headers: { Authorization: `Bearer ${process.env.MOLLIE_API_KEY}` }});
    if (!mRes.ok && mRes.status !== 404) throw new Error(`Mollie delete failed: ${mRes.status}`);

    // mark in Redis
    try {
      const { Redis } = await import("@upstash/redis");
      const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
      await redis.hset(key || `kajabi:email:${email}`, { canceledAt: new Date().toISOString() });
    } catch {}

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(`<h2>Opzegging bevestigd</h2><p>Je abonnement is stopgezet. Je toegang blijft actief tot het einde van je huidige periode.</p>`);
  } catch (e) {
    console.error("cancel-complete error:", e);
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end("<h2>Link ongeldig of verlopen</h2><p>Vraag een nieuwe opzeglink aan.</p>");
  }
}
