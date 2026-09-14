// server/brain.js
// Pack-driven bot brain. No AI calls, no API bill.
// Every answer comes from the business's content pack, so one engine
// serves every shop you sell to.

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_LABELS = {
  sun: "Sunday",
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
};

const DAY_ALIASES = {
  sunday: "sun",
  sun: "sun",
  monday: "mon",
  mon: "mon",
  tuesday: "tue",
  tues: "tue",
  tue: "tue",
  wednesday: "wed",
  weds: "wed",
  wed: "wed",
  thursday: "thu",
  thurs: "thu",
  thur: "thu",
  thu: "thu",
  friday: "fri",
  fri: "fri",
  saturday: "sat",
  sat: "sat",
};

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(text, words) {
  return words.some((w) => text.includes(w));
}

// Whole-word match (with an optional trailing "s"), used for anything a shop
// owner types into their pack. Plain substring matching is too greedy there:
// the FAQ keyword "line" would fire on "lineups", and the service alias
// "beard" would fire on "beard oil".
const phraseCache = new Map();
function containsPhrase(text, phrase) {
  if (!phrase) return false;
  let re = phraseCache.get(phrase);
  if (!re) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(`(^|[^a-z0-9])${escaped}s?([^a-z0-9]|$)`, "i");
    phraseCache.set(phrase, re);
  }
  return re.test(text);
}

function money(n) {
  if (n === null || n === undefined || n === "") return "";
  return typeof n === "number" ? `$${n}` : String(n);
}

function servicesList(services) {
  if (!services || !services.length) return "";
  return services
    .map((s) => {
      const dur = s.duration_min ? ` · ${s.duration_min} min` : "";
      return `• ${s.name} — ${money(s.price)}${dur}`;
    })
    .join("\n");
}

function findService(text, services) {
  if (!services) return null;
  let best = null;
  let bestLen = 0;
  for (const s of services) {
    const keys = [s.name, ...(s.aliases || [])].map(norm).filter(Boolean);
    for (const k of keys) {
      if (k.length > bestLen && containsPhrase(text, k)) {
        best = s;
        bestLen = k.length;
      }
    }
  }
  return best;
}

function hoursBlock(hours) {
  if (!hours) return "";
  return DAY_KEYS.filter((d) => hours[d])
    .map((d) => `${DAY_LABELS[d]}: ${hours[d]}`)
    .join("\n");
}

function findDayInText(text) {
  for (const [alias, key] of Object.entries(DAY_ALIASES)) {
    if (new RegExp(`\\b${alias}\\b`).test(text)) return key;
  }
  return null;
}

function todayKey(timezone) {
  try {
    const name = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      timeZone: timezone || "America/New_York",
    }).format(new Date());
    return name.slice(0, 3).toLowerCase();
  } catch {
    return DAY_KEYS[new Date().getDay()];
  }
}

