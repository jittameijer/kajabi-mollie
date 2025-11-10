// list-subscriptions.js
import { createMollieClient } from '@mollie/api-client';

const mollie = createMollieClient({ apiKey: process.env.MOLLIE_API_KEY });

async function main() {
  try {
    // Fetch all subscriptions (across all customers)
    const subs = await mollie.subscriptions.all();

    console.log(`Found ${subs.count} subscriptions`);
    console.log('---');

    for (const sub of subs._embedded?.subscriptions || []) {
      console.log({
        id: sub.id,
        customerId: sub.customerId,
        status: sub.status,
        amount: sub.amount?.value + ' ' + sub.amount?.currency,
        interval: sub.interval,
        nextPaymentDate: sub.nextPaymentDate,
        webhookUrl: sub.webhookUrl,
        description: sub.description,
      });
    }

    if (subs.links?.next) {
      console.log('⚠️ There are more pages — pagination supported via subs.nextPage()');
    }
  } catch (err) {
    console.error('Error fetching subscriptions:', err);
  }
}

main();
