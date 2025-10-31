import { Redis } from "@upstash/redis";

export default async function handler(req, res) {
  try {
    const r = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });

    // Use any test purchase id you like:
    const purchaseId = "p_TEST123";

    await r.hset(`kajabi:purchase:${purchaseId}`, {
      mollieCustomerId: "cst_test_123",
      mollieSubscriptionId: "sub_test_456",
    });

    return res.status(200).json({ ok: true, key: `kajabi:purchase:${purchaseId}` });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
