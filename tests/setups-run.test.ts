import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { resolveSignal } from "@/lib/directional";
import { ensureSetup } from "@/lib/migrations";
import { processSetups, setupsSummary } from "@/lib/setups-run";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { pushNewSetups } from "@/lib/webpush";
import { signalMarket, NOW } from "./helpers/fixtures";
import { makeTestDb, type TestDb } from "./helpers/db";
import { H1, exitScenario } from "./helpers/setupmarket";

const S = DEFAULT_SETTINGS;

describe("setup engine: persistence, shadow mode and alerts (database)", () => {
  let t: TestDb;
  before(async () => { t = await makeTestDb(); await ensureSetup(t.db); });
  after(async () => { await t.cleanup(); });
  const q = async (sql: string, p?: unknown[]) => (await t.db.query(sql, p)).rows;
  const sc = exitScenario();
  const input = (over: Record<string, unknown> = {}) => ({ symbol: "SOLUSDT", enabled: true, settings: S, h1All: sc.h1Closed, h4All: sc.h4Closed, price: sc.h1Closed[sc.h1Closed.length - 1].close, nowMs: NOW, ...over });

  it("SHADOW MODE (the default): a confirmed exit warning is recorded and shown but nothing is notified", async () => {
    assert.equal(S.setupAlertsEnabled, false);
    const actions = await processSetups(t.db, input());
    assert.ok(actions.some((a) => /Exit warning CONFIRMED \(recorded, no alert\)/.test(a)), actions.join(" | "));
    const rows = await q("select strategy, status, signal_price from setups where status = 'CONFIRMED'");
    assert.deepEqual(rows.map((r) => r.strategy), ["EXIT_WARNING"]);
    assert.equal((await q("select 1 from setup_events where notify")).length, 0);
    assert.equal((await q("select 1 from email_notifications where kind = 'SETUP'")).length, 0);
  });
  it("opens and closes NO paper trade and places no order", async () => {
    assert.equal((await q("select 1 from paper_trades")).length, 0);
    assert.equal((await q("select 1 from paper_positions")).length, 0);
  });
  it("running again on the same data never duplicates the setup or its events", async () => {
    await processSetups(t.db, input({ nowMs: NOW + 5 * 60_000 }));
    assert.equal((await q("select 1 from setups where strategy = 'EXIT_WARNING'")).length, 1);
    assert.equal((await q("select 1 from setup_events where kind = 'CONFIRMED'")).length, 1);
  });
  it("with alerts switched ON, a new confirmed warning queues one email (kind SETUP) and one phone alert, once", async () => {
    await q("delete from setups"); await q("delete from email_notifications");
    await processSetups(t.db, input({ settings: { ...S, setupAlertsEnabled: true } }));
    await processSetups(t.db, input({ settings: { ...S, setupAlertsEnabled: true }, nowMs: NOW + 5 * 60_000 }));
    const mail = await q("select subject, text_body, status from email_notifications where kind = 'SETUP'");
    assert.equal(mail.length, 1);
    assert.equal(mail[0].status, "queued");
    assert.match(String(mail[0].subject), /CONFIRMED EXIT WARNING · Exit warning · SOL\/USDT/);
    for (const needle of ["Signal time (UTC)", "Signal price", "Latest price", "Signal age", "Validity", "CONFIRMED: the required conditions hold on a CLOSED 1H candle", "nothing here is guaranteed", "No real order was placed"]) {
      assert.ok(String(mail[0].text_body).includes(needle), needle);
    }
    const pushed = await pushNewSetups(t.db, { now: () => NOW + 6 * 60_000 });
    assert.equal(pushed.events, 1);
    assert.equal((await pushNewSetups(t.db, { now: () => NOW + 7 * 60_000 })).events, 0, "each event is pushed at most once");
  });
  it("a confirmed warning for a coin that was alerted within 12 hours is recorded but not alerted again", async () => {
    await q("delete from setups"); await q("delete from email_notifications"); await q("delete from setup_events");
    const old = await q(`insert into setups (symbol, strategy, status, first_seen_at, status_since, last_scan_at, conditions, reasons, expired_at, expire_reason)
      values ('SOLUSDT','EXIT_WARNING','EXPIRED', now() - interval '3 hours', now() - interval '2 hours', now() - interval '2 hours', '[]'::jsonb, '[]'::jsonb, now() - interval '2 hours', 'the validity window ended') returning id`);
    await q("insert into setup_events (setup_id, kind, at, price, note, notify) values ($1, 'CONFIRMED', now() - interval '3 hours', 100, 'earlier alert', true)", [old[0].id]);
    await processSetups(t.db, input({ settings: { ...S, setupAlertsEnabled: true } }));
    const fresh = await q("select id, status from setups where strategy = 'EXIT_WARNING' and status = 'CONFIRMED'");
    assert.equal(fresh.length, 1, "the new setup is still recorded and shown on the dashboard");
    assert.equal((await q("select 1 from setup_events where setup_id = $1 and kind = 'CONFIRMED' and notify", [fresh[0].id])).length, 0);
    assert.equal((await q("select 1 from email_notifications where kind = 'SETUP'")).length, 0);
  });
  it("a paused coin or the engine switched off records nothing", async () => {
    await q("delete from setups");
    assert.deepEqual(await processSetups(t.db, input({ enabled: false })), []);
    assert.deepEqual(await processSetups(t.db, input({ settings: { ...S, setupsEnabled: false } })), []);
    assert.equal((await q("select 1 from setups")).length, 0);
  });
  it("a confirmed Trend BUY setup is recorded but does NOT send a second alert (the existing BUY alert covers it)", async () => {
    await q("delete from setups"); await q("delete from email_notifications");
    const up = signalMarket();
    await processSetups(t.db, { symbol: "BTCUSDT", enabled: true, settings: { ...S, setupAlertsEnabled: true }, h1All: up.h1, h4All: up.h4, price: up.h1[up.h1.length - 1].close, nowMs: NOW });
    const row = (await q("select status from setups where strategy = 'TREND_BUY'"))[0];
    assert.equal(row?.status, "CONFIRMED");
    assert.equal((await q("select 1 from setup_events where kind = 'CONFIRMED' and notify")).length, 0);
    assert.equal((await q("select 1 from email_notifications where kind = 'SETUP'")).length, 0);
  });
  it("delayed market data creates nothing and is reported as a data issue", async () => {
    await q("delete from setups");
    await processSetups(t.db, input({ nowMs: NOW + 5 * H1 }));
    assert.equal((await q("select 1 from setups")).length, 0);
    const sum = await setupsSummary(t.db, NOW + 5 * H1);
    assert.ok(sum.dataIssues.some((d) => d.symbol === "SOLUSDT" && /delayed/i.test(d.issue)));
    await processSetups(t.db, input());
    assert.equal((await setupsSummary(t.db, NOW)).dataIssues.length, 0, "cleared once data is healthy again");
  });
  it("Support-Bounce outcomes are tracked separately, resolved on later candles, with an honest small-sample warning", async () => {
    await q("delete from setups");
    const c = sc.h1Closed;
    const k = c.length - 70;
    const entry = c[k].close;
    const levels = { entry, stop: entry * 0.995, target: entry * 1.02, targetBasis: "2R", riskPct: 0.5, riskReward: 4, netRiskReward: 3 };
    await q(
      `insert into setups (symbol, strategy, status, first_seen_at, status_since, signal_candle_start, signal_price, signal_price_at, confirm_candle_close, last_scan_at, levels, expired_at, expire_reason)
       values ('SOLUSDT','BOUNCE','EXPIRED', now(), now(), $1::timestamptz, $2, now(), $2, now(), $3::jsonb, now(), 'the validity window ended')`,
      [new Date(c[k].start).toISOString(), entry, JSON.stringify(levels)],
    );
    await processSetups(t.db, input());
    const expected = resolveSignal({ direction: "LONG", candleStart: c[k].start, stop: levels.stop, takeProfit: levels.target }, c, S);
    assert.notEqual(expected.status, "open");
    const row = (await q("select outcome_status, outcome_net_pct from setups where strategy = 'BOUNCE'"))[0];
    assert.equal(row.outcome_status, expected.status);
    const sum = await setupsSummary(t.db, NOW);
    assert.equal(sum.bounceStats.count, expected.status === "missed" ? 0 : 1);
    assert.ok(sum.bounceStats.caveats[0].startsWith("Only "), "fewer than 30 signals is stated plainly");
    assert.equal((await q("select 1 from paper_trades")).length, 0);
  });
});
