// /api/mollie-webhook.js
// Handles Mollie payment webhooks (server-to-server).
// - Subscriptions (OFFER1/2/3):
//    * On first successful payment: create subscription + activate Kajabi.
// - One-time offers (CURSUS...):
//    * On successful payment: activate Kajabi (no subscription).

export const config = {
  runtime: "nodejs",
  api: { bodyParser: false },
};

// --- Offer Configuration ---
// Only used for subscription offers (OFFER1–3). One-time offers (CURSUS)
// do not use this config because they don't create Mollie subscriptions.
const OFFER_CONFIG = {
  OFFER1: {
    description: "Fort Negen community maand",
    recurringPayment: { currency: "EUR", value: "12.00" },
    interval: "1 month",
  },
  OFFER2: {
    description: "Fort Negen community maand",
    recurringPayment: { currency: "EUR", value: "12.00" },
    interval: "1 month",
  },
  OFFER3: {
    description: "Fort Negen community jaar",
    recurringPayment: { currency: "EUR", value: "120.00" },
    interval: "1 year",
  },
};

// --- Helpers ---
function nextCycleDate(iso, interval) {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();

  let next;
  if (interval.includes("year")) {
    next = new Date(Date.UTC(y + 1, m, day));
  } else {
    const firstNext = new Date(Date.UTC(y, m + 1, 1));
    const maxDay = new Date(
      Date.UTC(firstNext.getUTCFullYear(), firstNext.getUTCMonth() + 1, 0)
    ).getUTCDate();
    firstNext.setUTCDate(Math.min(day, maxDay));
    next = firstNext;
  }

  return next.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function parseWebhookId(req) {
  const raw = await readRawBody(req);
  const ct = (req.headers["content-type"] || "").toLowerCase();

  if (ct.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(raw);
    const id = params.get("id") || params.get("payment[id]");
    return { id, _raw: raw, _ct: ct };
  }

  if (ct.includes("application/json")) {
    try {
      const obj = JSON.parse(raw || "{}");
      return { id: obj?.id || obj?.payment?.id || null, _raw: obj, _ct: ct };
    } catch (e) {
      return { id: null, _raw: raw, _ct: ct };
    }
  }

  try {
    const params = new URLSearchParams(raw);
    const id = params.get("id");
    return { id, _raw: raw, _ct: ct || "unknown" };
  } catch (e) {
    return { id: null, _raw: raw, _ct: ct || "unknown" };
  }
}

async function activateKajabi({ name, email, externalUserId, activationUrl }) {
  if (!activationUrl || !email || !externalUserId) {
    console.warn("Kajabi activation skipped (missing fields)", {
      hasUrl: !!activationUrl,
      email,
      externalUserId,
    });
    return { ok: false, skipped: true };
  }

  try {
    const resp = await fetch(activationUrl, {
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
      console.error("Kajabi activation failed:", resp.status, text);
      return { ok: false, status: resp.status, text };
    }

    console.log("Kajabi activation success for", email);
    return { ok: true };
  } catch (err) {
    console.error("Kajabi activation error:", err);
    return { ok: false, error: String(err) };
  }
}

// --- Handler ---
export default async function handler(req, res) {
  try {
    const { id: paymentId, _ct, _raw } = await parseWebhookId(req);
    if (!paymentId) {
      console.error("Webhook missing id. CT:", _ct, "Body:", _raw);
      // Always return 200 to Mollie to avoid retry storms
      return res.status(200).send("OK");
    }

    // 1) Fetch payment info from Mollie
    const pResp = await fetch(`https://api.mollie.com/v2/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${process.env.MOLLIE_API_KEY}` },
    });
    const payment = await pResp.json().catch(() => ({}));
    if (!pResp.ok) {
      console.error("Fetch payment failed:", pResp.status, payment);
      return res.status(200).send("OK");
    }

    console.log(
      "Webhook payment:",
      paymentId,
      payment.status,
      payment.sequenceType,
      payment.metadata
    );

    // ✅ Act on ALL successful payments
    if (payment.status === "paid") {
      const customerId = payment.customerId;
      const offerId = payment.metadata?.offerId || "OFFER1";

      // Determine type: subscription vs one_time
      // Prefer metadata.type from /api/checkout, fall back to sequenceType.
      const metaType =
        payment.metadata?.type ||
        (payment.sequenceType === "oneoff" ? "one_time" : "subscription");
      const isSubscription = metaType === "subscription";

      // Subscription config (only for subscription offers)
      const offer = OFFER_CONFIG[offerId] || OFFER_CONFIG.OFFER1;

           // 2) For subscriptions: on FIRST payment, create Mollie subscription
      if (isSubscription && payment.sequenceType === "first") {
        const startDate = nextCycleDate(
          payment.paidAt || payment.createdAt,
          offer.interval
        );

        const publicBase = process.env.PUBLIC_BASE_URL || "";
        const webhookUrl = publicBase
          ? `${publicBase}/api/mollie-webhook`
          : undefined;

        const subResp = await fetch(
          `https://api.mollie.com/v2/customers/${customerId}/subscriptions`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.MOLLIE_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              amount: offer.recurringPayment,
              interval: offer.interval,
              description: `${offer.description} – herhaalbetaling (${offer.recurringPayment.value} EUR / ${offer.interval})`,
              startDate,
              metadata: payment.metadata,
              ...(webhookUrl ? { webhookUrl } : {}),
            }),
          }
        );

        const subscription = await subResp.json().catch(() => ({}));
        if (!subResp.ok || !subscription?.id) {
          console.error(
            "Subscription creation failed:",
            subResp.status,
            subscription
          );
        } else {
          console.log("Subscription created:", subscription.id);

          // ✅ Save mappings in Redis (for cancel flow / reference)
          try {
            const { Redis } = await import("@upstash/redis");
            const redis = new Redis({
              url: process.env.UPSTASH_REDIS_REST_URL,
              token: process.env.UPSTASH_REDIS_REST_TOKEN,
            });

            const emailRaw =
              payment.metadata?.email ||
              payment.billingEmail ||
              payment.email ||
              "";
            const email = emailRaw.toLowerCase().trim();

            const purchaseId = payment.metadata?.kajabiPurchaseId || null;
            const memberId = payment.metadata?.kajabiMemberId || null;

            const baseFields = {
              mollieCustomerId: customerId,
              mollieSubscriptionId: subscription.id,
              offerId,
              updatedAt: new Date().toISOString(),
            };

            if (email) {
              await redis.hset(`kajabi:email:${email}`, baseFields);
              console.log("Saved mapping in Redis:", `kajabi:email:${email}`);
            } else {
              console.warn("No email found on payment; skipping email index");
            }

            if (purchaseId) {
              await redis.hset(`kajabi:purchase:${purchaseId}`, baseFields);
            }
            if (memberId) {
              await redis.hset(`kajabi:member:${memberId}`, baseFields);
            }

            await redis.hset(`mollie:customer:${customerId}`, {
              lastEmail: email || "",
              lastSubscriptionId: subscription.id,
              updatedAt: new Date().toISOString(),
            });
          } catch (e) {
            console.error("Redis mapping save failed:", e);
          }

          // --- NEW: if this is the yearly offer, auto-cancel existing monthly subs ---
          try {
            // We assume OFFER3 is the yearly subscription
            const isYearlyUpgrade =
              offerId === "OFFER3" || offer.interval === "1 year";

            if (isYearlyUpgrade) {
              console.log(
                "Upgrade detected: yearly subscription created, cancelling monthly subs",
                { customerId, newSubscriptionId: subscription.id }
              );

              const listResp = await fetch(
                `https://api.mollie.com/v2/customers/${customerId}/subscriptions?limit=50`,
                {
                  headers: {
                    Authorization: `Bearer ${process.env.MOLLIE_API_KEY}`,
                    "Content-Type": "application/json",
                  },
                }
              );

              const list = await listResp.json().catch(() => ({}));
              if (listResp.ok && list?._embedded?.subscriptions) {
                const allSubs = list._embedded.subscriptions;

                const toCancel = allSubs.filter((sub) => {
                  const isSame = sub.id === subscription.id;
                  const isActiveLike = ["active", "pending", "suspended"].includes(
                    sub.status
                  );
                  const isMonthlyInterval = sub.interval === "1 month";
                  const isMonthlyDesc = /maand/i.test(sub.description || "");

                  return (
                    !isSame && isActiveLike && (isMonthlyInterval || isMonthlyDesc)
                  );
                });

                for (const oldSub of toCancel) {
                  try {
                    const delResp = await fetch(
                      `https://api.mollie.com/v2/customers/${customerId}/subscriptions/${oldSub.id}`,
                      {
                        method: "DELETE",
                        headers: {
                          Authorization: `Bearer ${process.env.MOLLIE_API_KEY}`,
                          "Content-Type": "application/json",
                        },
                      }
                    );

                    if (delResp.ok || [404, 410].includes(delResp.status)) {
                      console.log(
                        "Auto-cancelled old monthly subscription",
                        oldSub.id,
                        oldSub.interval,
                        oldSub.status
                      );
                    } else {
                      const txt = await delResp.text().catch(() => "");
                      console.error(
                        "Failed to auto-cancel monthly subscription",
                        oldSub.id,
                        delResp.status,
                        txt
                      );
                    }
                  } catch (e) {
                    console.error(
                      "Exception auto-cancelling monthly subscription",
                      oldSub.id,
                      e
                    );
                  }
                }
              } else {
                console.error(
                  "Could not list subscriptions for upgrade",
                  listResp.status,
                  list
                );
              }
            }
          } catch (e) {
            console.error("Error in yearly upgrade auto-cancel logic", e);
          }
        }
      }


      // 3) Activate Kajabi:
      //    - ALWAYS for one-time payments
      //    - ONLY on the FIRST payment for subscriptions
      const shouldActivateKajabi =
        !isSubscription || payment.sequenceType === "first";

      if (shouldActivateKajabi) {
        const name =
          payment.metadata?.name || payment.details?.consumerName || "";
        const email =
          (payment.metadata?.email ||
            payment.billingEmail ||
            payment.email ||
            ""
          ).toLowerCase();
        const externalUserId =
          payment.metadata?.externalUserId || payment.customerId || customerId;

        const activationUrl =
          payment.metadata?.offerActivationUrl ||
          (offerId && process.env[`KAJABI_ACTIVATION_URL_${offerId}`]) ||
          process.env.KAJABI_ACTIVATION_URL;

        console.log("Kajabi activation attempt:", {
          offerId,
          type: metaType,
          sequenceType: payment.sequenceType,
          activationUrlPresent: !!activationUrl,
          email,
          externalUserId,
        });

        const act = await activateKajabi({
          name,
          email,
          externalUserId,
          activationUrl,
        });
        if (!act.ok) console.warn("Kajabi activation not confirmed:", act);
      }
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(200).send("OK");
  }
}