function matchFaq(text, faqs) {
  if (!faqs) return null;
  let best = null;
  let bestScore = 0;
  for (const f of faqs) {
    const keys = (f.keywords || []).map(norm).filter(Boolean);
    let score = 0;
    for (const k of keys) if (containsPhrase(text, k)) score += k.length;
    if (score > bestScore) {
      best = f;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

function looksLikePhone(text) {
  const digits = String(text).replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

function cleanName(raw) {
  return String(raw || "")
    .replace(/^(my name is|name's|name is|it's|its|i'm|im|this is)\s+/i, "")
    .replace(/[^A-Za-z\-'. ]/g, "")
    .trim()
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// Booking flow
// ---------------------------------------------------------------------------

const LEGACY_PROMPTS = {
  service: (pack) => {
    const list = servicesList(pack.services);
    return list
      ? `Let's get you booked. What service do you want?\n\n${list}`
      : "Let's get you booked. What service do you want?";
  },
  name: () => "Got it. What's your name?",
  phone: () => "What's the best phone number to reach you?",
  time: () =>
    "What day and time work best? (For example: \"Saturday morning\" or \"Thursday after 5\")",
};

const CANCEL_WORDS = ["cancel", "never mind", "nevermind", "stop", "forget it", "quit"];

// A message asking what something costs is a price question, even when it
// happens to contain a trigger word: "how much is a service call" must quote
// the price, not open an estimate form.
const PRICE_QUESTION_WORDS = [
  "how much", "what do you charge", "charge for", "cost", "price", "pricing",
  "rate", "rates", "how expensive", "ballpark",
];

const LEGACY_FIELDS = { service: "service", name: "name", phone: "phone", time: "preferredTime" };
const LEGACY_TYPES = { service: "service", name: "name", phone: "phone", time: "text" };
const LEGACY_LABELS = { service: "Service", name: "Name", phone: "Phone", time: "Preferred" };

// Appointment businesses (barber, salon) book a slot.
const BOOKING_TRIGGERS = [
  "book", "appointment", "appt", "schedule", "reserve", "slot",
  "get in", "come in", "set something up", "sign me up",
];
// Trades quote a job. Different words entirely.
const ESTIMATE_TRIGGERS = [
  "estimate", "quote", "come look", "come out", "send someone", "service call",
  "get someone out", "need someone", "someone out here", "schedule service",
  "set up service", "book service", "appointment",
];

/**
 * A pack defines either `lead_flow` (any vertical) or `booking` (legacy
 * appointment packs). Both normalize to the same internal shape so one
 * engine serves a barbershop and an HVAC company.
 */
function normalizeFlow(pack) {
  const lf = pack.lead_flow;
  if (lf && Array.isArray(lf.steps) && lf.steps.length) {
    return {
      enabled: lf.enabled !== false,
      triggers: (lf.trigger_words && lf.trigger_words.length
        ? lf.trigger_words
        : ESTIMATE_TRIGGERS
      ).map(norm),
      steps: lf.steps.map((s) => ({
        key: s.key,
        prompt: s.prompt || null,
        type: s.type || "text",
        field: s.field || null,
        label: s.label || cap(s.key),
      })),
      confirm: lf.confirm,
      handoff_note: lf.handoff_note,
    };
  }
  const b = pack.booking;
  if (b) {
    const order = b.ask_order || ["service", "name", "phone", "time"];
    return {
      enabled: b.enabled !== false,
      triggers: BOOKING_TRIGGERS,
      steps: order.map((k) => ({
        key: k,
        prompt: null, // supplied by LEGACY_PROMPTS
        type: LEGACY_TYPES[k] || "text",
        field: LEGACY_FIELDS[k] || null,
        label: LEGACY_LABELS[k] || cap(k),
      })),
      confirm: b.confirm,
      handoff_note: b.handoff_note,
    };
  }
  return { enabled: false, triggers: [], steps: [] };
}

function cap(s) {
  return String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1);
}

function promptFor(step, pack) {
  if (step.prompt) return step.prompt;
  const fn = LEGACY_PROMPTS[step.key];
  return fn ? fn(pack) : `What's your ${step.key}?`;
}

function nextStep(flow, state) {
  for (const s of flow.steps) if (!state.booking[s.key]) return s;
  return null;
}

function handleFlowTurn(pack, state, raw, text) {
  const flow = normalizeFlow(pack);

  // Whole-word matching matters here: plain substring made "it stopped
  // working last night" cancel the conversation, which loses a real lead.
  if (CANCEL_WORDS.some((w) => containsPhrase(text, w))) {
    state.flow = null;
    state.awaiting = null;
    state.booking = {};
    return { reply: "No problem, cancelled. Anything else I can help with?", intent: "booking_cancel" };
  }

  const step =
    flow.steps.find((s) => s.key === state.awaiting) || nextStep(flow, state);
  if (!step) {
    state.flow = null;
    return { reply: pack.fallback || "How else can I help?", intent: "fallback" };
  }

  if (step.type === "service") {
    const svc = findService(text, pack.services);
    state.booking[step.key] = svc ? svc.name : raw.slice(0, 120);
  } else if (step.type === "name") {
    const n = cleanName(raw);
    if (!n) {
      return { reply: "Sorry, I missed that — what name should I put down?", intent: `booking_${step.key}` };
    }
    state.booking[step.key] = n;
  } else if (step.type === "phone") {
    if (!looksLikePhone(raw)) {
      return {
        reply: "That doesn't look like a phone number. What's the best number to reach you at?",
        intent: `booking_${step.key}`,
      };
    }
    state.booking[step.key] = raw.replace(/[^\d+()\-. ]/g, "").trim().slice(0, 30);
  } else {
    state.booking[step.key] = raw.slice(0, 300);
  }

  const next = nextStep(flow, state);
  if (next) {
    state.awaiting = next.key;
    return { reply: promptFor(next, pack), intent: `booking_${next.key}` };
  }

  // --- complete -----------------------------------------------------------
  const data = state.booking;
  const lead = { name: null, phone: null, service: null, preferredTime: null, notes: null };
  const extras = [];

  for (const s of flow.steps) {
    const v = data[s.key];
    if (v === undefined || v === null || v === "") continue;
    if (s.field && Object.prototype.hasOwnProperty.call(lead, s.field)) {
      lead[s.field] = v;
    } else {
      // Steps with no mapped column ride along in notes, so a pack can ask
      // for anything (city, address, gate code) without a schema change.
      extras.push(`${s.label}: ${v}`);
    }
  }
  if (extras.length) lead.notes = extras.join(" | ");

  const summaryLines = flow.steps
    .filter((s) => data[s.key])
    .map((s) => `• ${s.label}: ${data[s.key]}`);

  const confirm =
    flow.confirm || "You're on the list. Someone will reach out shortly to confirm.";
  const note = flow.handoff_note || "";
  const phone = (pack.business && pack.business.phone) || "";

  const summary =
    "Here's what I have:\n" +
    summaryLines.join("\n") +
    "\n\n" +
    confirm +
    (note ? `\n\n${note.replace(/\{phone\}/g, phone)}` : "");

  state.flow = null;
  state.awaiting = null;
  state.booking = {};

  return { reply: summary, intent: "booking_complete", lead };
}

// ---------------------------------------------------------------------------
// Trade-specific intents
// ---------------------------------------------------------------------------

/**
 * "Do you come out to Ruskin?" — the single most common question a contractor
 * gets, and the one that wastes the most of their time.
 */
function checkServiceArea(text, pack) {
  const sa = pack.service_area;
  if (!sa) return null;

  const towns = (sa.towns || []).map((t) => ({ raw: t, n: norm(t) }));
  const hit = towns.find((t) => containsPhrase(text, t.n));

  const asked = hasAny(text, [
    "do you come", "do you service", "do you serve", "service area",
    "areas do you", "how far", "travel to", "in my area", "come out to",
    "do you cover", "you cover", "do you go", "do you work in",
  ]);

  if (hit) {
    const base = sa.yes_reply
      ? sa.yes_reply.replace(/\{town\}/g, hit.raw)
      : `Yes — we cover ${hit.raw}.`;
    return { reply: base, intent: "service_area_yes" };
  }

  if (asked && towns.length) {
    const list = towns.map((t) => t.raw).join(", ");
    const note = sa.radius_note ? `${sa.radius_note}\n\n` : "";
    const outside = sa.outside_reply ? `\n\n${sa.outside_reply}` : "";
    return {
      reply: `${note}We regularly work in: ${list}.${outside}\n\nWhat city are you in?`,
      intent: "service_area",
    };
  }
  return null;
}

/**
 * Urgent situations shouldn't be funneled through a four-step form.
 * Rules marked priority "safety" are checked before anything else, including
 * a conversation already in progress.
 */
function checkEmergency(text, pack, safetyOnly) {
  const em = pack.emergency;
  if (!em || em.enabled === false || !Array.isArray(em.rules)) return null;
  const phone = (pack.business && pack.business.phone) || "";

  for (const rule of em.rules) {
    if (safetyOnly && rule.priority !== "safety") continue;
    const kws = (rule.keywords || []).map(norm);
    if (kws.some((k) => containsPhrase(text, k))) {
      return {
        reply: String(rule.reply || "").replace(/\{phone\}/g, phone).trim(),
        intent: rule.intent || (rule.priority === "safety" ? "safety" : "emergency"),
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * @param {object} pack    The business content pack.
 * @param {object} state   Mutable per-session state ({ flow, awaiting, booking }).
 * @param {string} raw     The raw user message.
 * @returns {{reply:string, intent:string, lead?:object}}
 */
function respond(pack, state, raw) {
  pack = pack || {};
  state.booking = state.booking || {};
  const text = norm(raw);

  if (!text) {
    return { reply: pack.fallback || "Say that again?", intent: "empty" };
  }

  // Safety rules outrank everything, including a conversation in progress.
  const safety = checkEmergency(text, pack, true);
  if (safety) return safety;

  // Mid-flow? Stay in it. This must come before the emergency check — at the
  // "what's going on?" step, "my AC isn't cooling" is the answer, not an alarm.
  if (state.flow === "booking") {
    return handleFlowTurn(pack, state, raw, text);
  }

  // Urgent job, not yet in a flow — hand them the phone instead of a form.
  const urgent = checkEmergency(text, pack, false);
  if (urgent) return urgent;

  const biz = pack.business || {};
  const branding = pack.branding || {};

  // --- greeting -----------------------------------------------------------
  if (
    /^(hi|hey|hello|yo|sup|good morning|good afternoon|good evening|what's up|whats up)\b/.test(
      text
    )
  ) {
    return {
      reply:
        branding.greeting ||
        `Hey! I can help with hours, prices, services, or booking. What do you need?`,
      intent: "greeting",
    };
  }

  // --- thanks / bye -------------------------------------------------------
  if (hasAny(text, ["thank", "thanks", "appreciate it", "preciate"])) {
    return { reply: "Anytime. Anything else?", intent: "thanks" };
  }
  if (hasAny(text, ["bye", "goodbye", "later", "see you"])) {
    return { reply: "Later! Come see us.", intent: "bye" };
  }

  const askingPrice = hasAny(text, PRICE_QUESTION_WORDS);

  // --- service area -------------------------------------------------------
  // Runs BEFORE the flow trigger on purpose: "do you come out to Ruskin?"
  // contains the trigger phrase "come out", but it's a question, not a
  // request for a tech.
  if (!askingPrice) {
    const area = checkServiceArea(text, pack);
    if (area) return area;
  }

  // --- start the lead flow (booking or estimate) --------------------------
  const flow = normalizeFlow(pack);
  if (flow.enabled && !askingPrice && hasAny(text, flow.triggers)) {
    if (biz.booking_url) {
      return {
        reply: `You can book online here: ${biz.booking_url}\n\nOr tell me what you need and I'll take your info right here.`,
        intent: "booking_link",
      };
    }
    state.flow = "booking";
    state.booking = {};

    // If they already named a service, don't ask again.
    const svcStep = flow.steps.find((s) => s.type === "service");
    const svc = svcStep ? findService(text, pack.services) : null;
    if (svc) state.booking[svcStep.key] = svc.name;

    const next = nextStep(flow, state);
    if (!next) {
      state.flow = null;
      return { reply: pack.fallback || "How can I help?", intent: "fallback" };
    }
    state.awaiting = next.key;
    return {
      reply: svc
        ? `${svc.name} — ${money(svc.price)}. ${promptFor(next, pack)}`
        : promptFor(next, pack),
      intent: `booking_${next.key}`,
    };
  }


  // --- human handoff ------------------------------------------------------
  if (
    hasAny(text, [
      "human",
      "real person",
      "speak to someone",
      "talk to someone",
      "call you",
      "phone number",
      "your number",
      "manager",
      "owner",
    ])
  ) {
    return {
      reply: biz.phone
        ? `You can reach the shop at ${biz.phone}${biz.name ? ` — ask for anyone at ${biz.name}.` : "."}`
        : "Give us a call or stop in and someone will take care of you.",
      intent: "handoff",
    };
  }

  // --- hours --------------------------------------------------------------
  if (hasAny(text, ["hour", "open", "close", "closing", "opening", "what time", "still open"])) {
    const day = findDayInText(text);
    const isToday = hasAny(text, ["today", "right now", "now"]);
    const isTomorrow = text.includes("tomorrow");

    if (pack.hours) {
      if (day) {
        const v = pack.hours[day];
        return {
          reply: v
            ? `${DAY_LABELS[day]}: ${v}`
            : `I don't have ${DAY_LABELS[day]} listed. Here's the full week:\n\n${hoursBlock(pack.hours)}`,
          intent: "hours_day",
        };
      }
      if (isToday || isTomorrow) {
        const t = todayKey(biz.timezone);
        let key = t;
        if (isTomorrow) key = DAY_KEYS[(DAY_KEYS.indexOf(t) + 1) % 7];
        const v = pack.hours[key];
        const label = isTomorrow ? "Tomorrow" : "Today";
        return {
          reply: v
            ? `${label} (${DAY_LABELS[key]}): ${v}`
            : `Here are our hours:\n\n${hoursBlock(pack.hours)}`,
          intent: "hours_today",
        };
      }
      return { reply: `Our hours:\n\n${hoursBlock(pack.hours)}`, intent: "hours" };
    }
  }

  // --- specific service price --------------------------------------------
  const svc = findService(text, pack.services);
  if (svc && hasAny(text, ["price", "cost", "how much", "charge", "rate", "$"])) {
    const dur = svc.duration_min ? ` and takes about ${svc.duration_min} minutes` : "";
    return {
      reply: `${svc.name} is ${money(svc.price)}${dur}. Want me to book it?`,
      intent: "price_service",
    };
  }

  // --- general pricing / services list ------------------------------------
  if (
    hasAny(text, [
      "price",
      "pricing",
      "cost",
      "how much",
      "rate",
      "menu",
      "service",
      "services",
      "what do you do",
      "what do you offer",
      "list",
    ])
  ) {
    const list = servicesList(pack.services);
    if (list) {
      return {
        reply: `Here's what we offer:\n\n${list}\n\nSay the word and I'll book you.`,
        intent: "services",
      };
    }
  }

  // --- location -----------------------------------------------------------
  if (hasAny(text, ["where", "location", "address", "directions", "find you", "located"])) {
    if (biz.address) {
      const park = biz.parking ? `\n\n${biz.parking}` : "";
      return { reply: `We're at ${biz.address}.${park}`, intent: "location" };
    }
  }
  if (hasAny(text, ["parking", "park my car"]) && biz.parking) {
    return { reply: biz.parking, intent: "parking" };
  }

  // --- stylists / barbers -------------------------------------------------
  if (hasAny(text, ["barber", "stylist", "who cut", "who does", "staff", "team", "specific person"])) {
    if (pack.stylists && pack.stylists.length) {
      const list = pack.stylists
        .map((s) => {
          const days = (s.days || []).map((d) => DAY_LABELS[d]?.slice(0, 3)).join(", ");
          return `• ${s.name} — ${s.specialty}${days ? ` (${days})` : ""}`;
        })
        .join("\n");
      return { reply: `Our team:\n\n${list}`, intent: "stylists" };
    }
  }

  // --- policies -----------------------------------------------------------
  const p = pack.policies || {};
  if (hasAny(text, ["cancel", "reschedule", "cancellation"]) && p.cancellation) {
    return { reply: p.cancellation, intent: "policy_cancellation" };
  }
  if (hasAny(text, ["late", "running behind", "run late"]) && p.late) {
    return { reply: p.late, intent: "policy_late" };
  }
  if (hasAny(text, ["deposit", "upfront", "pay ahead"]) && p.deposit) {
    return { reply: p.deposit, intent: "policy_deposit" };
  }
  if (
    hasAny(text, ["pay", "payment", "cash", "card", "venmo", "zelle", "apple pay", "cash app"]) &&
    p.payment
  ) {
    return { reply: p.payment, intent: "policy_payment" };
  }
  if (hasAny(text, ["walk in", "walkin", "walk-in"]) && p.walkins) {
    return { reply: p.walkins, intent: "policy_walkins" };
  }
  if (hasAny(text, ["consultation", "consult"]) && p.consultation) {
    return { reply: p.consultation, intent: "policy_consultation" };
  }
  if (hasAny(text, ["guarantee", "not happy", "mess up", "messed up", "fix it"]) && p.guarantee) {
    return { reply: p.guarantee, intent: "policy_guarantee" };
  }

  // --- FAQs ---------------------------------------------------------------
  // These run before the loose service match on purpose. Service aliases are
  // greedy ("cut", "color", "beard"), so a question like "do you sell beard
  // oil" would otherwise be answered as a beard-trim price quote.
  const faq = matchFaq(text, pack.faqs);
  if (faq) {
    return { reply: faq.a, intent: "faq" };
  }

  // --- bare service mention ("do you do fades?") --------------------------
  // Last real check: anything that merely names a service and nothing else.
  if (svc) {
    const dur = svc.duration_min ? ` · about ${svc.duration_min} min` : "";
    return {
      reply: `Yes — ${svc.name} is ${money(svc.price)}${dur}. Want to book it?`,
      intent: "service_mention",
    };
  }

  // --- fallback -----------------------------------------------------------
  return {
    reply:
      pack.fallback ||
      "I can help with hours, prices, services, our location, or booking. Which one?",
    intent: "fallback",
  };
}

module.exports = {
  respond,
  servicesList,
  hoursBlock,
  money,
  norm,
  normalizeFlow,
  checkServiceArea,
  checkEmergency,
};
