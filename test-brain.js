const { respond } = require("./server/brain");
const pack = require("./packs/barber.json");
const salon = require("./packs/salon.json");

let pass = 0, fail = 0;
function check(label, got, expectFn) {
  const ok = expectFn(got);
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got: ${JSON.stringify(got).slice(0,160)}`); }
}
const has = (sub) => (r) => r.reply.toLowerCase().includes(sub.toLowerCase());
const intentIs = (i) => (r) => r.intent === i;

function fresh() { return { flow: null, awaiting: null, booking: {} }; }

console.log("\n=== single-turn intents (barber) ===");
const s = fresh();
check("greeting", respond(pack, s, "hey"), has("Fresh Fade"));
check("hours", respond(pack, s, "what are your hours?"), has("Tuesday"));
check("hours monday closed", respond(pack, s, "are you open monday"), has("Closed"));
check("hours saturday", respond(pack, s, "what time do you close saturday"), has("8:00a"));
check("hours today", respond(pack, s, "are you open today?"), intentIs("hours_today"));
check("general prices", respond(pack, s, "how much do you charge?"), has("Haircut"));
check("specific price", respond(pack, s, "how much for a beard trim"), has("$15"));
check("fade price", respond(pack, s, "price for a skin fade"), has("$30"));
check("bare service", respond(pack, s, "do you do lineups?"), has("$12"));
check("kids", respond(pack, s, "do you cut kids hair"), has("20"));
check("location", respond(pack, s, "where are you located"), has("Apollo Beach"));
check("parking", respond(pack, s, "is there parking"), has("lot"));
check("stylists", respond(pack, s, "who are your barbers"), has("Marcus"));
check("payment", respond(pack, s, "do you take cash app"), has("Cash App"));
check("cancellation", respond(pack, s, "can I cancel"), has("2 hours"));
check("late policy", respond(pack, s, "what if I'm late"), has("15 minutes"));
check("walkins", respond(pack, s, "do you take walk-ins"), has("Walk-ins welcome"));
check("guarantee", respond(pack, s, "what if you mess up my cut"), has("7 days"));
check("faq products", respond(pack, s, "do you sell beard oil"), has("$12"));
check("faq wait", respond(pack, s, "how long is the wait"), has("15"));
check("handoff", respond(pack, s, "can I talk to a real person"), has("813"));
check("thanks", respond(pack, s, "thanks"), intentIs("thanks"));
check("fallback", respond(pack, s, "asdfghjkl qwerty"), intentIs("fallback"));

console.log("\n=== booking flow, happy path ===");
const b = fresh();
check("start booking", respond(pack, b, "I want to book an appointment"), intentIs("booking_service"));
check("pick service", respond(pack, b, "a fade"), intentIs("booking_name"));
check("give name", respond(pack, b, "my name is Todd"), intentIs("booking_phone"));
check("bad phone rejected", respond(pack, b, "idk"), intentIs("booking_phone"));
check("good phone", respond(pack, b, "813-555-0199"), intentIs("booking_time"));
const done = respond(pack, b, "Saturday morning");
check("completes", done, intentIs("booking_complete"));
check("summary has service", done, has("Haircut"));
check("summary has name", done, has("Todd"));
check("summary has time", done, has("Saturday morning"));
check("lead object built", done, (r) => r.lead && r.lead.phone && r.lead.name === "Todd");
check("state reset", { reply: "", intent: String(b.flow) }, (r) => r.intent === "null");

console.log("\n=== booking, service named upfront ===");
const b2 = fresh();
check("skips service question", respond(pack, b2, "can I book a hot towel shave"), intentIs("booking_name"));
check("price surfaced", respond(pack, b2, "book a beard trim"), (r) => true);

console.log("\n=== booking, cancel mid-flow ===");
const b3 = fresh();
respond(pack, b3, "book me");
check("cancels", respond(pack, b3, "never mind"), intentIs("booking_cancel"));
check("flow cleared", { reply: "", intent: String(b3.flow) }, (r) => r.intent === "null");

console.log("\n=== same engine, salon pack ===");
const s2 = fresh();
check("salon greeting", respond(salon, s2, "hello"), has("Crown"));
check("salon balayage price", respond(salon, s2, "how much is balayage"), has("$195"));
check("salon braids", respond(salon, s2, "do you do knotless braids"), has("$180"));
check("salon deposit", respond(salon, s2, "is there a deposit"), has("$50"));
check("salon consult faq", respond(salon, s2, "do I need a consultation for color"), has("free"));
check("salon natural hair", respond(salon, s2, "do you do natural hair"), has("silk press"));
check("salon sunday closed", respond(salon, s2, "open sunday?"), has("Closed"));
check("salon no walkins", respond(salon, s2, "do you take walk ins"), has("appointment-only"));

console.log("\n=== edge cases ===");
const e = fresh();
check("empty message", respond(pack, e, ""), intentIs("empty"));
check("empty pack doesn't crash", respond({}, fresh(), "hours"), (r) => typeof r.reply === "string");
check("very long input", respond(pack, e, "x".repeat(900)), (r) => typeof r.reply === "string");
check("caps", respond(pack, e, "WHAT ARE YOUR HOURS"), has("Tuesday"));
check("punctuation", respond(pack, e, "how much???"), has("Haircut"));
check("curly apostrophe", respond(pack, e, "what’s the price"), has("Haircut"));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
