// /api/cs-list-subscriptions.js
// For internal customer service:
// Verify customerId + email, then return all subscriptions from Mollie.

export const config = { runtime: "nodejs" };

const ALLOW_ORIGIN =
  process.env.CS_PANEL_ORIGIN || "https://www.fortnegenacademy.nl";

function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

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

// Optional alert logger
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
      await alert("warn", "CS List: missing customerId or email", {
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
        "CS List: customer fetch failed",
        customerResp.status,
        customer
      );
      await alert("warn", "CS List: customer not found", {
        status: customerResp.status,
        customerId,
      });
      res.statusCode = 404;
      return res.json({ error: "Customer not found in Mollie" });
    }

    const mollieEmail = String(customer.email || "").trim().toLowerCase();
    if (!mollieEmail || mollieEmail !== email) {
      await alert("warn", "CS List: email mismatch", {
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
        "CS List: list subscriptions failed",
        subsResp.status,
        subs
      );
      await alert("error", "CS List: could not list subscriptions", {
        status: subsResp.status,
        customerId,
      });
      res.statusCode = 500;
      return res.json({ error: "Could not fetch subscriptions" });
    }

    const items = subs._embedded.subscriptions || [];

    // Only return safe fields to the UI
    const simplified = items.map((sub) => ({
      id: sub.id,
      description: sub.description,
      status: sub.status, // active, pending, canceled, completed, suspended
      amount: sub.amount,
      times: sub.times,
      timesRemaining: sub.timesRemaining,
      interval: sub.interval,
      startDate: sub.startDate,
      nextPaymentDate: sub.nextPaymentDate,
      createdAt: sub.createdAt,
      canceledAt: sub.canceledAt,
      webhookUrl: sub.webhookUrl || null,
    }));

    await alert("info", "CS List: subscriptions fetched", {
      customerId,
      email,
      count: simplified.length,
    });

    res.statusCode = 200;
    return res.json({
      customerId,
      email,
      count: simplified.length,
      subscriptions: simplified,
    });
  } catch (e) {
    console.error("CS List: exception", e);
    await alert("error", "CS List: exception", { error: String(e) });
    res.statusCode = 500;
    return res.json({ error: "Listing failed" });
  }
}
