import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { runMonitor } from "@/lib/monitor";
import { roundPrice, simulatedQuantity } from "@/lib/paper";
import { addAsset, getOpenPosition, listAssets, loadSettings, removeAsset, saveSettings, setAssetEnabled } from "@/lib/store";
import { queueTradeEmail } from "@/lib/email";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { H1, NOW, scaled, signalMarket } from "./helpers/fixtures";
import { makeHarness, type Harness } from "./helpers/harness";

let h: Harness | null = null;
afterEach(async () => { await h?.cleanup(); h = null; });
const fresh = async () => (h = await makeHarness());
const code = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return (e as { code?: string }).code ?? "no-code"; } };

describe("persistence & restarts", () => {
  it("positions, settings and trade history survive a restart; a re-run on the same candle adds nothing", async () => {
    const x = await fresh();
    await x.setSettings({ positionAmountUsdt: 12, stopLossPct: 3 });
    await x.run();
    assert.equal((await x.q("select 1 from paper_trades")).length, 5);
    const db2 = await x.t.reopen(); // brand-new connections = a cold function instance
    assert.equal((await getOpenPosition(db2, "BTCUSDT"))?.amountUsdt, 12);
    assert.equal((await loadSettings(db2)).stopLossPct, 3);
    const r = await runMonitor({ ...x.deps(), db: db2 });
    assert.equal(r.status, "success");
    assert.equal((await db2.query("select 1 from paper_trades")).rows.length, 5);
    assert.equal(x.calls.length, 5);
  });
  it("migrations are idempotent and seed exactly one settings row and a 65.50 account", async () => {
    const x = await fresh();
    const { runMigrations } = await import("@/lib/migrations");
    assert.deepEqual(await runMigrations(x.t.db), []);
    assert.equal((await x.q("select 1 from app_settings")).length, 1);
    assert.deepEqual((await x.q<{ starting_balance: string }>("select starting_balance from paper_account")).map((r) => Number(r.starting_balance)), [65.5]);
    assert.equal((await x.q("select id from schema_migrations order by id")).length, 5);
    assert.equal((await x.q<{ v: string }>("select settings->>'trendExitEnabled' as v from app_settings"))[0].v, "true", "SELL on a broken trend is on by default");
  });
});

describe("overlapping runs", () => {
  it("two simultaneous invocations never duplicate trades or emails", async () => {
    const x = await fresh();
    await x.run(); // apply migrations once
    await x.q("delete from email_notifications"); await x.q("delete from paper_trades"); await x.q("delete from paper_positions");
    await x.q("update paper_account set available_balance = 65.5"); x.calls.length = 0;
    const results = await Promise.all([x.run(), x.run(), x.run()]);
    assert.ok(results.some((r) => r.status === "success"));
    assert.equal((await x.q("select 1 from paper_positions")).length, 5);
    assert.equal((await x.q("select 1 from paper_trades")).length, 5);
    assert.equal(x.calls.length, 5);
  });
  it("a held lease makes the invocation skip (and record that it skipped); an expired lease does not block", async () => {
    const x = await fresh();
    await x.run();
    // children first: email_notifications → paper_trades → paper_positions (foreign keys)
    await x.q("delete from email_notifications"); await x.q("delete from paper_trades"); await x.q("delete from paper_positions");
    await x.q("update paper_account set available_balance = 65.5");
    await x.q("insert into job_lock (name, owner, locked_until) values ('monitor', 'someone-else', now() + interval '60 seconds') on conflict (name) do update set owner = 'someone-else', locked_until = now() + interval '60 seconds'");
    const r = await x.run();
    assert.equal(r.status, "skipped_locked");
    assert.equal((await x.q("select 1 from paper_positions")).length, 0);
    assert.equal((await x.q("select 1 from job_runs where status = 'skipped_locked'")).length, 1);
    await x.q("update job_lock set locked_until = now() - interval '1 second' where name = 'monitor'");
    assert.equal((await x.run()).status, "success");
    assert.equal((await x.q("select 1 from paper_positions")).length, 5);
  });
  it("the lease is released after a run (so the next scheduled run can start)", async () => {
    const x = await fresh();
    await x.run();
    const [l] = await x.q<{ expired: boolean }>("select locked_until <= now() as expired from job_lock where name = 'monitor'");
    assert.equal(l.expired, true);
  });
});

