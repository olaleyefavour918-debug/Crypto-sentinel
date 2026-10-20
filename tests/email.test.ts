import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Db, Row } from "@/lib/db";
import {
  applyDeliveryEvent, attemptSend, buildTradeEmail, emailConfig, MAX_ATTEMPTS, processEmailQueue, sendTestEmail, sendViaProvider, verifySvixSignature,
} from "@/lib/email";
import { emailFetch, NOW, RESEND_ENV, type EmailCall } from "./helpers/fixtures";
import { makeTestDb, type TestDb } from "./helpers/db";

const KEY = RESEND_ENV.RESEND_API_KEY;
const TO = "olaleyevictor206@gmail.com";
let t: TestDb;
let db: Db;
let seq = 0;

before(async () => { t = await makeTestDb(); db = t.db; });
after(async () => { await t.cleanup(); });

async function queued(kind = "BUY", ageMs = 0): Promise<number> {
  const r = await db.query<Row>(
    "insert into email_notifications (dedupe_key, kind, recipient, subject, text_body, html_body, status, created_at) values ($1, $2, $3, 'subj', 'text', '<p>html</p>', 'queued', now() - ($4::int * interval '1 millisecond')) returning id",
    [`unit:${++seq}`, kind, TO, ageMs],
  );
  return Number(r.rows[0].id);
}
const row = async (id: number) => (await db.query<Row>("select * from email_notifications where id = $1", [id])).rows[0];
const makeDue = (id: number) => db.query("update email_notifications set next_attempt_at = now() - interval '1 second' where id = $1", [id]);
const ok = (id = "msg_1") => ({ status: 200, body: { id } });

describe("email configuration", () => {
  it("Resend works with just an API key and defaults to the free test sender", () => {
    const c = emailConfig({ RESEND_API_KEY: KEY });
    assert.equal(c.configured, true);
    assert.equal(c.provider, "resend");
    assert.match(c.from, /onboarding@resend\.dev/);
    assert.equal(c.webhookConfigured, false);
  });
  it("Brevo needs a verified sender; no provider key means not configured, with an explanation", () => {
    assert.equal(emailConfig({ BREVO_API_KEY: "k" }).configured, false);
    assert.equal(emailConfig({ BREVO_API_KEY: "k", EMAIL_FROM: "Me <me@example.com>" }).configured, true);
    const none = emailConfig({});
    assert.equal(none.configured, false);
    assert.match(none.issue ?? "", /RESEND_API_KEY|BREVO_API_KEY/);
  });
});

describe("provider requests and failures", () => {
  const msg = { subject: "S", text: "T", html: "<p>H</p>" };
  const cfg = emailConfig({ RESEND_API_KEY: KEY });

  it("Resend: correct endpoint, auth header, idempotency key and recipient", async () => {
    const calls: EmailCall[] = [];
    const r = await sendViaProvider(cfg, msg, TO, "trade:42", { env: { RESEND_API_KEY: KEY }, fetchFn: emailFetch([ok("abc")], calls) });
    assert.deepEqual(r, { ok: true, messageId: "abc" });
    assert.equal(calls[0].url, "https://api.resend.com/emails");
    assert.equal(calls[0].headers.authorization, `Bearer ${KEY}`);
    assert.equal(calls[0].headers["idempotency-key"], "trade:42");
    assert.deepEqual(calls[0].body.to, [TO]);
  });

  it("Brevo: correct endpoint, api-key header, sender and recipient", async () => {
    const env = { BREVO_API_KEY: "brevo-secret-key", EMAIL_FROM: "Crypto Sentinel <me@example.com>" };
    const calls: EmailCall[] = [];
    const r = await sendViaProvider(emailConfig(env), msg, TO, "k", { env, fetchFn: emailFetch([{ status: 201, body: { messageId: "<b1@brevo>" } }], calls) });
    assert.deepEqual(r, { ok: true, messageId: "<b1@brevo>" });
    assert.equal(calls[0].url, "https://api.brevo.com/v3/smtp/email");
    assert.equal(calls[0].headers["api-key"], "brevo-secret-key");
    assert.deepEqual(calls[0].body.sender, { name: "Crypto Sentinel", email: "me@example.com" });
    assert.deepEqual(calls[0].body.to, [{ email: TO }]);
  });

  it("classifies failures: 403/401 permanent, 429/5xx/timeout/network retryable; no secret ever appears in the error", async () => {
    const run = (reply: Parameters<typeof emailFetch>[0][number]) => sendViaProvider(cfg, msg, TO, "k", { env: { RESEND_API_KEY: KEY }, fetchFn: emailFetch([reply]) });
    const r403 = await run({ status: 403, body: { message: `You can only send testing emails to your own email address. key=${KEY}` } });
    assert.equal(r403.ok, false);
    if (!r403.ok) { assert.equal(r403.retryable, false); assert.match(r403.error, /Resend account/); assert.ok(!r403.error.includes(KEY)); }
    const r401 = await run({ status: 401, body: { message: "API key is invalid" } });
    if (!r401.ok) { assert.equal(r401.retryable, false); assert.match(r401.error, /API key/); }
    for (const reply of [{ status: 429, body: { message: "slow down" } }, { status: 500, body: {} }, { status: 503, body: {} }] as const) {
      const r = await run(reply);
      assert.equal(r.ok === false && r.retryable, true, `HTTP ${reply.status} should be retryable`);
    }
    const timeout = await run("timeout");
    assert.equal(timeout.ok === false && timeout.retryable, true);
    if (!timeout.ok) assert.match(timeout.error, /timed out/);
    const net = await run("throw");
    assert.equal(net.ok === false && net.retryable, true);
    const noId = await run({ status: 200, body: {} });
    assert.equal(noId.ok, false, "an 'accepted' response without a message id is not trusted");
  });
});

