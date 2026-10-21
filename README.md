# Crypto Sentinel

An **educational paper-trading monitor** for Bybit USDT spot pairs. It watches the coins you choose (BTC, ETH, SOL, XRP and BNB by default; add or remove any listed coin from the website), evaluates transparent technical rules on **closed 1-hour candles with 4-hour trend confirmation**, simulates entries and exits, tracks hypothetical P/L after estimated fees, and **emails you** when BUY or SELL conditions are met.

> **It never places real orders.** It has no exchange credentials, only reads Bybit's *public* market data, and has no code path that trades. Signals are rule matches, not predictions or advice. Simulated results ignore slippage and do not guarantee anything.

---

## How the workflow works

| # | What happens | Where |
|---|---|---|
| 1 | A scheduler calls `GET /api/cron/monitor` (with your `CRON_SECRET`). Each call checks **every enabled coin once** and ends. Nothing runs in your browser and nothing loops inside the serverless function. | `src/lib/monitor.ts` |
| 2 | Per coin: fetch 1h + 4h klines and the ticker from Bybit, drop the still-forming candle, validate, compute EMA20/50, RSI14, MACD(12,26,9), ATR14. | `bybit.ts`, `indicators.ts`, `rules.ts` |
| 3 | **BUY conditions** (all must hold): 1h EMA20 > EMA50 · 4h EMA20 > EMA50 · 1h RSI between 50 and 65 · 1h MACD histogram > 0 · enough contiguous, non-stale candles. Any data problem ⇒ *no signal*, never a guess. | `rules.ts` |
| 4 | If met, no position is open for that coin, the candle closed ≤ 30 min ago and the simulated balance allows it ⇒ a **paper position** is opened (10 USDT by default) and a **BUY email** is queued. | `monitor.ts` |
| 5 | While a position is open it keeps being monitored every run. **SELL conditions:** price ≤ entry −2 % (stop), price ≥ entry +4 % (target), or (optional) 1h EMA trend turns down. The position closes, P/L is computed with estimated fees on both sides, and a **SELL email** is queued. | `rules.ts`, `paper.ts` |
| 6 | No repeat alerts: one open position per coin, one entry per candle, one email per trade (database constraints + idempotent queue). After a close the coin **re-arms only once the BUY conditions have lapsed**, then watches for the next BUY. | `migrations.ts` |
| 7 | You read the email and decide for yourself whether to act anywhere. The app does not wait for approval — it simply records the *simulation* and tells you. | — |

All thresholds, the position size, fee assumption, indicator periods and the recipient are editable on the **Settings** card. Defaults are illustrative, not recommendations.

### Managing coins from the website
**Coins** card → type a ticker (e.g. `DOGE`) → *Add coin*. The server asks Bybit's public instrument list whether `DOGEUSDT` is a trading spot pair and refuses anything else. *Pause* stops new entries (an open position keeps being monitored for its exit). *Remove* is refused while a simulated position is open; history is always kept. Up to 15 coins.

---

## Deploying on Vercel (step by step)

You need: a GitHub account, a Vercel account (free Hobby is fine), a Resend account (free).

### 1. Get the code onto GitHub
Unzip the project, then in the folder:
```bash
git init && git add . && git commit -m "Crypto Sentinel"
# create an EMPTY private repo on github.com, then:
git remote add origin https://github.com/<you>/crypto-sentinel.git
git branch -M main && git push -u origin main
```

### 2. Import into Vercel
vercel.com → **Add New… → Project** → pick the repo → framework is auto-detected as Next.js → **don't deploy yet** (or deploy and redeploy after step 3–4).

`vercel.json` pins the function region to **Frankfurt (`fra1`)**. This matters: **Bybit returns HTTP 403 to US and mainland-China IP addresses**, and Vercel's default region is in the US.