describe("failure isolation & outages (never invent data or trades)", () => {
  it("one failing coin does not stop the others; the failure is recorded for that coin only", async () => {
    const x = await fresh();
    x.bybitOpts.failKlinesFor = ["ETHUSDT"];
    const r = await x.run();
    assert.equal(r.status, "partial");
    const syms = (await x.q<{ symbol: string }>("select symbol from paper_positions order by symbol")).map((p) => p.symbol);
    assert.deepEqual(syms, ["BNBUSDT", "BTCUSDT", "SOLUSDT", "XRPUSDT"]);
    const [eth] = await x.q<{ last_error: string; last_ok_at: string | null }>("select last_error, last_ok_at from assets where symbol = 'ETHUSDT'");
    assert.match(eth.last_error, /ETH/);
    assert.equal(eth.last_ok_at, null);
    assert.equal(x.calls.length, 4);
  });
  it("total exchange outage → run is 'failed', no trades, no snapshots, no emails, error recorded", async () => {
    const x = await fresh();
    x.bybitOpts.failKlines = "always"; x.bybitOpts.failTickers = true;
    const r = await x.run();
    assert.equal(r.status, "failed");
    for (const t of ["paper_trades", "paper_positions", "market_snapshots", "email_notifications", "signal_evaluations"]) assert.equal((await x.q(`select 1 from ${t}`)).length, 0, t);
    const [run] = await x.q<{ status: string; message: string }>("select status, message from job_runs order by id desc limit 1");
    assert.equal(run.status, "failed");
    const [kv] = await x.q<{ value: { lastError: string; lastSuccessAt: null } }>("select value from kv where key = 'market_api'");
    assert.ok(kv.value.lastError);
    assert.equal(kv.value.lastSuccessAt, null);
  });
  it("ticker outage: an open position is NOT closed on a guess, and the problem is reported", async () => {
    const x = await fresh();
    await x.run();
    x.bybitOpts.failTickers = true;
    for (const s of Object.values(x.ex.symbols)) s.lastPrice *= 0.5;
    const r = await x.run("cron", 60_000);
    assert.equal(r.status, "failed");
    assert.match(r.errors.join(" "), /could not be evaluated for exit|ticker/i);
    assert.equal((await x.q("select 1 from paper_positions where status = 'open'")).length, 5);
  });
  it("candle outage: risk exits still work from the live price alone", async () => {
    const x = await fresh();
    await x.run();
    x.bybitOpts.failKlines = "always";
    x.ex.symbols.BTCUSDT.lastPrice *= 0.97;
    const r = await x.run("cron", 60_000);
    assert.equal((await x.q("select exit_reason from paper_positions where symbol = 'BTCUSDT'"))[0].exit_reason, "STOP_LOSS");
    assert.ok(r.actions.some((a) => a.includes("SELL")));
  });
  it("stale candles (no new data for 3 h) → DATA_INVALID and no entries", async () => {
    const x = await fresh();
    x.ex.now = NOW + 3 * H1; // candles unchanged
    await x.run();
    assert.equal((await x.q("select 1 from paper_positions")).length, 0);
    const ev = await x.q<{ status: string }>("select status from signal_evaluations");
    assert.ok(ev.length === 5 && ev.every((e) => e.status === "DATA_INVALID"));
    assert.equal((await x.q<{ last_eval_status: string }>("select last_eval_status from assets where symbol = 'BTCUSDT'"))[0].last_eval_status, "DATA_INVALID");
  });
  it("a ticker whose timestamp disagrees with our clock is not used for trading", async () => {
    const x = await fresh();
    x.bybitOpts.tickerTimeOffsetMs = -10 * 60_000;
    const r = await x.run();
    assert.equal((await x.q("select 1 from paper_positions")).length, 0);
    assert.match(r.errors.join(" "), /ticker timestamp/);
  });
  it("entries are only taken within the entry window after the candle closes", async () => {
    const x = await fresh();
    x.ex.now = NOW + 45 * 60_000; // 15:50 — the 15:00 close is 50 min old (window 30)
    await x.run();
    assert.equal((await x.q("select 1 from paper_positions")).length, 0);
    assert.equal((await x.q<{ last_eval_status: string }>("select last_eval_status from assets where symbol='ETHUSDT'"))[0].last_eval_status, "SIGNAL_WINDOW_PASSED");
    assert.equal(x.calls.length, 0);
  });
  it("snapshots are throttled to one per coin per 5 minutes", async () => {
    const x = await fresh();
    await x.run(); await x.run("cron", 60_000); await x.run("cron", 60_000);
    assert.equal((await x.q("select 1 from market_snapshots")).length, 5);
    await x.run("cron", 6 * 60_000);
    assert.equal((await x.q("select 1 from market_snapshots")).length, 10);
  });
  it("each evaluation is stored with its pass/fail conditions for the dashboard", async () => {
    const x = await fresh();
    await x.run();
    const [ev] = await x.q<{ conditions: Array<{ id: string; passed: boolean }>; status: string }>("select conditions, status from signal_evaluations where symbol = 'BTCUSDT'");
    assert.equal(ev.status, "SIGNAL");
    assert.equal(ev.conditions.length, 13);
    assert.ok(ev.conditions.every((c) => c.passed));
  });
});