describe("notification queue: retries, claims and expiry", () => {
  it("a transient failure is retried later with backoff, then recorded as accepted (never lost, never duplicated)", async () => {
    const id = await queued();
    const calls: EmailCall[] = [];
    const deps = { env: { RESEND_API_KEY: KEY }, fetchFn: emailFetch([{ status: 500, body: {} }, ok("msg_retry")], calls) };
    assert.equal(await attemptSend(db, id, deps), "failed_retryable");
    let r = await row(id);
    assert.equal(r.status, "failed");
    assert.equal(Number(r.attempts), 1);
    assert.match(r.last_error, /500/);
    assert.ok(new Date(r.next_attempt_at).getTime() > Date.now() + 60_000, "next attempt is scheduled in the future");
    assert.equal((await processEmailQueue(db, deps)).attempted > 0 ? "ran" : "idle", "idle", "not retried before it is due");
    assert.equal(calls.length, 1);
    await makeDue(id);
    await processEmailQueue(db, deps);
    r = await row(id);
    assert.equal(r.status, "accepted");
    assert.equal(r.provider, "resend");
    assert.equal(r.provider_message_id, "msg_retry");
    assert.equal(Number(r.attempts), 2);
    assert.equal(r.last_error, null);
    assert.equal(calls.length, 2);
    await processEmailQueue(db, deps);
    assert.equal(calls.length, 2, "an accepted notification is never sent again");
  });

  it("gives up after the maximum attempts and keeps the sanitized error", async () => {
    const id = await queued();
    const calls: EmailCall[] = [];
    const deps = { env: { RESEND_API_KEY: KEY }, fetchFn: emailFetch([{ status: 500, body: { message: "boom" } }], calls) };
    for (let i = 0; i < MAX_ATTEMPTS; i++) { await makeDue(id); await attemptSend(db, id, deps); }
    const r = await row(id);
    assert.equal(r.status, "failed");
    assert.equal(Number(r.attempts), MAX_ATTEMPTS);
    assert.equal(calls.length, MAX_ATTEMPTS);
    await makeDue(id);
    assert.equal(await attemptSend(db, id, deps), "claimed_elsewhere", "no further attempts once exhausted");
    assert.equal(calls.length, MAX_ATTEMPTS);
  });

  it("a permanent rejection (e.g. 403) is not retried", async () => {
    const id = await queued();
    const calls: EmailCall[] = [];
    const out = await attemptSend(db, id, { env: { RESEND_API_KEY: KEY }, fetchFn: emailFetch([{ status: 403, body: { message: "only send testing emails" } }], calls) });
    assert.equal(out, "failed_permanent");
    assert.equal(calls.length, 1);
    assert.equal((await row(id)).status, "failed");
  });

  it("without a configured provider the alert stays queued (not lost) and sends once configured", async () => {
    const id = await queued();
    assert.equal(await attemptSend(db, id, { env: {}, fetchFn: emailFetch([ok()]) }), "not_configured");
    let r = await row(id);
    assert.equal(r.status, "queued");
    assert.equal(Number(r.attempts), 0);
    assert.match(r.last_error, /NOT_CONFIGURED/);
    assert.equal(await attemptSend(db, id, { env: { RESEND_API_KEY: KEY }, fetchFn: emailFetch([ok("late")]) }), "accepted");
    r = await row(id);
    assert.equal(r.status, "accepted");
  });

  it("two workers racing for the same notification send exactly one email", async () => {
    const id = await queued();
    const calls: EmailCall[] = [];
    const slow = emailFetch([ok("only-once")], calls);
    const deps = { env: { RESEND_API_KEY: KEY }, fetchFn: (async (...a: Parameters<typeof fetch>) => { await new Promise((r) => setTimeout(r, 40)); return slow(...a); }) as typeof fetch };
    const outs = await Promise.all([attemptSend(db, id, deps), attemptSend(db, id, deps), attemptSend(db, id, deps)]);
    assert.equal(calls.length, 1);
    assert.deepEqual(outs.filter((o) => o === "accepted").length, 1);
  });

  it("an alert older than 24 h is not sent (a stale BUY/SELL would mislead), but nothing is silently dropped", async () => {
    const id = await queued("BUY", 25 * 3600_000);
    const calls: EmailCall[] = [];
    assert.equal(await attemptSend(db, id, { env: { RESEND_API_KEY: KEY }, fetchFn: emailFetch([ok()], calls) }), "expired");
    assert.equal(calls.length, 0);
    const r = await row(id);
    assert.equal(r.status, "failed");
    assert.match(r.last_error, /Expired/);
  });
});