### 3. Add a Postgres database
In the project: **Storage → Create Database → Neon (Postgres)** → connect it to the project (all environments). Vercel injects `DATABASE_URL` automatically — you type nothing. *(Menu labels change; the goal is "a Postgres database whose connection string is exposed as `DATABASE_URL` or `POSTGRES_URL`".)*
Tables are created automatically on the first request (an idempotent, locked migration). You can also run `npm run db:migrate` locally.

### 4. Add three environment variables
Project → **Settings → Environment Variables** (apply to Production):

| Name | Value | Why it is unavoidable |
|---|---|---|
| `ADMIN_PASSWORD` | a password you choose (12+ chars) | Protects the dashboard and every change endpoint. There is **no default** — without it the site refuses to operate. |
| `CRON_SECRET` | 32+ random characters (`openssl rand -hex 32`) | Authorises the scheduler. Without it `/api/cron/monitor` is disabled (503). |
| `RESEND_API_KEY` | from resend.com → API Keys | Authorises sending email. No email service can send without a credential; this keeps it server-side only. |

### 5. Email setup (the one fiddly part)
1. Sign up at **resend.com using `olaleyevictor206@gmail.com`** (the address that should receive alerts).
2. Create an API key → put it in `RESEND_API_KEY`.

Why that exact address: Resend's free test sender (`onboarding@resend.dev`) can **only deliver to the email your Resend account was created with**; any other recipient is rejected with HTTP 403. To send to a different recipient, verify a domain at resend.com/domains and set `EMAIL_FROM="Crypto Sentinel <alerts@yourdomain.com>"`.
*No third-party service (built-in SMTP):* set `SMTP_USER` (your Gmail address) and `SMTP_PASS` (a Gmail **App Password**: Google Account → Security → 2-Step Verification on → App passwords; 16 characters, *not* your normal password). The app then sends through Gmail's own server (`smtp.gmail.com:465`, TLS, certificate always verified). If set it takes priority over Resend/Brevo. Mail you send from your own Gmail to itself normally lands in the inbox, but the receiving mailbox is the only real proof — use **Send test email** and check inbox + spam. SMTP gives "accepted by the mail server", never a "delivered" confirmation. Tested here only against a local fake TLS SMTP server, not against live Gmail.

*Alternative:* Brevo — set `BREVO_API_KEY` and `EMAIL_FROM` to a single sender address you verified there (no domain needed).
Your normal Gmail password or codes are **never** needed or requested.

*Optional delivery confirmation:* in Resend add a webhook to `https://<your-app>/api/webhooks/resend` (events `email.delivered`, `email.bounced`, `email.complained`) and set `RESEND_WEBHOOK_SECRET`. Without it the dashboard shows **"Accepted by provider"**, which means the provider took the message — *not* that it reached the inbox.

### 6. Deploy, then sign in
**Deploy** (or Redeploy after adding variables). Open the site, sign in with `ADMIN_PASSWORD`. The **System health** card lists any step still open.

### 7. Scheduling — pick one
The monitor only runs when something calls it.

