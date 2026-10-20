import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Db, Queryable, Row } from "./db";
import { logger } from "./logger";
import { baseOf, fmtPrice, pairLabel } from "./format";
import { fmtUtc } from "./time";
import { sendSmtp, type SmtpOptions } from "./smtp";
import type { Settings, TimeframeSnapshot } from "./types";

/**
 * Email alerts. Credentials are read from server-side environment variables only; they are never sent to the
 * browser, stored in the database, or logged. Three senders are supported:
 *   • SMTP    (SMTP_USER + SMTP_PASS, built in, no third-party service) – e.g. your own Gmail with an App Password
 *             (never your normal password). Takes priority when configured.
 *   • Resend  (RESEND_API_KEY)  – free test sender works if the Resend account email == the recipient.
 *   • Brevo   (BREVO_API_KEY + EMAIL_FROM) – single verified sender address, no domain needed.
 *
 * Delivery states are reported honestly:
 *   queued    – stored, not yet handed to the provider
 *   sending   – a worker has claimed it
 *   accepted  – the PROVIDER accepted the message (this is NOT proof it reached the inbox)
 *   delivered – the provider CONFIRMED delivery via signed webhook (Resend + RESEND_WEBHOOK_SECRET only)
 *   bounced   – provider reported bounce/complaint
 *   failed    – could not be sent (see last_error); may be retried automatically
 *   skipped   – disabled in settings
 */

type Env = Record<string, string | undefined>;
export type ProviderName = "smtp" | "resend" | "brevo";

export interface EmailConfig {
  provider: ProviderName | null;
  configured: boolean;
  from: string;
  issue: string | null;
  webhookConfigured: boolean;
}

export const MAX_ATTEMPTS = 5;
const STALE_ALERT_MS = 24 * 3600_000;

export function emailConfig(env: Env = process.env): EmailConfig {
  const webhookConfigured = !!env.RESEND_WEBHOOK_SECRET;
  if (env.SMTP_USER || env.SMTP_PASS) {
    if (!env.SMTP_USER || !env.SMTP_PASS) {
      return { provider: "smtp", configured: false, from: "", issue: "SMTP needs both SMTP_USER and SMTP_PASS (for Gmail, an App Password).", webhookConfigured: false };
    }
    const from = env.EMAIL_FROM && parseFrom(env.EMAIL_FROM) ? env.EMAIL_FROM : `Crypto Sentinel <${env.SMTP_USER}>`;
    if (!parseFrom(from)) return { provider: "smtp", configured: false, from: "", issue: "SMTP_USER must be an email address (or set EMAIL_FROM).", webhookConfigured: false };
    return { provider: "smtp", configured: true, from, issue: null, webhookConfigured: false };
  }
  if (env.RESEND_API_KEY) {
    return { provider: "resend", configured: true, from: env.EMAIL_FROM || "Crypto Sentinel <onboarding@resend.dev>", issue: null, webhookConfigured };
  }
  if (env.BREVO_API_KEY) {
    if (!env.EMAIL_FROM || !parseFrom(env.EMAIL_FROM)) {
      return { provider: "brevo", configured: false, from: "", issue: "Brevo requires EMAIL_FROM to be set to your verified sender, e.g. Crypto Sentinel <you@example.com>.", webhookConfigured: false };
    }
    return { provider: "brevo", configured: true, from: env.EMAIL_FROM, issue: null, webhookConfigured: false };
  }
  return { provider: null, configured: false, from: "", issue: "No email provider key is set (SMTP_USER + SMTP_PASS, RESEND_API_KEY or BREVO_API_KEY).", webhookConfigured: false };
}

export function parseFrom(from: string): { name: string; email: string } | null {
  const m = from.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>\s*$/) ?? from.match(/^\s*()([^<>\s]+@[^<>\s]+)\s*$/);
  return m ? { name: (m[1] || "Crypto Sentinel").trim(), email: m[2].trim() } : null;
}

