# Chatbot SaaS Starter

A multi-tenant chatbot platform for barbershops and hair salons. One engine,
many shops — each shop's answers come from its own **content pack** (a JSON
file), so onboarding a new client means editing JSON, not writing code.

---

## Quick start

```bash
npm install

# One-time: rebuild the local database with the new schema.
# This wipes dev.db (it only holds test data).
npx prisma migrate reset --force
npx prisma migrate dev --name barber_pack
npx prisma generate

npm start
```

Then open **http://localhost:3000/admin.html**

1. Paste your `ADMIN_KEY` from `.env`
2. Pick a template (Barbershop or Salon) → **Load template**
3. Edit the hours, prices, address and phone for the real shop
4. **Create / update shop**
5. Open the chat link it gives you: `/c/your-shop-slug`

---

## How it works

```
packs/barber.json   →  stored on the Business row as packJson
                        ↓
server/brain.js     →  matches the customer's message against the pack
                        ↓
/api/chat           →  returns a reply, saves a Lead when a booking completes
```

**No AI API calls, no per-message cost.** Everything the bot says comes from
the shop's pack.

### What the bot handles today

| Intent | Example question |
|---|---|
| Hours | "are you open Saturday?", "what time do you close today?" |
| Services & pricing | "how much for a skin fade?", "what do you offer?" |
| Location & parking | "where are you?", "is there parking?" |
| Staff | "who are your barbers?" |
| Policies | "can I cancel?", "do you take Cash App?", "do you take walk-ins?" |
| FAQs | anything you add to the pack's `faqs` array |
| Booking | multi-step: service → name → phone → preferred time → saved as a Lead |
| Human handoff | "can I talk to a real person?" |

Anything it can't match falls back to the pack's `fallback` message.

---

## Adding a new shop

Copy `packs/barber.json`, change the content, and paste it into the admin UI.
The fields that matter:

