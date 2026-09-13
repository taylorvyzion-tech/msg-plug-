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

const BOOKING_PROMPTS = {
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

function nextBookingStep(state, order) {
  for (const step of order) {
    if (!state.booking[step]) return step;
  }
  return null;
}

function handleBookingTurn(pack, state, raw, text) {
  const order = (pack.booking && pack.booking.ask_order) || [
    "service",
    "name",
    "phone",
    "time",
  ];

  if (hasAny(text, ["cancel", "never mind", "nevermind", "stop", "forget it"])) {
    state.flow = null;
    state.booking = {};
    return { reply: "No problem, cancelled. Anything else I can help with?", intent: "booking_cancel" };
  }

  const step = state.awaiting;

  if (step === "service") {
    const svc = findService(text, pack.services);
    if (svc) {
      state.booking.service = svc.name;
      state.booking.servicePrice = svc.price;
    } else {
      // Accept free text so nobody gets stuck in a loop.
      state.booking.service = raw.slice(0, 80);
    }
  } else if (step === "name") {
    const n = cleanName(raw);
    if (!n) {
      return { reply: "Sorry, I missed that — what name should I put down?", intent: "booking_name" };
    }
    state.booking.name = n;
  } else if (step === "phone") {
    if (!looksLikePhone(raw)) {
      return {
        reply: "That doesn't look like a phone number. What's the best number to text you at?",
        intent: "booking_phone",
      };
    }
    state.booking.phone = raw.replace(/[^\d+()\-. ]/g, "").trim().slice(0, 30);
  } else if (step === "time") {
    state.booking.time = raw.slice(0, 120);
  }

  const next = nextBookingStep(state, order);
  if (next) {
    state.awaiting = next;
    return { reply: BOOKING_PROMPTS[next](pack), intent: `booking_${next}` };
  }

  // Complete
  const b = state.booking;
  const confirm =
    (pack.booking && pack.booking.confirm) ||
    "You're on the list. Someone will reach out shortly to confirm.";
  const note = (pack.booking && pack.booking.handoff_note) || "";
  const phone = pack.business && pack.business.phone;

  const summary =
    `Here's what I have:\n` +
    `• Service: ${b.service}\n` +
    `• Name: ${b.name}\n` +
    `• Phone: ${b.phone}\n` +
    `• Preferred: ${b.time}\n\n` +
    confirm +
    (note && phone ? `\n\n${note} ${phone}` : "");

  const lead = {
    name: b.name,
    phone: b.phone,
    service: b.service,
    preferredTime: b.time,
    notes: null,
  };

  state.flow = null;
  state.awaiting = null;
  state.booking = {};

  return { reply: summary, intent: "booking_complete", lead };
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

  // Mid-booking? Stay in the flow.
  if (state.flow === "booking") {
    return handleBookingTurn(pack, state, raw, text);
  }

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

  // --- booking intent -----------------------------------------------------
  if (
    hasAny(text, [
      "book",
      "appointment",
      "appt",
      "schedule",
      "reserve",
      "slot",
      "get in",
      "come in",
      "set something up",
      "sign me up",
    ]) &&
    pack.booking &&
    pack.booking.enabled !== false
  ) {
    if (biz.booking_url) {
      return {
        reply: `You can book online here: ${biz.booking_url}\n\nOr tell me what you want and I'll take your info right here.`,
        intent: "booking_link",
      };
    }
    state.flow = "booking";
    state.booking = {};

    // If they already named the service, skip that question.
    const svc = findService(text, pack.services);
    const order = pack.booking.ask_order || ["service", "name", "phone", "time"];
    if (svc) {
      state.booking.service = svc.name;
      state.booking.servicePrice = svc.price;
    }
    const next = nextBookingStep(state, order);
    state.awaiting = next;
    return {
      reply: svc
        ? `${svc.name} — ${money(svc.price)}. ${BOOKING_PROMPTS[next](pack)}`
        : BOOKING_PROMPTS[next](pack),
      intent: `booking_${next}`,
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

module.exports = { respond, servicesList, hoursBlock, money, norm };
