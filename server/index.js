// server code placeholder
// server/index.js
const path = require("path");
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
dotenv.config();

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// Serve files from /public (so /admin.html works)
app.use(express.static(path.join(__dirname, "..", "public")));
// Explicit route: serve the admin page
app.get("/", (req, res) => {
  res.redirect("/admin.html");
});
// Simple health check
app.get("/health", (_req, res) => res.json({ ok: true }));

// Create a business + (optional) a simple chatbot
// Expect body: { adminKey, name, slug, ownerEmail, pack }
app.post("/api/business", async (req, res) => {
  try {
    const { adminKey, name, slug, ownerEmail, pack } = req.body;

    if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
      return res.status(401).json({ error: "Bad admin key" });
    }
    if (!name || !slug) {
      return res.status(400).json({ error: "name and slug are required" });
    }

    // Create Business
    const business = await prisma.business.create({
      data: {
        name,
        industry: pack?.business?.industry || null,
      },
    });

    // Create a simple Chatbot tied to the business
    await prisma.chatbot.create({
      data: {
        name: pack?.bot_id || `${name} Bot`,
        description: pack?.branding?.greeting || "Business assistant",
        businessId: business.id,
      },
    });

    return res.json({ ok: true, businessId: business.id, slug });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

// Very simple public chatbot page for demo
app.get("/c/:slug", async (req, res) => {
  // In a full app, you’d look up the business by slug.
  // For now, just render a tiny page that echoes messages.
  res.send(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Chatbot</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:40px auto">
  <h2>Chatbot Demo for ${req.params.slug}</h2>
  <div id="log" style="border:1px solid #ccc;padding:12px;height:240px;overflow:auto"></div>
  <div style="margin-top:8px">
    <input id="msg" placeholder="Type 'prices', 'hours', or 'book'..." style="width:75%;padding:8px">
    <button onclick="send()" style="padding:8px 12px">Send</button>
  </div>
  <script>
    const log = document.getElementById('log');
    function say(who, text){ const p=document.createElement('p'); p.innerHTML = '<b>'+who+':</b> '+text; log.appendChild(p); log.scrollTop = log.scrollHeight; }
    function send(){
      const v = document.getElementById('msg').value.trim(); if(!v) return;
      say('You', v);
      // toy intent logic just for demo:
      let reply = "I can help with hours, prices, or booking.";
      if(/hour|open|close/i.test(v)) reply = "Tue–Sat 9a–7p, Sun 10a–3p, Mon closed.";
      if(/price|how much/i.test(v)) reply = "Cuts $25, beard $15, full $35.";
      if(/book|appoint/i.test(v)) reply = "Drop your name/phone and we’ll confirm!";
      say('Bot', reply);
      document.getElementById('msg').value = '';
    }
  </script>
</body></html>`);
});
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Chatbot SaaS Starter listening on http://localhost:${PORT}`);
  console.log(`🔧 Admin UI: http://localhost:${PORT}/admin.html`);
});