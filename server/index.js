// server/index.js
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const { PrismaClient } = require("@prisma/client");
const { respond } = require("./brain");
const { notifyNewLead, sendSms, smsConfigured } = require("./notify");

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "..", "public");

// Behind Render/Fly/nginx, req.ip is the proxy unless we trust one hop.
// Rate limiting is worthless without this.
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.static(PUBLIC_DIR));

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
// In-memory and per-process, which is fine for a single instance. Move to
// Redis if this ever runs on more than one.

function makeLimiter({ windowMs, max, message }) {
  const hits = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
  }, windowMs).unref();

  return function limiter(req, res, next) {
    const key = req.ip || "unknown";
    const now = Date.now();
    let b = hits.get(key);
    if (!b || now > b.reset) {
      b = { count: 0, reset: now + windowMs };
      hits.set(key, b);
    }
    b.count++;
    if (b.count > max) {
      res.set("Retry-After", Math.ceil((b.reset - now) / 1000));
      // `reply` is included so the chat widget renders something human
      // instead of a raw error.
      return res.status(429).json({ error: "rate_limited", reply: message });
    }
    next();
  };
}

const chatLimiter = makeLimiter({
  windowMs: 60_000,
  max: 20,
  message: "You're sending messages faster than I can keep up. Give me a minute, or call us directly.",
});

// Slow down anyone trying admin keys by brute force.
const adminLimiter = makeLimiter({
  windowMs: 60_000,
  max: 30,
  message: "Too many requests.",
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAdmin(req) {
  const key = req.get("x-admin-key") || (req.body && req.body.adminKey);
  const expected = process.env.ADMIN_KEY;
  return Boolean(expected) && key === expected;
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function parsePack(business) {
  if (!business || !business.packJson) return {};
  try {
    return JSON.parse(business.packJson);
  } catch {
    return {};
  }
}

// In-memory conversation state. Fine for a single process; move to Redis or a
// DB table when you run more than one instance.
const sessions = new Map();
const SESSION_TTL_MS = 1000 * 60 * 60; // 1 hour

function getSession(id) {
  const now = Date.now();
  let s = sessions.get(id);
  if (!s || now - s.touched > SESSION_TTL_MS) {
    s = { flow: null, awaiting: null, booking: {}, touched: now };
    sessions.set(id, s);
  }
  s.touched = now;
  return s;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.touched > SESSION_TTL_MS) sessions.delete(id);
  }
}, 1000 * 60 * 10).unref();

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// Public chat page for one business.
app.get("/c/:slug", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "chat.html"));
});

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

// Create or update a business from a content pack.
app.post("/api/business", adminLimiter, async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(401).json({ error: "bad_admin_key" });

    const { name, ownerEmail, pack } = req.body;
    const slug = slugify(req.body.slug || name);

    if (!name || !slug) {
      return res.status(400).json({ error: "name_and_slug_required" });
    }

    const packObj = pack && typeof pack === "object" ? pack : {};
    const packJson = Object.keys(packObj).length ? JSON.stringify(packObj) : null;
    const bizInfo = packObj.business || {};

    const data = {
      name,
      ownerEmail: ownerEmail || null,
      phone: bizInfo.phone || null,
      industry: bizInfo.industry || null,
      packJson,
    };

    const business = await prisma.business.upsert({
      where: { slug },
      update: data,
      create: { ...data, slug },
    });

    const botName = packObj.bot_id || `${name} Bot`;
    const existingBot = await prisma.chatbot.findFirst({
      where: { businessId: business.id },
    });
    if (existingBot) {
      await prisma.chatbot.update({
        where: { id: existingBot.id },
        data: {
          name: botName,
          description: (packObj.branding && packObj.branding.greeting) || null,
        },
      });
    } else {
      await prisma.chatbot.create({
        data: {
          name: botName,
          description: (packObj.branding && packObj.branding.greeting) || null,
          businessId: business.id,
        },
      });
    }

    res.json({
      ok: true,
      businessId: business.id,
      slug: business.slug,
      chatUrl: `/c/${business.slug}`,
    });
  } catch (err) {
    console.error("POST /api/business", err);
    res.status(500).json({ error: "server_error" });
  }
});

// Send yourself a test text to confirm Twilio is wired up correctly.
app.post("/api/test-sms", adminLimiter, async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: "bad_admin_key" });
  if (!smsConfigured) {
    return res.status(400).json({
      error: "sms_not_configured",
      hint: "Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER in .env, then restart.",
    });
  }
  const to = req.body && req.body.to;
  if (!to) return res.status(400).json({ error: "to_required" });

  const result = await sendSms(
    to,
    "MSGPlug test message. If you got this, new-booking alerts will reach you."
  );
  return res.status(result.ok ? 200 : 502).json(result);
});