describe("test-email feature", () => {
  it("reports 'accepted' honestly (not 'delivered') and records the notification", async () => {
    const calls: EmailCall[] = [];
    const r = await sendTestEmail(db, TO, { env: { RESEND_API_KEY: KEY }, fetchFn: emailFetch([ok("t1")], calls) });
    assert.equal(r.ok, true);
    assert.equal(r.status, "accepted");
    assert.match(r.message, /accepted/i);
    assert.match(r.message, /inbox/i);
    assert.ok(!/delivered/i.test(r.message));
    assert.match(String(calls[0].body.subject), /Test email/);
    assert.equal((await row(r.notificationId!)).kind, "TEST");
  });
  it("surfaces a provider failure with an actionable hint", async () => {
    const r = await sendTestEmail(db, TO, { env: { RESEND_API_KEY: KEY }, fetchFn: emailFetch([{ status: 403, body: { message: "You can only send testing emails to your own email address" } }]) });
    assert.equal(r.ok, false);
    assert.match(r.message, /Resend account|verify a domain/);
  });
  it("says so when no provider is configured, without creating a notification", async () => {
    const before = Number((await db.query<Row>("select count(*) as c from email_notifications")).rows[0].c);
    const r = await sendTestEmail(db, TO, { env: {}, fetchFn: emailFetch([ok()]) });
    assert.equal(r.ok, false);
    assert.equal(r.status, "not_configured");
    assert.equal(Number((await db.query<Row>("select count(*) as c from email_notifications")).rows[0].c), before);
  });
});