- `business` — name, phone, address, timezone
- `branding` — greeting, accent color, emoji (drives the chat page's look)
- `hours` — keys `mon` through `sun`
- `services` — `name`, `price`, `duration_min`, and `aliases` (what customers
  actually call it: "fade", "lineup", "shape up")
- `stylists` — name, specialty, days
- `policies` — cancellation, late, deposit, payment, walkins, guarantee
- `faqs` — `q`, `a`, and `keywords` to match on
- `fallback` — what to say when nothing matches

**Aliases are where the quality is.** The more ways a real customer might
phrase a service, the better the bot performs. Listen to what shops' customers
actually text and keep adding them.

---

## Putting the bot on a shop's website

One line on their site:

```html
<script src="https://your-host.com/widget.js"
        data-slug="fresh-fade-studio"
        data-accent="#C9A227"
        data-label="Chat with us"></script>
```

Optional attributes: `data-emoji`, `data-position="left"`, `data-host`.

---

## Deploying (Render)

`render.yaml` is a blueprint — Render reads it and configures everything.

1. Push to GitHub (already done if you followed setup)
2. Go to https://render.com → sign in with GitHub
3. **New → Blueprint** → pick the `msg-plug-` repo → **Apply**
4. Wait for the first deploy (3–5 min)
5. **Dashboard → your service → Environment** → copy the generated `ADMIN_KEY`
6. Open `https://your-service.onrender.com/admin.html` and paste that key

Your chat links are then `https://your-service.onrender.com/c/<slug>` — send
those to prospects.

### Why the disk matters

Render wipes the filesystem on every deploy and restart. Without the mounted
disk in `render.yaml`, your SQLite database — every client and every captured
lead — is gone the next time the service redeploys. The blueprint mounts a 1GB
disk at `/var/data` and points `DATABASE_URL` there.

Migrations run in the **start** command, not the build command, because the
disk is only mounted at runtime.

### Free plan vs Starter

The blueprint uses `plan: starter` (~$7/month). You can change it to `free`,
but know the two tradeoffs:

- **No persistent disk on free.** Leads vanish on redeploy.
- **Free services sleep after 15 minutes idle.** The next visitor waits ~50
  seconds for a cold start. That's fatal for a demo link you sent a prospect —
  they'll close the tab before it loads.

For a demo you're sending to prospects, Starter is worth the $7.

### Going to a custom domain

Render → Settings → Custom Domains. Point a subdomain like `chat.yourdomain.com`
at it so client links don't read `onrender.com`.

## SMS alerts on new bookings

When a booking completes, the shop gets a text:

```
New booking request — Fresh Fade Studio
Beard Trim
Todd — 6562250102
Prefers: saturday
```

**Setup (one time, ~10 minutes):**

1. Make a Twilio account at https://twilio.com and buy a phone number
   (about $1.15/month, ~$0.0079 per text in the US)
2. From https://console.twilio.com copy your Account SID and Auth Token
3. Put all three in `.env`:

```
TWILIO_ACCOUNT_SID="ACxxxxxxxx"
TWILIO_AUTH_TOKEN="xxxxxxxx"
TWILIO_FROM_NUMBER="+18135551234"
```

4. Restart the server. You should see `📱 SMS alerts: ON`
5. Test it without faking a booking:

```bash
curl -X POST http://localhost:3000/api/test-sms ^
  -H "Content-Type: application/json" ^
  -H "x-admin-key: YOUR_ADMIN_KEY" ^
  -d "{\"to\":\"5551234567\"}"
```

**Per shop**, set where the alert goes in that shop's pack:

```json
"notifications": {
  "sms_to": "+18135550142",
  "confirm_customer": false,
  "webhook_url": ""
}
```

- `sms_to` — the shop's phone. **No SMS is sent unless this is set**, so a
  template with a placeholder number can never text a stranger.
- `confirm_customer` — also text the customer a confirmation. Doubles your
  Twilio cost per booking; worth it for no-show reduction.
- `webhook_url` — POSTs the lead as JSON. Free alternative to SMS: point it at
  Zapier, Make, or a Slack workflow to get email or Slack alerts instead.

Notifications are fire-and-forget. If Twilio is down, misconfigured, or the
number is malformed, the failure is logged and the customer's booking still
saves normally. The app runs fine with no Twilio keys at all — it just won't
text anyone.

## API

| Method | Route | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | — | Health check |
| GET | `/c/:slug` | — | Public chat page for a shop |
| POST | `/api/chat` | — | `{slug, sessionId, message}` → `{reply, intent, leadId}` |
| GET | `/api/pack/:slug` | — | Branding + greeting for the chat page |
| POST | `/api/business` | admin | Create or update a shop from a pack |
| GET | `/api/businesses` | admin | List shops with lead counts |
| GET | `/api/leads/:slug` | admin | Booking requests for one shop |
| GET | `/api/pack-template/:name` | admin | Load a starter pack from `/packs` |
| POST | `/api/test-sms` | admin | `{to}` → sends a test text, to verify Twilio |

Admin auth: send the `x-admin-key` header matching `ADMIN_KEY` in `.env`.

---

## Environment

Copy `.env.example` to `.env`:

```
PORT=3000
DATABASE_URL="file:./dev.db"
ADMIN_KEY="a-long-random-string"
```

Generate a strong key:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

---

## Known limits (worth knowing before you sell this)

- **Sessions live in memory.** Restart the server mid-conversation and a
  customer's half-finished booking is lost. Move to Redis or a DB table before
  running more than one instance.
- **No real calendar.** The bot captures a *request*, not a confirmed slot. The
  shop still has to text back.
- **SQLite is single-machine.** Fine for the first handful of shops. Move to
  Postgres before you're running this for real clients on a hosted box.
- **Rate limits are per-process.** 20 chat messages and 30 admin requests per
  IP per minute, held in memory. Fine for one instance; needs Redis if you
  ever scale out.

## Roadmap

1. Per-client login so owners see their own leads
2. Real calendar availability
3. AI fallback for questions the pack doesn't cover
