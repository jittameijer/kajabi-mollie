// /lib/alert.js
// Lightweight alert helper for Vercel functions (Slack-compatible)

const hasNodeFetch = typeof fetch === "function"; // Node 18+ has global fetch

function sha256(str = "") {
  // very small, non-crypto-critical hash for redaction
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  // Node 18+ subtle crypto
  return globalThis.crypto?.subtle
    ? globalThis.crypto.subtle.digest("SHA-256", data).then(buf =>
        Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("")
      )
    : Promise.resolve("na"); // fallback
}

function redact(value) {
  if (!value) return null;
  // If it looks like an email, hash it
  if (typeof value === "string" && value.includes("@")) {
    return { email_hash: true, sha256: null, domain: value.split("@")[1] || null, };
  }
  return value;
}

async function redactCtx(ctx = {}) {
  const out = { ...ctx };
  if (ctx.email && typeof ctx.email === "string") {
    out.email_domain = ctx.email.split("@")[1] || null;
    out.email = undefined;
    out.email_sha256 = await sha256(ctx.email.toLowerCase());
  }
  return out;
}

/**
 * Send an alert
 * @param {'info'|'warn'|'error'} level
 * @param {string} message
 * @param {object} context
 */
export async function alert(level = "info", message = "", context = {}) {
  try {
    const url = process.env.ALERT_WEBHOOK_URL;
    if (!url) return; // silently skip if not configured

    const env = process.env.ALERT_ENV || process.env.VERCEL_ENV || "unknown";
    const project = process.env.PROJECT_NAME || process.env.VERCEL_PROJECT_PRODUCTION_URL || "app";

    const safeCtx = await redactCtx(context);

    const text =
      `*[${project}] ${level.toUpperCase()}* — ${message}\n` +
      `env: ${env}\n` +
      (safeCtx ? "ctx: " + "```" + JSON.stringify(safeCtx, null, 2) + "```" : "");

    const payload = { text };

    // Use global fetch if available; otherwise dynamic import node-fetch (rarely needed on Vercel)
    if (hasNodeFetch) {
      await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    } else {
      const { default: nodeFetch } = await import("node-fetch");
      await nodeFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    }
  } catch (e) {
    // Never throw from alerts; just log
    console.error("alert() failed:", e);
  }
}