describe("provider delivery webhook (optional confirmation)", () => {
  const keyBytes = Buffer.from("super-secret-signing-key-bytes!!");
  const secret = `whsec_${keyBytes.toString("base64")}`;
  const sign = (id: string, ts: string, body: string, k = keyBytes) => `v1,${createHmac("sha256", k).update(`${id}.${ts}.${body}`).digest("base64")}`;
  const ts = String(Math.floor(NOW / 1000));
  const body = JSON.stringify({ type: "email.delivered", data: { email_id: "msg_x" } });
  const base = { secret, id: "msg_evt_1", timestamp: ts, body, now: NOW };

  it("accepts only correctly signed, fresh requests", () => {
    assert.equal(verifySvixSignature({ ...base, signature: sign("msg_evt_1", ts, body) }), true);
    assert.equal(verifySvixSignature({ ...base, signature: `v1,AAAA ${sign("msg_evt_1", ts, body)}` }), true, "one valid signature among several");
    assert.equal(verifySvixSignature({ ...base, signature: sign("msg_evt_1", ts, body + " ") }), false, "tampered body");
    assert.equal(verifySvixSignature({ ...base, signature: sign("msg_evt_1", ts, body, Buffer.from("another-key")) }), false, "wrong key");
    assert.equal(verifySvixSignature({ ...base, signature: sign("msg_evt_1", ts, body), now: NOW + 10 * 60_000 }), false, "replay of an old request");
    assert.equal(verifySvixSignature({ ...base, signature: null }), false);
    assert.equal(verifySvixSignature({ ...base, id: null, signature: sign("msg_evt_1", ts, body) }), false);
  });

  it("only a verified event can move 'accepted' to 'delivered'/'bounced'; unknown ids change nothing", async () => {
    const a = await queued();
    await db.query("update email_notifications set status='accepted', provider='resend', provider_message_id='msg_dlv' where id=$1", [a]);
    assert.equal(await applyDeliveryEvent(db, "email.delivered", "msg_dlv"), true);
    let r = await row(a);
    assert.equal(r.status, "delivered");
    assert.ok(r.delivered_at);
    assert.equal(await applyDeliveryEvent(db, "email.delivered", "no-such-id"), false);
    assert.equal(await applyDeliveryEvent(db, "email.opened", "msg_dlv"), false, "unrelated event types are ignored");
    const b = await queued();
    await db.query("update email_notifications set status='accepted', provider='resend', provider_message_id='msg_bnc' where id=$1", [b]);
    assert.equal(await applyDeliveryEvent(db, "email.bounced", "msg_bnc"), true);
    r = await row(b);
    assert.equal(r.status, "bounced");
    assert.equal(await applyDeliveryEvent(db, "email.delivered", "msg_bnc"), false, "a bounce is never overwritten by 'delivered'");
  });
});

describe("alert content", () => {
  const ind = { candleStart: NOW, close: 61700, emaFast: 61500.5, emaSlow: 60900.25, rsi: 57.3, macd: 120.1, macdSignal: 100.2, macdHist: 19.9, atr: 310.4 };
  const buy = buildTradeEmail({ symbol: "ETHUSDT", type: "BUY", price: 3087.96, at: NOW, reason: "All BUY conditions met", h1: ind, h4: ind, amountUsdt: 10, quantity: 0.00323838, entryPrice: 3087.96, feeRatePct: 0.1 });
  const sell = buildTradeEmail({ symbol: "ETHUSDT", type: "SELL", price: 3211.5, at: NOW, reason: "TAKE_PROFIT: target reached", h1: ind, h4: ind, amountUsdt: 10, quantity: 0.00323838, entryPrice: 3087.96, exitPrice: 3211.5, grossPnl: 0.4, entryFee: 0.01, exitFee: 0.0104, netPnl: 0.3796, feeRatePct: 0.1 });

  it("BUY alert carries everything required", () => {
    for (const must of ["ETH/USDT", "3,087.96", "2026-10-18 15:05:00 UTC", "All BUY conditions met", "10.00 USDT", "0.00323838 ETH", "RSI", "MACD", "ATR", "4h EMA", "No real trade"]) {
      assert.ok(buy.text.toLowerCase().includes(must.toLowerCase()), `BUY text should include “${must}”`);
    }
    assert.match(buy.subject, /BUY signal · ETH\/USDT/);
  });
  it("SELL alert adds exit price, gross, fees and net P/L", () => {
    for (const must of ["Exit price", "3,211.5", "gross", "Estimated fees", "NET P/L", "+0.3796", "TAKE_PROFIT", "no real trade"]) {
      assert.ok(sell.text.toLowerCase().includes(must.toLowerCase()), `SELL text should include “${must}”`);
    }
    assert.match(sell.subject, /SELL signal · ETH\/USDT/);
  });
  it("escapes HTML in the reason so content can never inject markup", () => {
    const m = buildTradeEmail({ symbol: "BTCUSDT", type: "BUY", price: 1, at: NOW, reason: "<script>alert(1)</script>", h1: null, h4: null, amountUsdt: 10, quantity: 1, entryPrice: 1, feeRatePct: 0.1 });
    assert.ok(!m.html.includes("<script>"));
    assert.ok(m.html.includes("&lt;script&gt;"));
  });
});