// ── Message content ──────────────────────────────────────────────────────────
export interface TradeEmailData {
  symbol: string;
  type: "BUY" | "SELL";
  price: number;
  at: number;
  reason: string;
  h1: TimeframeSnapshot | null;
  h4: TimeframeSnapshot | null;
  amountUsdt: number;
  quantity: number;
  entryPrice: number;
  exitPrice?: number;
  grossPnl?: number;
  entryFee?: number;
  exitFee?: number;
  netPnl?: number;
  feeRatePct: number;
}

export interface EmailMessage {
  subject: string;
  text: string;
  html: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const usd = (n: number, dp = 2) => n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const px = (n: number) => fmtPrice(n);
const signed = (n: number, dp = 4) => `${n >= 0 ? "+" : "−"}${usd(Math.abs(n), dp)}`;
const v = (n: number | null | undefined, dp = 2) => (n === null || n === undefined ? "n/a" : usd(n, dp));
const vp = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : px(n));
const vs = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : String(Number(n.toPrecision(4))));

export const NO_REAL_TRADE_NOTICE =
  "NO REAL TRADE WAS EXECUTED. Crypto Sentinel is an educational paper-trading simulator. It never places orders on any exchange, " +
  "figures are hypothetical (reference prices, estimated fees, no slippage) and do not guarantee or predict future results. This is not financial advice.";

export function buildTradeEmail(d: TradeEmailData): EmailMessage {
  const pair = pairLabel(d.symbol);
  const base = baseOf(d.symbol);
  const rows: Array<[string, string]> = [
    ["Event", `PAPER ${d.type} (simulated)`],
    ["Pair", `${pair} Spot`],
    ["Reference price", `${px(d.price)} USDT`],
    ["Time (UTC)", fmtUtc(d.at)],
    ["Reason", d.reason],
    ["Simulated trade amount", `${usd(d.amountUsdt)} USDT`],
    [`Simulated ${base} quantity`, `${d.quantity.toFixed(8)} ${base}`],
    ["Entry price", `${px(d.entryPrice)} USDT`],
  ];
  if (d.type === "SELL") {
    rows.push(["Exit price", `${px(d.exitPrice ?? d.price)} USDT`]);
    rows.push(["Hypothetical gross P/L", `${signed(d.grossPnl ?? 0)} USDT`]);
    rows.push(["Estimated fees", `${usd((d.entryFee ?? 0) + (d.exitFee ?? 0), 4)} USDT (entry ${usd(d.entryFee ?? 0, 4)} + exit ${usd(d.exitFee ?? 0, 4)} at ${d.feeRatePct}% per side)`]);
    rows.push(["Hypothetical NET P/L", `${signed(d.netPnl ?? 0)} USDT`]);
  } else {
    rows.push(["Estimated entry fee", `${usd((d.amountUsdt * d.feeRatePct) / 100, 4)} USDT (${d.feeRatePct}% per side; realised at close)`]);
  }
  const ind: Array<[string, string]> = [];
  if (d.h1) {
    ind.push(["1h EMA fast / slow", `${vp(d.h1.emaFast)} / ${vp(d.h1.emaSlow)}`]);
    ind.push(["1h RSI", v(d.h1.rsi)]);
    ind.push(["1h MACD / signal / hist", `${vs(d.h1.macd)} / ${vs(d.h1.macdSignal)} / ${vs(d.h1.macdHist)}`]);
    ind.push(["1h ATR", vp(d.h1.atr)]);
  }
  if (d.h4) ind.push(["4h EMA fast / slow", `${vp(d.h4.emaFast)} / ${vp(d.h4.emaSlow)}`]);

  const subject =
    d.type === "BUY"
      ? `[Crypto Sentinel] BUY signal · ${pair} @ ${px(d.price)} (paper)`
      : `[Crypto Sentinel] SELL signal · ${pair} @ ${px(d.price)} · net ${signed(d.netPnl ?? 0, 2)} USDT (paper)`;

  const guidance =
    d.type === "BUY"
      ? `The predefined BUY conditions were met for ${pair}. Review the chart and decide for yourself whether to act — nothing is done automatically. A PAPER position was opened so the simulation can track entry, exit, fees and P/L.`
      : `The predefined SELL condition was met for ${pair}, so the simulated position was closed. Review it and decide for yourself whether to act on any real holding.`;

  const text = [
    `CRYPTO SENTINEL — PAPER ${d.type} · ${pair}`,
    "",
    guidance,
    "",
    ...rows.map(([k, val]) => `${k}: ${val}`),
    "",
    "Indicator values (closed candles):",
    ...ind.map(([k, val]) => `  ${k}: ${val}`),
    "",
    NO_REAL_TRADE_NOTICE,
  ].join("\n");

  const accent = d.type === "BUY" ? "#2ebd85" : d.netPnl !== undefined && d.netPnl < 0 ? "#f6465d" : "#7aa2ff";
  const tr = (k: string, val: string) =>
    `<tr><td style="padding:6px 12px 6px 0;color:#6b7694;font-size:13px;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0;color:#0b1020;font-size:14px;font-weight:500">${esc(val)}</td></tr>`;
  const html = `<!doctype html><html><body style="margin:0;background:#f3f5fa;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
  <div style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e7f3">
    <div style="background:#0a0f1e;padding:16px 20px"><span style="color:#7aa2ff;font-weight:700">◆</span> <span style="color:#e7ebf7;font-weight:600;letter-spacing:.3px">Crypto Sentinel</span> <span style="color:#7482a6;font-size:12px">· educational paper trading</span></div>
    <div style="padding:20px">
      <div style="display:inline-block;padding:4px 10px;border-radius:999px;background:${accent};color:#fff;font-size:12px;font-weight:700;letter-spacing:.5px">${esc(pair)} · ${d.type} SIGNAL · PAPER</div>
      <p style="margin:14px 0 0;color:#26304d;font-size:14px;line-height:1.5">${esc(guidance)}</p>
      <table role="presentation" style="margin-top:10px;border-collapse:collapse;width:100%">${rows.map(([k, val]) => tr(k, val)).join("")}</table>
      <h3 style="margin:18px 0 6px;font-size:13px;color:#6b7694;text-transform:uppercase;letter-spacing:.6px">Indicators (closed candles)</h3>
      <table role="presentation" style="border-collapse:collapse;width:100%">${ind.map(([k, val]) => tr(k, val)).join("")}</table>
      <p style="margin:20px 0 0;padding:12px;border-radius:8px;background:#fff7e6;border:1px solid #ffe2a8;color:#7a5200;font-size:13px;line-height:1.5"><strong>No real trade was executed.</strong> ${esc(NO_REAL_TRADE_NOTICE.replace("NO REAL TRADE WAS EXECUTED. ", ""))}</p>
    </div>
  </div>
</div></body></html>`;
  return { subject, text, html };
}