// Load a starter pack template from /packs so the admin UI can prefill it.
app.get("/api/pack-template/:name", adminLimiter, (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: "bad_admin_key" });
  const name = String(req.params.name).replace(/[^a-z0-9_-]/gi, "");
  const file = path.join(__dirname, "..", "packs", `${name}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "not_found" });
  try {
    res.json({ ok: true, pack: JSON.parse(fs.readFileSync(file, "utf8")) });
  } catch {
    res.status(500).json({ error: "bad_pack_json" });
  }
});

// List businesses.
app.get("/api/businesses", adminLimiter, async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(401).json({ error: "bad_admin_key" });
    const list = await prisma.business.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        slug: true,
        industry: true,
        ownerEmail: true,
        createdAt: true,
        _count: { select: { leads: true } },
      },
    });
    res.json({ ok: true, businesses: list });
  } catch (err) {
    console.error("GET /api/businesses", err);
    res.status(500).json({ error: "server_error" });
  }
});

// Leads for one business.
app.get("/api/leads/:slug", adminLimiter, async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(401).json({ error: "bad_admin_key" });
    const business = await prisma.business.findUnique({
      where: { slug: req.params.slug },
    });
    if (!business) return res.status(404).json({ error: "not_found" });

    const leads = await prisma.lead.findMany({
      where: { businessId: business.id },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json({ ok: true, leads });
  } catch (err) {
    console.error("GET /api/leads", err);
    res.status(500).json({ error: "server_error" });
  }
});

// ---------------------------------------------------------------------------
// Public chat API
// ---------------------------------------------------------------------------

// What the chat page needs to render itself (branding + greeting only).
app.get("/api/pack/:slug", chatLimiter, async (req, res) => {
  try {
    const business = await prisma.business.findUnique({
      where: { slug: req.params.slug },
    });
    if (!business || !business.active) {
      return res.status(404).json({ error: "not_found" });
    }
    const pack = parsePack(business);
    res.json({
      ok: true,
      name: business.name,
      branding: pack.branding || {},
      business: {
        phone: (pack.business && pack.business.phone) || null,
        address: (pack.business && pack.business.address) || null,
      },
      suggestions: buildSuggestions(pack),
    });
  } catch (err) {
    console.error("GET /api/pack", err);
    res.status(500).json({ error: "server_error" });
  }
});

function buildSuggestions(pack) {
  const s = ["Hours", "Prices"];
  if (pack.service_area) s.push("Do you cover my area?");
  else if (pack.business && pack.business.address) s.push("Where are you?");

  if (pack.lead_flow && pack.lead_flow.enabled !== false) s.push("Get an estimate");
  else if (pack.booking && pack.booking.enabled !== false) s.push("Book an appointment");
  return s;
}

app.post("/api/chat", chatLimiter, async (req, res) => {
  try {
    const { slug, message } = req.body;
    const sessionId = String(req.body.sessionId || "").slice(0, 64) || "anon";

    if (!slug || typeof message !== "string") {
      return res.status(400).json({ error: "slug_and_message_required" });
    }
    if (message.length > 1000) {
      return res.status(400).json({ error: "message_too_long" });
    }

    const business = await prisma.business.findUnique({ where: { slug } });
    if (!business || !business.active) {
      return res.status(404).json({ error: "not_found" });
    }

    const pack = parsePack(business);
    const state = getSession(`${slug}:${sessionId}`);
    const result = respond(pack, state, message);

    // Persist the booking request as a lead.
    let leadId = null;
    if (result.lead) {
      const lead = await prisma.lead.create({
        data: {
          businessId: business.id,
          name: result.lead.name || null,
          phone: result.lead.phone || null,
          service: result.lead.service || null,
          preferredTime: result.lead.preferredTime || null,
          notes: result.lead.notes || null,
          sessionId,
        },
      });
      leadId = lead.id;
      console.log(
        `📥 New lead for ${business.name}: ${lead.name} — ${lead.service} — ${lead.phone}`
      );

      // Fire notifications without making the customer wait on Twilio.
      notifyNewLead({ business, pack, lead }).catch((e) =>
        console.error("notify", e)
      );
    }

    // Log the exchange (best effort; never block the reply).
    prisma.chatLog
      .createMany({
        data: [
          { businessId: business.id, sessionId, role: "user", text: message, intent: result.intent },
          { businessId: business.id, sessionId, role: "bot", text: result.reply, intent: result.intent },
        ],
      })
      .catch((e) => console.error("chatlog", e));

    res.json({ ok: true, reply: result.reply, intent: result.intent, leadId });
  } catch (err) {
    console.error("POST /api/chat", err);
    res.status(500).json({ error: "server_error" });
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if (!process.env.ADMIN_KEY) {
  console.warn("⚠️  ADMIN_KEY is not set in .env — admin endpoints will reject everything.");
}

console.log(
  smsConfigured
    ? "📱 SMS alerts: ON (Twilio configured)"
    : "📱 SMS alerts: OFF — add Twilio keys to .env to text shops on new bookings."
);

const packsDir = path.join(__dirname, "..", "packs");
if (fs.existsSync(packsDir)) {
  const available = fs
    .readdirSync(packsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
  if (available.length) console.log(`📦 Packs available: ${available.join(", ")}`);
}

app.listen(PORT, () => {
  console.log(`✅ Chatbot SaaS listening on http://localhost:${PORT}`);
  console.log(`🔧 Admin UI:  http://localhost:${PORT}/admin.html`);
});
