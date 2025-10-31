// /api/mollie-webhook.js
import fetch from "node-fetch";
import { Redis } from "@upstash/redis"; // 🆕 add this import

export const config = { api: { bodyParser: true } };

function nextMonthDate(iso) {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(y, m + 1, 1));
  const maxDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, maxDay));
  return target.toISOString().slice(0, 10); // YYYY-MM-DD
}

export default async function handler(req, res) {
  try {
    const paymentId = req.body?.id || req.query?.id;
    if (!paymentId) return res.status(400).send("Missing id");

    // 1) Fetch latest payment status
    const pResp = await fetch(`https://api.mollie.com/v2/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${process.env.MOLLIE_API_KEY}` },
    });
    const payment = await pResp.json();

    if (payment.status === "paid" && payment.sequenceType === "first") {
      const customerId = payment.customerId;
      const startDate = nextMonthDate(payment.paidAt || payment.createdAt);

      // 2) Create subscription: €12.00 monthly, starting next month
      const subResp = await fetch(
        `https://api.mollie.com/v2/customers/${customerId}/subscriptions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.MOLLIE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            amount: { currency: "EUR", value: "12.00" },
            interval: "1 month",
            description: "Course subscription (€12/month after intro)",
            startDate,
            metadata: payment.metadata,
            webhookUrl: `${process.env.PUBLIC_BASE_URL}/api/mollie-webhook`,
          }),
        }
      );

      const subscription = await subResp.json();
      if (!subscription?.id) {
        console.error("Subscription create error", subscription);
      }

      /* 🆕 3) Save Kajabi→Mollie mapping for later cancellation */
      try {
        const redis = new Redis({
          url: process.env.UPSTASH_REDIS_REST_URL,
          token: process.env.UPSTASH_REDIS_REST_TOKEN,
        });

        // Pick a unique Kajabi identifier from payment.metadata
        const kajabiPurchaseId = payment.metadata?.purchaseId;
        const kajabiMemberId = payment.metadata?.memberId;
        const email = payment.metadata?.email;

        // Save the mapping by whichever key(s) you have
        if (kajabiPurchaseId) {
          await redis.hset(`kajabi:purchase:${kajabiPurchaseId}`, {
            mollieCustomerId: customerId,
            mollieSubscriptionId: subscription.id,
          });
        } else if (kajabiMemberId) {
          await redis.hset(`kajabi:member:${kajabiMemberId}`, {
            mollieCustomerId: customerId,
            mollieSubscriptionId: subscription.id,
          });
        } else if (email) {
          await redis.hset(`kajabi:email:${email}`, {
            mollieCustomerId: customerId,
            mollieSubscriptionId: subscription.id,
          });
        }

        console.log("✅ Saved Mollie mapping to Upstash Redis");
      } catch (err) {
        console.error("⚠️ Failed to save to Redis", err);
      }
      /* 🆕 end of mapping section */

      // Optional: notify Zapier etc.
      // await fetch(process.env.ZAPIER_HOOK_URL, { ... });

      return res.status(200).send("OK");
    }

    return res.status(200).send("IGNORED");
  } catch (e) {
    console.error(e);
    return res.status(200).send("OK");
  }
}
