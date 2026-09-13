// server/notify.js
// Sends the shop an SMS the moment a booking request comes in.
//
// Uses Twilio's REST API directly via fetch — no `twilio` npm package needed
// (Node 18+ has fetch built in). Every failure is caught and logged: a
// notification problem must never break a customer's booking.

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER;
const DEFAULT_COUNTRY = process.env.SMS_DEFAULT_COUNTRY || "+1";

const smsConfigured = Boolean(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM);

/**
 * Turn "(813) 555-0142" or "6562250102" into E.164 (+18135550142).
 * Returns null if it can't be made into something sendable.
 */
function toE164(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.startsWith("+")) {
    const digits = s.slice(1).replace(/\D/g, "");
    return digits.length >= 8 ? `+${digits}` : null;
  }
  const d = s.replace(/\D/g, "");
  if (!d) return null;
  if (DEFAULT_COUNTRY === "+1") {
    if (d.length === 10) return `+1${d}`;
    if (d.length === 11 && d.startsWith("1")) return `+${d}`;
    return null; // don't guess at malformed US numbers
  }
  return `+${DEFAULT_COUNTRY.replace(/\D/g, "")}${d}`;
}

/**
 * Send one SMS. Resolves to { ok, sid } or { ok: false, error }.
 * Never throws.
 */
async function sendSms(to, body) {
  if (!smsConfigured) {
    return { ok: false, error: "sms_not_configured" };
  }
  const dest = toE164(to);
  if (!dest) {
    return { ok: false, error: `unusable_number: ${to}` };
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
    TWILIO_SID
  )}/Messages.json`;

  const form = new URLSearchParams({
    To: dest,
    From: TWILIO_FROM,
    Body: body.slice(0, 1200),
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization:
          "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
      signal: AbortSignal.timeout(10000),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        error: `twilio_${res.status}: ${json.message || "unknown"}`,
        code: json.code,
      };
    }
    return { ok: true, sid: json.sid, to: dest };
  } catch (err) {
    return { ok: false, error: err.name === "TimeoutError" ? "timeout" : String(err) };
  }
}

/**
 * POST the lead to a webhook (Zapier, Make, n8n, a Slack workflow...).
 * Free alternative to SMS, or a second channel alongside it.
 */
async function sendWebhook(url, payload) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok ? { ok: true } : { ok: false, error: `webhook_${res.status}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function shopMessage(business, lead) {
  const lines = [
    `New booking request — ${business.name}`,
    lead.service || "Service not specified",
    `${lead.name || "No name"} — ${lead.phone || "no number"}`,
  ];
  if (lead.preferredTime) lines.push(`Prefers: ${lead.preferredTime}`);
  return lines.join("\n");
}

function customerMessage(business, pack, lead) {
  const phone = (pack.business && pack.business.phone) || "";
  return (
    `Thanks ${lead.name || ""}! We got your request at ${business.name}` +
    (lead.service ? ` for a ${lead.service}` : "") +
    (lead.preferredTime ? ` (${lead.preferredTime})` : "") +
    `. We'll text you to confirm the exact time.` +
    (phone ? ` Questions: ${phone}` : "")
  ).replace(/\s+/g, " ").trim();
}

/**
 * Fire all configured notifications for a new lead.
 * Call without awaiting — it logs its own outcome and never throws.
 *
 * Pack config:
 *   "notifications": {
 *     "sms_to": "+18135550142",        // shop's phone — required for SMS
 *     "confirm_customer": false,        // also text the customer back
 *     "webhook_url": ""                 // optional POST of the lead JSON
 *   }
 */
async function notifyNewLead({ business, pack, lead }) {
  const cfg = (pack && pack.notifications) || {};
  const tag = `[notify] ${business.name} lead #${lead.id}`;

  // --- shop SMS ---
  if (cfg.sms_to) {
    if (!smsConfigured) {
      console.warn(
        `${tag}: sms_to is set but Twilio env vars are missing — no SMS sent.`
      );
    } else {
      const r = await sendSms(cfg.sms_to, shopMessage(business, lead));
      console.log(
        r.ok ? `${tag}: SMS sent to shop (${r.to})` : `${tag}: SMS FAILED — ${r.error}`
      );
    }
  } else {
    console.log(`${tag}: no notifications.sms_to in pack — skipping SMS.`);
  }

  // --- customer confirmation (opt-in) ---
  if (cfg.confirm_customer && lead.phone && smsConfigured) {
    const r = await sendSms(lead.phone, customerMessage(business, pack, lead));
    console.log(
      r.ok
        ? `${tag}: confirmation sent to customer`
        : `${tag}: customer confirmation FAILED — ${r.error}`
    );
  }

  // --- webhook ---
  if (cfg.webhook_url) {
    const r = await sendWebhook(cfg.webhook_url, {
      event: "lead.created",
      business: { id: business.id, name: business.name, slug: business.slug },
      lead: {
        id: lead.id,
        name: lead.name,
        phone: lead.phone,
        service: lead.service,
        preferredTime: lead.preferredTime,
        createdAt: lead.createdAt,
      },
    });
    console.log(r.ok ? `${tag}: webhook delivered` : `${tag}: webhook FAILED — ${r.error}`);
  }
}

module.exports = { notifyNewLead, sendSms, toE164, smsConfigured, shopMessage };
