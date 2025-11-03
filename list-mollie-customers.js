// list-mollie-customers.js
// Safe read-only script to count and list customers in your Mollie account.

import fetch from "node-fetch";

const MOLLIE_API_KEY = process.env.MOLLIE_API_KEY || "live_xxxxxxxxxxxxxxxxxxx";
const BASE_URL = "https://api.mollie.com/v2";

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${MOLLIE_API_KEY}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("Error:", res.status, data);
    throw new Error(`Request failed: ${url}`);
  }
  return data;
}

async function listAllCustomers() {
  let url = `${BASE_URL}/customers?limit=250`;
  let total = 0;
  let all = [];

  while (url) {
    const data = await fetchJSON(url);
    const customers = data._embedded?.customers || [];
    all = all.concat(customers);
    total += customers.length;
    console.log(`Fetched ${customers.length} customers so far (total ${total})`);
    url = data._links?.next?.href || null;
  }

  console.log("\n✅ Total customers found:", total);

  // Optional: print the first few entries for reference
  for (const c of all.slice(0, 5)) {
    console.log(`- ${c.id} (${c.name || "no name"}) – ${c.email || "no email"}`);
  }
}

listAllCustomers().catch((err) => console.error("Fatal error:", err));