describe("position sizing and the simulated balance", () => {
  it("uses the position amount from settings", async () => {
    const x = await fresh();
    await x.setSettings({ positionAmountUsdt: 20 });
    await x.run();
    const [p] = await x.q<{ quantity: string; entry_price: string; amount_usdt: string }>("select * from paper_positions where symbol = 'BTCUSDT'");
    assert.equal(Number(p.amount_usdt), 20);
    assert.equal(Number(p.quantity), simulatedQuantity(20, roundPrice(x.ex.symbols.BTCUSDT.lastPrice)));
  });
  it("never spends more than the simulated balance (65.50): extra signals are skipped, no negative balance", async () => {
    const x = await fresh();
    await x.setSettings({ positionAmountUsdt: 30 });
    const r = await x.run();
    assert.equal((await x.q("select 1 from paper_positions")).length, 2);
    assert.equal(x.calls.length, 2);
    assert.match(r.actions.join(" "), /simulated balance/);
    assert.ok(Number((await x.q<{ available_balance: string }>("select available_balance from paper_account"))[0].available_balance) >= 0);
  });
});

describe("managing coins from the website (store layer)", () => {
  it("a paused coin with an open position is still monitored for its exit, and gets no new entries", async () => {
    const x = await fresh();
    await x.run();
    await setAssetEnabled(x.t.db, "BTCUSDT", false);
    x.ex.symbols.BTCUSDT.lastPrice *= 1.05;
    await x.run("cron", 60_000);
    assert.equal((await x.q("select exit_reason from paper_positions where symbol = 'BTCUSDT'"))[0].exit_reason, "TAKE_PROFIT");
    const before = (await x.q("select 1 from paper_positions")).length;
    x.setMarket(NOW + 2 * H1, "down"); await x.run("cron", 60_000);
    x.setMarket(NOW + 3 * H1, "signal"); await x.run("cron", 60_000);
    assert.equal((await x.q("select 1 from paper_positions where symbol = 'BTCUSDT'")).length, 1, "paused coin was not re-entered");
    assert.ok((await x.q("select 1 from paper_positions")).length >= before);
  });
  it("a removed coin is no longer monitored; its history is kept", async () => {
    const x = await fresh();
    await x.run();
    assert.equal(await removeAsset(x.t.db, "SOLUSDT"), "has_open_position");
    x.ex.symbols.SOLUSDT.lastPrice *= 1.06;
    await x.run("cron", 60_000);
    assert.equal(await removeAsset(x.t.db, "SOLUSDT"), "removed");
    assert.equal(await removeAsset(x.t.db, "SOLUSDT"), "not_found");
    assert.equal((await listAssets(x.t.db)).length, 4);
    assert.equal((await x.q("select 1 from paper_positions where symbol = 'SOLUSDT'")).length, 1);
    const before = (await x.q("select 1 from signal_evaluations where symbol = 'SOLUSDT'")).length;
    await x.run("cron", 60_000);
    assert.equal((await x.q("select 1 from signal_evaluations where symbol = 'SOLUSDT'")).length, before);
  });
  it("a newly added coin is picked up by the next run with no code change", async () => {
    const x = await fresh();
    const h1 = scaled(signalMarket(NOW).h1, 0.00002), h4 = scaled(signalMarket(NOW).h4, 0.00002);
    x.ex.symbols.DOGEUSDT = { h1, h4, lastPrice: h1[h1.length - 1].close };
    assert.equal(await addAsset(x.t.db, "DOGEUSDT", "DOGE"), true);
    assert.equal(await addAsset(x.t.db, "DOGEUSDT", "DOGE"), false);
    await x.run();
    assert.equal((await x.q("select 1 from paper_positions where symbol = 'DOGEUSDT'")).length, 1);
    assert.ok(x.calls.some((c) => String(c.body.subject).includes("DOGE/USDT")));
  });
  it("with no coins selected the monitor runs cleanly and says so", async () => {
    const x = await fresh();
    await x.q("delete from assets");
    const r = await x.run();
    assert.equal(r.status, "success");
    assert.match(r.message, /No coins/);
  });
});

