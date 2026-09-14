const { respond } = require("./server/brain");
const hvac = require("./packs/hvac.json");
const barber = require("./packs/barber.json");

let pass = 0, fail = 0;
function check(label, got, fn) {
  const ok = fn(got);
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       ${JSON.stringify(got).slice(0, 200)}`); }
}
const has = (s) => (r) => r.reply.toLowerCase().includes(s.toLowerCase());
const intentIs = (i) => (r) => r.intent === i;
const fresh = () => ({ flow: null, awaiting: null, booking: {} });

console.log("\n=== service area ===");
let s = fresh();
check("names a covered town", respond(hvac, s, "do you come out to Ruskin?"), has("Ruskin is right in our service area"));
check("bare town mention", respond(hvac, s, "I'm in Apollo Beach"), intentIs("service_area_yes"));
check("general area question", respond(hvac, s, "what areas do you cover"), has("South Hillsborough"));
check("lists towns", respond(hvac, s, "do you service my area"), has("Sun City Center"));
check("uncovered town falls through to list", respond(hvac, s, "do you come out to Sarasota"), intentIs("service_area"));
check("location intent not hijacked", respond(hvac, s, "where are you located"), intentIs("location"));

console.log("\n=== safety rules ===");
s = fresh();
const gas = respond(hvac, s, "I think I smell gas in the house");
check("gas = evacuate, not a sales pitch", gas, has("Leave the building"));
check("gas tells them to call 911", gas, has("911"));
check("gas intent", gas, intentIs("safety_gas"));
const burn = respond(hvac, s, "there's a burning smell coming from the vents");
check("burning smell = breaker + 911", burn, has("breaker"));
check("electrical intent", burn, intentIs("safety_electrical"));

console.log("\n=== urgent jobs skip the form ===");
s = fresh();
const noac = respond(hvac, s, "my ac is out and it's 95 degrees");
check("gives the phone number immediately", noac, has("(813) 555-0164"));
check("emergency intent", noac, intentIs("emergency"));
check("still offers to take info", noac, has("schedule service"));
check("no heat too", respond(hvac, fresh(), "we have no heat"), intentIs("emergency"));

console.log("\n=== pricing & FAQs ===");
s = fresh();
check("diagnostic price", respond(hvac, s, "how much is a service call"), has("$89"));
check("tune-up price", respond(hvac, s, "what does a tune up cost"), has("$129"));
check("won't guess new system price", respond(hvac, s, "how much is a new ac"), has("free"));
check("how soon", respond(hvac, s, "how soon can you get here"), has("same-day"));
check("financing", respond(hvac, s, "do you offer financing"), has("approved credit"));
check("licensed", respond(hvac, s, "are you licensed and insured"), has("licensed"));
check("brands", respond(hvac, s, "do you work on Trane"), has("Trane"));
check("high bill", respond(hvac, s, "my electric bill is crazy high"), has("duct"));
check("hours", respond(hvac, s, "what time do you open saturday"), has("8:00a"));

console.log("\n=== estimate flow ===");
const f = fresh();
check("starts on 'schedule service'", respond(hvac, f, "I need to schedule service"), intentIs("booking_job"));
check("asks name next", respond(hvac, f, "AC not cooling upstairs"), intentIs("booking_name"));
check("asks phone", respond(hvac, f, "Todd"), intentIs("booking_phone"));
check("rejects bad phone", respond(hvac, f, "nope"), intentIs("booking_phone"));
check("asks city", respond(hvac, f, "8135550199"), intentIs("booking_city"));
check("asks timing", respond(hvac, f, "Wimauma"), intentIs("booking_timing"));
const done = respond(hvac, f, "today if possible");
check("completes", done, intentIs("booking_complete"));
check("summary shows job", done, has("AC not cooling upstairs"));
check("summary shows city", done, has("Wimauma"));
check("lead maps job to service", done, (r) => r.lead.service === "AC not cooling upstairs");
check("lead maps timing to preferredTime", done, (r) => r.lead.preferredTime === "today if possible");
check("unmapped city rides in notes", done, (r) => r.lead.notes && r.lead.notes.includes("City: Wimauma"));
check("name and phone captured", done, (r) => r.lead.name === "Todd" && r.lead.phone === "8135550199");

console.log("\n=== mid-flow, a symptom is an answer not an alarm ===");
const f2 = fresh();
respond(hvac, f2, "I need an estimate");
const midflow = respond(hvac, f2, "no ac, it stopped working last night");
check("does NOT bail to emergency mid-flow", midflow, intentIs("booking_name"));
check("captured the symptom as the job", midflow, () => String(f2.booking.job || "").includes("no ac"));

console.log("\n=== but a gas leak still interrupts ===");
const f3 = fresh();
respond(hvac, f3, "I need an estimate");
check("safety overrides an active flow", respond(hvac, f3, "wait, I smell gas"), intentIs("safety_gas"));

console.log("\n=== 'quote' and 'come out' also start it ===");
check("quote", respond(hvac, fresh(), "can I get a quote"), intentIs("booking_job"));
check("come out", respond(hvac, fresh(), "can someone come out"), intentIs("booking_job"));
check("estimate", respond(hvac, fresh(), "I want an estimate on a new system"), intentIs("booking_job"));

console.log("\n=== barbershop must still work unchanged ===");
const b = fresh();
check("barber booking starts", respond(barber, b, "I want to book an appointment"), intentIs("booking_service"));
check("service step", respond(barber, b, "a fade"), intentIs("booking_name"));
check("name step", respond(barber, b, "Todd"), intentIs("booking_phone"));
check("phone step", respond(barber, b, "8135550199"), intentIs("booking_time"));
const bdone = respond(barber, b, "saturday morning");
check("barber completes", bdone, intentIs("booking_complete"));
check("barber lead intact", bdone, (r) => r.lead.service === "Haircut" && r.lead.preferredTime === "saturday morning" && r.lead.name === "Todd");
check("barber notes stay empty", bdone, (r) => r.lead.notes === null);
check("barber has no service_area intent", respond(barber, fresh(), "do you come to Ruskin"), (r) => r.intent !== "service_area_yes");
check("barber unaffected by emergency rules", respond(barber, fresh(), "no heat"), (r) => r.intent !== "emergency");

console.log("\n=== edge cases ===");
check("empty pack survives", respond({}, fresh(), "do you cover my area"), (r) => typeof r.reply === "string");
check("pack with no flow survives", respond({ business: { name: "X" } }, fresh(), "get an estimate"), (r) => typeof r.reply === "string");
check("hvac fallback", respond(hvac, fresh(), "zzzxxqq"), intentIs("fallback"));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
