{\rtf1\ansi\ansicpg1252\cocoartf2865
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fswiss\fcharset0 Helvetica;}
{\colortbl;\red255\green255\blue255;}
{\*\expandedcolortbl;;}
\paperw11900\paperh16840\margl1440\margr1440\vieww11520\viewh8400\viewkind0
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0

\f0\fs24 \cf0 // /api/mollie-webhook.js\
import fetch from "node-fetch";\
\
export const config = \{ api: \{ bodyParser: true \} \};\
\
function nextMonthDate(iso) \{\
  const d = new Date(iso);\
  const y = d.getUTCFullYear();\
  const m = d.getUTCMonth();\
  const day = d.getUTCDate();\
  const target = new Date(Date.UTC(y, m + 1, 1));\
  const maxDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();\
  target.setUTCDate(Math.min(day, maxDay));\
  return target.toISOString().slice(0, 10); // YYYY-MM-DD\
\}\
\
export default async function handler(req, res) \{\
  try \{\
    const paymentId = req.body?.id || req.query?.id;\
    if (!paymentId) return res.status(400).send("Missing id");\
\
    // 1) Fetch latest payment status\
    const pResp = await fetch(`https://api.mollie.com/v2/payments/$\{paymentId\}`, \{\
      headers: \{ Authorization: `Bearer $\{process.env.MOLLIE_API_KEY\}` \},\
    \});\
    const payment = await pResp.json();\
\
    if (payment.status === "paid" && payment.sequenceType === "first") \{\
      const customerId = payment.customerId;\
      const startDate = nextMonthDate(payment.paidAt || payment.createdAt);\
\
      // 2) Create subscription: \'8012.00 monthly, starting next month\
      const subResp = await fetch(\
        `https://api.mollie.com/v2/customers/$\{customerId\}/subscriptions`,\
        \{\
          method: "POST",\
          headers: \{\
            Authorization: `Bearer $\{process.env.MOLLIE_API_KEY\}`,\
            "Content-Type": "application/json",\
          \},\
          body: JSON.stringify(\{\
            amount: \{ currency: "EUR", value: "12.00" \},\
            interval: "1 month",\
            description: "Course subscription (\'8012/month after intro)",\
            startDate,\
            metadata: payment.metadata,\
            webhookUrl: `$\{process.env.PUBLIC_BASE_URL\}/api/mollie-webhook`,\
          \}),\
        \}\
      );\
\
      const subscription = await subResp.json();\
      if (!subscription?.id) \{\
        console.error("Subscription create error", subscription);\
      \}\
\
      // Optional: notify Zapier immediately (if not using the Mollie app triggers)\
      // await fetch(process.env.ZAPIER_HOOK_URL, \{ method: "POST", headers: \{"Content-Type":"application/json"\}, body: JSON.stringify(\{ event: "first_payment_paid", email: payment.metadata?.email, offerId: payment.metadata?.offerId, customerId, subscriptionId: subscription.id \})\});\
\
      return res.status(200).send("OK");\
    \}\
\
    // For other statuses (failed/refunded/charged_back) you could act here\
    return res.status(200).send("IGNORED");\
  \} catch (e) \{\
    console.error(e);\
    // return 200 so Mollie doesn\'92t retry forever if something goes wrong transiently\
    return res.status(200).send("OK");\
  \}\
\}}