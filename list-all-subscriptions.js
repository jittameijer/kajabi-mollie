// scripts/list-all-subscriptions.mjs
import createMollieClient from '@mollie/api-client';

const mollie = createMollieClient({ apiKey: process.env.MOLLIE_API_KEY });

async function listAllCustomers() {
  let page = await mollie.customers.all();
  const customers = [];
  while (true) {
    customers.push(...(page._embedded?.customers ?? []));
    if (!page.nextPage) break;
    page = await page.nextPage();
  }
  return customers;
}

async function listSubsForCustomer(customerId) {
  let page = await mollie.customers_subscriptions.all({ customerId });
  const subs = [];
  while (true) {
    subs.push(...(page._embedded?.subscriptions ?? []));
    if (!page.nextPage) break;
    page = await page.nextPage();
  }
  return subs;
}

async function main() {
  try {
    const customers = await listAllCustomers();
    console.log(`Found ${customers.length} customers`);
    console.log('---');

    let totalSubs = 0;
    for (const c of customers) {
      const subs = await listSubsForCustomer(c.id);
      if (subs.length === 0) continue;
      for (const s of subs) {
        totalSubs++;
        console.log({
          subscriptionId: s.id,
          customerId: c.id,
          customerEmail: c.email,
          status: s.status,                // active | pending | canceled | completed | suspended
          amount: `${s.amount?.value} ${s.amount?.currency}`,
          interval: s.interval,
          times: s.times,
          nextPaymentDate: s.nextPaymentDate, // YYYY-MM-DD
          mandateId: s.mandateId,
          webhookUrl: s.webhookUrl,
          description: s.description,
        });
      }
    }

    console.log('---');
    console.log(`Total subscriptions: ${totalSubs}`);
  } catch (err) {
    console.error('❌ Error fetching subscriptions:', err);
    process.exit(1);
  }
}

main();