describe("database constraints are the last line of defence", () => {
  it("rejects a 2nd open position for a coin, a 2nd entry on the same candle, duplicate event keys and negative balances", async () => {
    const x = await fresh();
    await x.run();
    const ins = (symbol: string, status: string, candle: string) => x.t.db.query(
      `insert into paper_positions (symbol, status, entry_candle_start, opened_at, entry_price, amount_usdt, quantity, fee_rate_pct, stop_loss_pct, take_profit_pct, trend_exit_enabled, entry_reason, entry_indicators${status === "closed" ? ", closed_at, exit_price, net_pnl" : ""})
       values ($1, $2, $3::timestamptz, now(), 1, 1, 1, 0.1, 2, 4, false, 'x', '{}'::jsonb${status === "closed" ? ", now(), 1, 0" : ""})`, [symbol, status, candle]);
    assert.equal(await code(ins("BTCUSDT", "open", "2020-01-01T00:00:00Z")), "23505", "second open position for the same coin");
    const [{ c }] = await x.q<{ c: string }>("select entry_candle_start as c from paper_positions where symbol = 'BTCUSDT'");
    assert.equal(await code(ins("BTCUSDT", "closed", new Date(c).toISOString())), "23505", "second entry for the same coin and candle");
    assert.equal(await code(ins("BTCUSDT", "closed", "2020-01-01T00:00:00Z")), null, "an older closed position is fine");
    const [t] = await x.q<{ event_key: string; position_id: string }>("select event_key, position_id from paper_trades limit 1");
    assert.equal(await code(x.t.db.query("insert into paper_trades (symbol, position_id, event_type, event_key, occurred_at, price, amount_usdt, quantity, reason, indicators) values ('BTCUSDT', $1, 'BUY', $2, now(), 1, 1, 1, 'x', '{}'::jsonb)", [t.position_id, t.event_key])), "23505");
    assert.equal(await code(x.t.db.query("update paper_account set available_balance = -1")), "23514");
    assert.equal(await code(x.t.db.query("insert into paper_positions (symbol, status, entry_candle_start, opened_at, entry_price, amount_usdt, quantity, fee_rate_pct, stop_loss_pct, take_profit_pct, trend_exit_enabled, entry_reason, entry_indicators) values ('ZZZUSDT','closed', now(), now(), 1,1,1,0.1,2,4,false,'x','{}'::jsonb)")), "23514", "closed rows must carry exit data");
  });
  it("a duplicate notification key is a no-op, not a second email", async () => {
    const x = await fresh();
    await x.run();
    const [t] = await x.q<{ id: string; symbol: string }>("select id, symbol from paper_trades limit 1");
    const msg = { subject: "dup", text: "t", html: "<p>t</p>" };
    const before = (await x.q("select 1 from email_notifications")).length;
    const r = await x.t.db.tx((q) => queueTradeEmail(q, { tradeId: Number(t.id), kind: "BUY", settings: DEFAULT_SETTINGS, message: msg }));
    assert.deepEqual(r, { queued: false, skipped: false });
    assert.equal((await x.q("select 1 from email_notifications")).length, before);
  });
  it("settings round-trip through the database", async () => {
    const x = await fresh();
    await x.run();
    await saveSettings(x.t.db, { ...DEFAULT_SETTINGS, takeProfitPct: 7.5, emailRecipient: "someone@example.org" });
    const s = await loadSettings(x.t.db);
    assert.equal(s.takeProfitPct, 7.5);
    assert.equal(s.emailRecipient, "someone@example.org");
  });
});