export function buildTestEmail(now: number): EmailMessage {
  const text = `Crypto Sentinel test email\n\nSent at ${fmtUtc(now)}.\nIf you can read this, your email provider accepted the message and routing to this address works.\n\nThis is only a test. No trade of any kind was executed.`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px"><h2 style="margin:0 0 8px">◆ Crypto Sentinel — test email</h2><p style="color:#444;line-height:1.5">Sent at ${esc(fmtUtc(now))}.<br>If you can read this, your email provider accepted the message and routing to this address works.</p><p style="color:#7a5200;background:#fff7e6;border:1px solid #ffe2a8;padding:10px;border-radius:8px;font-size:13px">This is only a test. No trade of any kind was executed.</p></div>`;
  return { subject: "[Crypto Sentinel] Test email", text, html };
}

// ── Providers ────────────────────────────────────────────────────────────────
export type SendResult = { ok: true; messageId: string } | { ok: false; retryable: boolean; error: string };

export interface EmailDeps {
  fetchFn?: typeof fetch;
  env?: Env;
  now?: () => number;
  smtp?: SmtpOptions;
}

function safeProviderError(status: number, bodyText: string, provider: ProviderName): string {
  let msg = "";
  try {
    const j = JSON.parse(bodyText) as { message?: string; error?: string; code?: string };
    msg = String(j.message ?? j.error ?? j.code ?? "");
  } catch {
    msg = "";
  }
  msg = msg.replace(/(re_|xkeysib-)[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 200);
  let hint = "";
  if (provider === "resend" && (status === 403 || /only send testing emails|verify a domain/i.test(msg))) {
    hint = " Hint: Resend's free test sender can only email the address your Resend account was created with. Sign up to Resend using the recipient address, or verify a domain and set EMAIL_FROM.";
  } else if (status === 401) {
    hint = " Hint: the API key looks invalid or revoked.";
  } else if (provider === "brevo" && (status === 400 || status === 403)) {
    hint = " Hint: make sure EMAIL_FROM is a sender you verified in Brevo.";
  }
  return `${provider} HTTP ${status}${msg ? `: ${msg}` : ""}.${hint}`.trim();
}

export async function sendViaProvider(
  cfg: EmailConfig,
  msg: EmailMessage,
  to: string,
  idempotencyKey: string,
  deps: EmailDeps = {},
): Promise<SendResult> {
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetchFn ?? fetch;
  try {
    if (cfg.provider === "smtp") {
      const sender = parseFrom(cfg.from);
      if (!sender) return { ok: false, retryable: false, error: "smtp: EMAIL_FROM is not a valid sender" };
      const port = Number(env.SMTP_PORT) || 465;
      const r = await sendSmtp(
        { host: env.SMTP_HOST || "smtp.gmail.com", port, user: env.SMTP_USER ?? "", pass: env.SMTP_PASS ?? "" },
        { fromName: sender.name, fromEmail: sender.email, to, subject: msg.subject, text: msg.text, html: msg.html },
        deps.smtp,
      );
      if (r.ok) return { ok: true, messageId: `smtp-${r.messageId}` };
      return { ok: false, retryable: r.retryable, error: r.error.replace(env.SMTP_PASS ?? "\u0000", "[redacted]") };
    }
    if (cfg.provider === "resend") {
      const res = await fetchFn("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey.slice(0, 256),
        },
        body: JSON.stringify({ from: cfg.from, to: [to], subject: msg.subject, html: msg.html, text: msg.text }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.text();
      if (res.ok) {
        const id = (JSON.parse(body) as { id?: string }).id;
        if (!id) return { ok: false, retryable: true, error: "resend: accepted response had no message id" };
        return { ok: true, messageId: id };
      }
      return { ok: false, retryable: res.status === 429 || res.status >= 500, error: safeProviderError(res.status, body, "resend") };
    }
    if (cfg.provider === "brevo") {
      const sender = parseFrom(cfg.from);
      if (!sender) return { ok: false, retryable: false, error: "brevo: EMAIL_FROM is not a valid sender" };
      const res = await fetchFn("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": env.BREVO_API_KEY ?? "", "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ sender, to: [{ email: to }], subject: msg.subject, htmlContent: msg.html, textContent: msg.text }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.text();
      if (res.ok) {
        const id = (JSON.parse(body) as { messageId?: string }).messageId;
        return { ok: true, messageId: id ?? `brevo-${randomUUID()}` };
      }
      return { ok: false, retryable: res.status === 429 || res.status >= 500, error: safeProviderError(res.status, body, "brevo") };
    }
    return { ok: false, retryable: false, error: cfg.issue ?? "No email provider configured." };
  } catch (e) {
    const name = (e as { name?: string })?.name;
    return { ok: false, retryable: true, error: name === "TimeoutError" || name === "AbortError" ? "Email provider timed out." : "Network error contacting the email provider." };
  }
}

// ── Queue ────────────────────────────────────────────────────────────────────
/** Inserts a notification row INSIDE the caller's transaction. A repeated dedupe_key is a no-op (no duplicate email). */
export async function queueTradeEmail(
  q: Queryable,
  p: { tradeId: number; kind: "BUY" | "SELL"; settings: Settings; message: EmailMessage },
): Promise<{ queued: boolean; skipped: boolean }> {
  const enabled = p.kind === "BUY" ? p.settings.buyEmailEnabled : p.settings.sellEmailEnabled;
  const r = await q.query<Row>(
    `insert into email_notifications (dedupe_key, kind, trade_id, recipient, subject, text_body, html_body, status, last_error)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (dedupe_key) do nothing
     returning id`,
    [
      `trade:${p.tradeId}`,
      p.kind,
      p.tradeId,
      p.settings.emailRecipient,
      p.message.subject,
      p.message.text,
      p.message.html,
      enabled ? "queued" : "skipped",
      enabled ? null : `${p.kind} email alerts are turned off in settings`,
    ],
  );
  return { queued: r.rows.length > 0 && enabled, skipped: r.rows.length > 0 && !enabled };
}

export type AttemptOutcome = "accepted" | "failed_retryable" | "failed_permanent" | "not_configured" | "claimed_elsewhere" | "expired";

/** Claims one notification (atomically) and tries to send it. Safe to call concurrently: only one caller wins the claim. */
export async function attemptSend(db: Db, id: number, deps: EmailDeps = {}): Promise<AttemptOutcome> {
  const env = deps.env ?? process.env;
  const now = (deps.now ?? Date.now)();
  const cfg = emailConfig(env);
  if (!cfg.configured) {
    await db.query("update email_notifications set last_error = $2, updated_at = now() where id = $1 and status in ('queued','failed')", [id, "EMAIL_PROVIDER_NOT_CONFIGURED: " + (cfg.issue ?? "")]);
    return "not_configured";
  }
  const claim = await db.query<Row>(
    `update email_notifications
        set status = 'sending', attempts = attempts + 1, updated_at = now()
      where id = $1
        and ((status = 'queued' and next_attempt_at <= now())
          or (status = 'failed' and attempts < $2 and next_attempt_at <= now())
          or (status = 'sending' and updated_at < now() - interval '5 minutes'))
      returning *`,
    [id, MAX_ATTEMPTS],
  );
  const row = claim.rows[0];
  if (!row) return "claimed_elsewhere";

  const createdAt = new Date(row.created_at).getTime();
  if (row.kind !== "TEST" && now - createdAt > STALE_ALERT_MS) {
    await db.query("update email_notifications set status = 'failed', attempts = $2, last_error = $3, updated_at = now() where id = $1", [id, MAX_ATTEMPTS, "Expired: alert was older than 24h when it could be sent, so it was not sent."]);
    return "expired";
  }

  const result = await sendViaProvider(cfg, { subject: row.subject, text: row.text_body, html: row.html_body }, row.recipient, String(row.dedupe_key), deps);
  if (result.ok) {
    await db.query(
      "update email_notifications set status = 'accepted', provider = $2, provider_message_id = $3, accepted_at = now(), last_error = null, updated_at = now() where id = $1",
      [id, cfg.provider, result.messageId],
    );
    logger.info("email.accepted", { notificationId: id, provider: cfg.provider });
    return "accepted";
  }
  const attempts = Number(row.attempts);
  if (result.retryable && attempts < MAX_ATTEMPTS) {
    const delayMin = 2 ** attempts; // 2, 4, 8, 16 minutes
    await db.query(
      "update email_notifications set status = 'failed', last_error = $2, next_attempt_at = now() + ($3::int * interval '1 minute'), updated_at = now() where id = $1",
      [id, result.error, delayMin],
    );
    logger.warn("email.retry_scheduled", { notificationId: id, attempts, error: result.error });
    return "failed_retryable";
  }
  await db.query("update email_notifications set status = 'failed', attempts = $2, last_error = $3, updated_at = now() where id = $1", [id, MAX_ATTEMPTS, result.error]);
  logger.error("email.failed_permanently", { notificationId: id, error: result.error });
  return "failed_permanent";
}

/**
 * Sends due notifications. The cap (25) is above the 15-coin maximum so a burst of simultaneous signals is
 * mailed in the same run, and `budgetMs` stops starting new sends well before Vercel's 60 s function limit;
 * anything left over stays queued and is picked up by the next run.
 */
export async function processEmailQueue(db: Db, deps: EmailDeps = {}, limit = 25, budgetMs = 30_000): Promise<{ attempted: number; accepted: number; failed: number }> {
  const startedAt = Date.now();
  const due = await db.query<Row>(
    `select id from email_notifications
      where (status = 'queued' and next_attempt_at <= now())
         or (status = 'failed' and attempts < $2 and next_attempt_at <= now())
         or (status = 'sending' and updated_at < now() - interval '5 minutes')
      order by id limit $1`,
    [limit, MAX_ATTEMPTS],
  );
  let accepted = 0;
  let failed = 0;
  let attempted = 0;
  for (const r of due.rows) {
    if (Date.now() - startedAt > budgetMs) break;
    const out = await attemptSend(db, Number(r.id), deps);
    if (out === "not_configured") break;
    attempted++;
    if (out === "accepted") accepted++;
    else if (out !== "claimed_elsewhere") failed++;
  }
  return { attempted, accepted, failed };
}

/** Sends a test email immediately. Does not retry; reports the true provider state to the caller. */
export async function sendTestEmail(db: Db, recipient: string, deps: EmailDeps = {}): Promise<{ ok: boolean; status: string; message: string; notificationId?: number }> {
  const env = deps.env ?? process.env;
  const cfg = emailConfig(env);
  if (!cfg.configured) {
    return { ok: false, status: "not_configured", message: cfg.issue ?? "Email provider is not configured." };
  }
  const now = (deps.now ?? Date.now)();
  const msg = buildTestEmail(now);
  const ins = await db.query<Row>(
    `insert into email_notifications (dedupe_key, kind, recipient, subject, text_body, html_body, status)
     values ($1, 'TEST', $2, $3, $4, $5, 'queued') returning id`,
    [`test:${randomUUID()}`, recipient, msg.subject, msg.text, msg.html],
  );
  const id = Number(ins.rows[0].id);
  const out = await attemptSend(db, id, deps);
  const row = (await db.query<Row>("select status, last_error from email_notifications where id = $1", [id])).rows[0];
  if (out === "accepted") {
    return {
      ok: true,
      status: "accepted",
      notificationId: id,
      message: `The ${cfg.provider} provider accepted the test email for ${recipient}. "Accepted" means the provider took responsibility for sending it; check the inbox (and spam folder) to confirm arrival.`,
    };
  }
  return { ok: false, status: String(row?.status ?? "failed"), notificationId: id, message: String(row?.last_error ?? "Test email failed.") };
}

// ── Resend webhook (optional; enables "delivered"/"bounced") ─────────────────
export function verifySvixSignature(p: { secret: string; id: string | null; timestamp: string | null; signature: string | null; body: string; now?: number }): boolean {
  if (!p.id || !p.timestamp || !p.signature || !p.secret) return false;
  const ts = Number(p.timestamp);
  const now = p.now ?? Date.now();
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) return false;
  const keyB64 = p.secret.startsWith("whsec_") ? p.secret.slice(6) : p.secret;
  let key: Buffer;
  try {
    key = Buffer.from(keyB64, "base64");
  } catch {
    return false;
  }
  const expected = createHmac("sha256", key).update(`${p.id}.${p.timestamp}.${p.body}`).digest();
  for (const part of p.signature.split(" ")) {
    const [ver, sig] = part.split(",");
    if (ver !== "v1" || !sig) continue;
    let got: Buffer;
    try {
      got = Buffer.from(sig, "base64");
    } catch {
      continue;
    }
    if (got.length === expected.length && timingSafeEqual(got, expected)) return true;
  }
  return false;
}

export async function applyDeliveryEvent(db: Db, type: string, messageId: string): Promise<boolean> {
  if (type === "email.delivered") {
    const r = await db.query("update email_notifications set status = 'delivered', delivered_at = now(), updated_at = now() where provider_message_id = $1 and status in ('accepted','sending') returning id", [messageId]);
    return r.rowCount > 0;
  }
  if (type === "email.bounced" || type === "email.complained") {
    const r = await db.query("update email_notifications set status = 'bounced', last_error = $2, updated_at = now() where provider_message_id = $1 returning id", [messageId, type === "email.bounced" ? "Provider reported a bounce." : "Recipient marked the message as spam."]);
    return r.rowCount > 0;
  }
  return false;
}
