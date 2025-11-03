// /api/alert-test.js
import { alert } from "../lib/alert.js";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  await alert("info", "Slack alert test", {
    timestamp: new Date().toISOString(),
    env: process.env.VERCEL_ENV,
  });
  res.status(200).json({ ok: true });
}