| Option | Frequency | Cost | Setup |
|---|---|---|---|
| **Vercel Hobby cron** (already in `vercel.json`) | **once per day** (and Vercel may fire it anywhere inside that hour) | free | automatic — **too slow on its own** |
| **External scheduler** e.g. cron-job.org | 1–5 min (check the provider's current free limits) | free | create a job: URL `https://<app>/api/cron/monitor`, method GET, header `Authorization: Bearer <CRON_SECRET>` |
| **GitHub Actions** (`.github/workflows/monitor.yml`) | ~5 min, best-effort, can be delayed | free | add repo secrets `APP_URL` and `CRON_SECRET` |
| **Vercel Pro cron** | every minute | paid plan | change the schedule in `vercel.json` to `* * * * *` |

Hourly signals only need a check every few minutes; faster calls mainly make stop/target exits react sooner. The dashboard measures the cadence it *actually* sees and turns red if runs stop — it never assumes one-minute monitoring.

### 8. Verify (in this order)
1. **Market data:** open the site → the *Market* card shows live prices, charts and a green **Live Bybit data** pill. A red notice with HTTP 403 means a US region/IP — keep `fra1`.
2. **Monitor:** press **Run check now** (header). *System health → Recent monitor runs* gets a `manual / success` row; each coin card shows "Checked just now".
3. **Scheduler:** wait for the next scheduled time; a `cron / success` row appears. The header badge says **Monitor running**.
4. **Email:** **Email notifications → Send test email**. Expect "accepted by provider", then check the inbox **and spam**.
5. Optionally sanity-check the endpoint: `curl -i -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/monitor` → `200` (without the header → `401`).

### Troubleshooting
| Symptom | Likely cause / fix |
|---|---|
| "Setup required" screen | `ADMIN_PASSWORD` missing → add it and redeploy. |
| "No database is connected" | Connect the Neon database to *this* project and redeploy. |
| Market card: HTTP 403 / "geo-restricted" | Function region in the US. Keep `"regions": ["fra1"]` in `vercel.json`, or set `BYBIT_BASE_URL`. |
| Header says **Not started / stopped** | No scheduler is calling the endpoint, or `CRON_SECRET` differs between Vercel and the scheduler. |
| Test email fails with a 403 hint | Resend account email ≠ recipient (see step 5). |
| Email status stays **Accepted** | Normal without the webhook; confirm in the inbox. |
| Alerts older than 24 h are not sent | By design — a stale BUY/SELL would mislead. |
| Deploy fails at build | Open the build log; this project was not compiled with `next build` before delivery (see below). |

---

## Security notes
* Every dashboard and change endpoint needs a signed, HttpOnly, SameSite=Strict session cookie; changes also require a same-origin request. Login is rate-limited (8 tries / 5 min / address) and fails closed if the database is down.
* Secrets live only in server environment variables; they are never sent to the browser, stored in the database, or logged (log lines are redacted; `/api/state` exposes booleans only).
* All SQL is parameterised. Inputs are validated server-side. Security headers + a strict CSP are set in `next.config.mjs`; the API sends `Cache-Control: no-store`.
* The only outbound calls are Bybit's public API (`api.bybit.com`, official alternate `api.bytick.com`) and your email provider.

## Reliability design
Lease lock in Postgres (no overlapping runs) · retries with exponential backoff · per-coin failure isolation · stale/missing/invalid data ⇒ no signal · unique indexes prevent duplicate positions, entries and emails · email queue with backoff and a 24 h expiry · every run recorded in `job_runs` · `GET /api/health` public liveness probe.

---

## Development
```bash
npm install
cp .env.example .env.local     # fill in DATABASE_URL, ADMIN_PASSWORD, CRON_SECRET, …
npm run dev
npm test                       # see below
```
**Tests:** `npm test` runs the whole suite (indicators, rules, Bybit client, paper math, the full BUY → SELL → re-arm → BUY → SELL cycle across five coins, persistence, locking, email provider failures/retries, webhook signatures, auth, protected endpoints, coin management, dashboard rendering). Set `TEST_PSQL_URL=postgres://…` to run against a real Postgres (each test file gets its own schema); without it the tests use PGlite (in-process Postgres, installed as a dev dependency).

## Project layout
```
src/lib        indicators, rules, paper math, Bybit client, email, monitor, store, auth, health, migrations
src/app/api    cron/monitor, state, market, assets, settings, email/test, admin/run, auth/*, health, webhooks/resend
src/components dashboard UI (Coins, Signal, Portfolio, EmailPanel, SettingsPanel, Health, Chart, …)
tests          node:test suites + helpers (mock exchange, mock email provider, DB harness)
```

## Known limits (honest list)
* Paper results use reference prices and an assumed fee; no slippage, no partial fills, no spread.
* Exit prices come from the ticker at each run, so a stop/target is evaluated once per scheduler tick, not tick-by-tick.
* Bybit is the only data source; if it is unreachable the app reports that and does nothing.
* "Delivered" is only shown when the provider confirms it by webhook (Resend).
* Charts use `lightweight-charts` v5 in the browser; they were not exercised in a real browser before delivery.

<!-- redeploy trigger: database connected -->
