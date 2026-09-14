// Tests notify.js against a fake Twilio endpoint.
let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra !== undefined ? "\n       " + JSON.stringify(extra) : ""}`); }
}

process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "tok";
process.env.TWILIO_FROM_NUMBER = "+15005550006";

const calls = [];
let mode = "ok";
global.fetch = async (url, opts) => {
  calls.push({ url, body: opts.body ? Object.fromEntries(new URLSearchParams(opts.body)) : null, headers: opts.headers });
  if (mode === "http_error") {
    return { ok: false, status: 401, json: async () => ({ message: "Authenticate", code: 20003 }) };
  }
  if (mode === "throw") throw new Error("ECONNREFUSED");
  if (mode === "webhook") return { ok: true, status: 200, json: async () => ({}) };
  return { ok: true, status: 201, json: async () => ({ sid: "SM123" }) };
};

const { notifyNewLead, sendSms, toE164, shopMessage } = require("./server/notify");

const business = { id: 1, name: "Fresh Fade Studio", slug: "fresh-fade-studio" };
const lead = { id: 7, name: "Todd", phone: "6562250102", service: "Beard Trim", preferredTime: "saturday", createdAt: new Date() };

(async () => {
  console.log("\n=== phone normalization ===");
  check("10-digit US", toE164("6562250102") === "+16562250102");
  check("formatted US", toE164("(813) 555-0142") === "+18135550142");
  check("11-digit with 1", toE164("1-813-555-0142") === "+18135550142");
  check("already E.164", toE164("+447911123456") === "+447911123456");
  check("garbage rejected", toE164("call me") === null);
  check("too short rejected", toE164("12345") === null);
  check("empty rejected", toE164("") === null);

  console.log("\n=== message content ===");
  const msg = shopMessage(business, lead);
  check("names the shop", msg.includes("Fresh Fade Studio"));
  check("has service", msg.includes("Beard Trim"));
  check("has customer + number", msg.includes("Todd") && msg.includes("6562250102"));
  check("has preference", msg.includes("saturday"));
  check("fits one SMS segment", msg.length <= 160, msg.length);

  console.log("\n=== sendSms ===");
  calls.length = 0;
  const r = await sendSms("6562250102", "hello");
  check("returns ok", r.ok === true, r);
  check("hits Twilio Messages endpoint", calls[0].url.includes("/Accounts/ACtest/Messages.json"));
  check("sends E.164 To", calls[0].body.To === "+16562250102", calls[0].body);
  check("sends From", calls[0].body.From === "+15005550006");
  check("uses basic auth", calls[0].headers.Authorization.startsWith("Basic "));

  console.log("\n=== failure handling ===");
  mode = "http_error";
  const e1 = await sendSms("6562250102", "x");
  check("http error returns ok:false", e1.ok === false, e1);
  check("surfaces twilio message", String(e1.error).includes("Authenticate"), e1);
  mode = "throw";
  const e2 = await sendSms("6562250102", "x");
  check("network throw is caught", e2.ok === false, e2);
  mode = "ok";

  console.log("\n=== notifyNewLead routing ===");
  calls.length = 0;
  await notifyNewLead({ business, pack: { notifications: { sms_to: "8135550142" } }, lead });
  check("texts the shop", calls.length === 1 && calls[0].body.To === "+18135550142", calls.map(c => c.body));

  calls.length = 0;
  await notifyNewLead({ business, pack: { notifications: {} }, lead });
  check("no sms_to = no send", calls.length === 0);

  calls.length = 0;
  await notifyNewLead({ business, pack: {}, lead });
  check("no notifications block = no send, no crash", calls.length === 0);

  calls.length = 0;
  await notifyNewLead({
    business,
    pack: { business: { phone: "(813) 555-0142" }, notifications: { sms_to: "8135550142", confirm_customer: true } },
    lead,
  });
  check("confirm_customer sends 2 texts", calls.length === 2, calls.map(c => c.body.To));
  check("second goes to the customer", calls[1] && calls[1].body.To === "+16562250102", calls[1] && calls[1].body);

  calls.length = 0;
  await notifyNewLead({
    business,
    pack: { notifications: { webhook_url: "https://hooks.example.com/x" } },
    lead,
  });
  check("webhook posted", calls.length === 1 && calls[0].url.includes("hooks.example.com"));

  console.log("\n=== a booking must survive Twilio being down ===");
  mode = "throw";
  let threw = false;
  try {
    await notifyNewLead({ business, pack: { notifications: { sms_to: "8135550142" } }, lead });
  } catch { threw = true; }
  check("notifyNewLead never throws", threw === false);
  mode = "ok";

  console.log("\n=== unconfigured Twilio ===");
  delete require.cache[require.resolve("./server/notify")];
  process.env.TWILIO_ACCOUNT_SID = "";
  process.env.TWILIO_AUTH_TOKEN = "";
  process.env.TWILIO_FROM_NUMBER = "";
  const fresh = require("./server/notify");
  check("smsConfigured false", fresh.smsConfigured === false);
  const r2 = await fresh.sendSms("6562250102", "x");
  check("sendSms reports not configured", r2.ok === false && r2.error === "sms_not_configured", r2);
  calls.length = 0;
  let threw2 = false;
  try {
    await fresh.notifyNewLead({ business, pack: { notifications: { sms_to: "8135550142" } }, lead });
  } catch { threw2 = true; }
  check("still never throws", threw2 === false);
  check("sends nothing", calls.length === 0);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
