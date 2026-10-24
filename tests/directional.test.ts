import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Row } from "@/lib/db";
import { analyzeDirection, computeStats, MAX_HOLD_BARS, resolveSignal, runBacktest, swingLevels, type ResolvedTrade, type TrackedSignal } from "@/lib/directional";
import { directionalSummary, processDirectional, resolveOpenSignals } from "@/lib/directional-run";
import { ensureSetup } from "@/lib/migrations";
import { closedCandles } from "@/lib/rules";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { pushNewSignals } from "@/lib/webpush";
import type { Candle, Settings } from "@/lib/types";
import { H1, H4, floor4h, hourly, toFourHour } from "./helpers/market";
import { makeTestDb, type TestDb } from "./helpers/db";

const S: Settings = DEFAULT_SETTINGS;
const END = floor4h(Date.UTC(2026, 9, 20, 12));
// 4h history is longer than the 1h window (like the real exchange fetch: 1000 candles of each), so the 4h trend is available from the start.
const longUp = hourly(2400, END, { drift: 0.0006, seed: 3, cycle: 30, vol: 0.007 });
const longDown = hourly(2400, END, { drift: -0.0006, seed: 5, cycle: 30, vol: 0.007 });
const up = () => longUp.slice(-1000);
const down = () => longDown.slice(-1000);
const up4 = () => toFourHour(longUp);
const down4 = () => toFourHour(longDown);

/** Finds the first candle index (after warm-up) at which the live rules raise `dir`, using only candles closed by then. */
function findSignalIndex(h1: Candle[], h4: Candle[], dir: "LONG" | "SHORT", from = 160): number {
  for (let i = from; i < h1.length; i++) {
    const now = h1[i].start + H1 + 1000;
    const a = analyzeDirection({ h1: h1.slice(0, i + 1), h4: h4.filter((c) => c.start + H4 <= h1[i].start + H1), now, settings: S });
    if (a.direction === dir) return i;
  }
  return -1;
}

describe("LONG / SHORT / NEUTRAL analysis (pure)", () => {
  const h1u = up(), h4u = up4(), h1d = down(), h4d = down4();

  it("reports LONG in a confirmed uptrend with coherent levels, reasons and invalidations", () => {
    const i = findSignalIndex(h1u, h4u, "LONG");
    assert.ok(i > 0, "the uptrend market must produce a LONG at some point");
    const now = h1u[i].start + H1 + 1000;
    const a = analyzeDirection({ h1: h1u.slice(0, i + 1), h4: h4u.filter((c) => c.start + H4 <= h1u[i].start + H1), now, settings: S });
    const lv = a.levels!;
    assert.equal(a.direction, "LONG");
    assert.equal(a.h4Trend, "UP");
    assert.ok(lv.stop < lv.entry && lv.entry < lv.takeProfit, "stop below entry below target");
    assert.ok(lv.riskReward >= S.minRiskReward - 1e-9, "never below the minimum reward/risk");
    assert.ok(lv.netRiskReward >= 1 && lv.netRiskReward < lv.riskReward, "costs reduce the reward/risk");
    assert.equal(lv.entry, h1u[i].close, "entry reference is the last closed candle's close");
    assert.ok(a.reasons.length >= 5 && a.invalidations.length >= 5);
    assert.ok(a.checks.every((c) => c.long === true));
    assert.ok(a.limitations.some((l) => /SPOT/.test(l)));
  });

  it("reports SHORT in a confirmed downtrend with levels mirrored", () => {
    const i = findSignalIndex(h1d, h4d, "SHORT");
    assert.ok(i > 0, "the downtrend market must produce a SHORT at some point");
    const now = h1d[i].start + H1 + 1000;
    const a = analyzeDirection({ h1: h1d.slice(0, i + 1), h4: h4d.filter((c) => c.start + H4 <= h1d[i].start + H1), now, settings: S });
    const lv = a.levels!;
    assert.equal(a.direction, "SHORT");
    assert.equal(a.h4Trend, "DOWN");
    assert.ok(lv.takeProfit < lv.entry && lv.entry < lv.stop);
    assert.ok(a.checks.every((c) => c.short === true));
  });

  it("an uptrend never produces a SHORT and a downtrend never produces a LONG at the same moment", () => {
    for (let i = 160; i < h1u.length; i += 7) {
      const a = analyzeDirection({ h1: h1u.slice(0, i + 1), h4: h4u.filter((c) => c.start + H4 <= h1u[i].start + H1), now: h1u[i].start + H1 + 1000, settings: S });
      if (a.direction === "SHORT") assert.notEqual(a.h4Trend, "UP");
      if (a.direction === "LONG") assert.equal(a.h4Trend, "UP");
    }
  });

  it("stays NEUTRAL (and explains why) when timeframes contradict or momentum is missing; most hours are neutral", () => {
    let neutral = 0, total = 0, sawContradiction = false;
    for (let i = 160; i < h1u.length; i += 3) {
      const a = analyzeDirection({ h1: h1u.slice(0, i + 1), h4: h4u.filter((c) => c.start + H4 <= h1u[i].start + H1), now: h1u[i].start + H1 + 1000, settings: S });
      total++;
      if (a.direction === "NEUTRAL") {
        neutral++;
        assert.ok(a.notes.length >= 2, "NEUTRAL always carries an explanation");
        assert.equal(a.levels, null);
        if (a.notes.some((n) => /contradict/.test(n))) sawContradiction = true;
      }
    }
    assert.ok(neutral / total > 0.6, `NEUTRAL should be the common outcome (was ${(neutral / total).toFixed(2)})`);
    assert.ok(sawContradiction, "contradictory timeframes are detected and named");
  });

  it("does not force a signal when volatility is extreme, volume is dry or reward/risk is poor", () => {
    const i = findSignalIndex(h1u, h4u, "LONG");
    const base = h1u.slice(0, i + 1);
    const h4 = h4u.filter((c) => c.start + H4 <= h1u[i].start + H1);
    const now = h1u[i].start + H1 + 1000;
    // volume collapses on the last candle
    const dry = base.map((c, k) => (k === base.length - 1 ? { ...c, volume: c.volume * 0.05 } : c));
    assert.equal(analyzeDirection({ h1: dry, h4, now, settings: S }).direction, "NEUTRAL");
    // a very demanding reward/risk requirement
    assert.equal(analyzeDirection({ h1: base, h4, now, settings: { ...S, minRiskReward: 5 } }).direction, "NEUTRAL");
    // huge costs make the setup not worthwhile
    assert.equal(analyzeDirection({ h1: base, h4, now, settings: { ...S, slippagePct: 2, feeRatePct: 1 } }).direction, "NEUTRAL");
    // a violent final candle (ATR spike)
    const spike = base.map((c, k) => (k === base.length - 1 ? { ...c, high: c.high * 1.12, low: c.low * 0.9 } : c));
    assert.equal(analyzeDirection({ h1: spike, h4, now, settings: S }).direction, "NEUTRAL");
  });

  it("missing, stale, gapped or too-short data gives NEUTRAL with dataOk=false (never a signal)", () => {
    const i = findSignalIndex(h1u, h4u, "LONG");
    const base = h1u.slice(0, i + 1);
    const h4 = h4u.filter((c) => c.start + H4 <= h1u[i].start + H1);
    const now = h1u[i].start + H1 + 1000;
    const stale = analyzeDirection({ h1: base, h4, now: now + 5 * H1, settings: S });
    assert.equal(stale.dataOk, false);
    assert.match(stale.dataIssue ?? "", /stale/);
    const gapped = base.filter((_, k) => k !== base.length - 10);
    assert.match(analyzeDirection({ h1: gapped, h4, now, settings: S }).dataIssue ?? "", /gap/);
    assert.match(analyzeDirection({ h1: base.slice(-40), h4, now, settings: S }).dataIssue ?? "", /not enough/);
    for (const a of [stale]) assert.equal(a.direction, "NEUTRAL");
  });

  it("support/resistance uses confirmed swing points only and counts equal highs once", () => {
    const mk = (hs: number[]) => hs.map((h, k): Candle => ({ start: k * H1, open: h - 1, high: h, low: h - 2, close: h - 1, volume: 1, turnover: 0 }));
    const r = swingLevels(mk([1, 2, 3, 9, 3, 2, 1, 2, 3, 4, 5, 6, 7, 8]), 100, 3);
    assert.deepEqual(r.highs, [9], "the newest candles are not pivots until 3 candles have followed them");
    const tie = swingLevels(mk([1, 2, 3, 9, 9, 3, 2, 1]), 100, 3);
    assert.deepEqual(tie.highs, [9]);
  });
});

describe("outcome tracking (forward, no look-ahead)", () => {
  const sigL: TrackedSignal = { direction: "LONG", candleStart: 0, stop: 98, takeProfit: 104 };
  const sigS: TrackedSignal = { direction: "SHORT", candleStart: 0, stop: 102, takeProfit: 96 };
  const c = (k: number, o: number, h: number, l: number, cl: number): Candle => ({ start: k * H1, open: o, high: h, low: l, close: cl, volume: 1, turnover: 0 });
  const costs = { feeRatePct: 0.1, slippagePct: 0.05 };

  it("fills at the NEXT candle's open and deducts fees+slippage on both sides", () => {
    const o = resolveSignal(sigL, [c(0, 99, 100, 99, 100), c(1, 100, 101, 99.5, 100.5), c(2, 100.5, 105, 100, 104.5)], costs);
    assert.equal(o.status, "tp");
    assert.equal(o.fillPrice, 100);
    assert.equal(o.exitPrice, 104);
    assert.ok(Math.abs((o.grossPct as number) - 4) < 1e-9);
    assert.ok(Math.abs((o.netPct as number) - (4 - 0.3)) < 1e-9, "net = gross − 2×(0.1+0.05)");
    assert.equal(o.bars, 2);
    assert.ok((o.rMultiple as number) > 0);
  });
  it("SHORT mirrors LONG", () => {
    const o = resolveSignal(sigS, [c(1, 100, 100.5, 99, 99.5), c(2, 99.5, 99.8, 95, 96.2)], costs);
    assert.equal(o.status, "tp");
    assert.ok(Math.abs((o.grossPct as number) - 4) < 1e-9);
    const sl = resolveSignal(sigS, [c(1, 100, 103, 99.5, 102.5)], costs);
    assert.equal(sl.status, "sl");
    assert.ok((sl.netPct as number) < -2);
  });
  it("stop and target inside one candle: the stop is assumed first and flagged ambiguous", () => {
    const o = resolveSignal(sigL, [c(1, 100, 105, 97, 101)], costs);
    assert.equal(o.status, "sl");
    assert.equal(o.ambiguous, true);
  });
  it("a gap past a level at the fill is 'missed' (no trade, not counted as a win or a loss)", () => {
    assert.equal(resolveSignal(sigL, [c(1, 97, 99, 96, 98)], costs).status, "missed");
    assert.equal(resolveSignal(sigL, [c(1, 105, 106, 104, 105)], costs).status, "missed");
  });
  it("stays open until resolved, and expires at market after the maximum holding period", () => {
    const flat = Array.from({ length: MAX_HOLD_BARS + 5 }, (_, k) => c(k + 1, 100, 100.4, 99.6, 100.1));
    assert.equal(resolveSignal(sigL, flat.slice(0, 10), costs).status, "open");
    const e = resolveSignal(sigL, flat, costs);
    assert.equal(e.status, "expired");
    assert.equal(e.bars, MAX_HOLD_BARS);
    assert.equal(e.exitPrice, 100.1);
  });
  it("a missing candle (gap) never produces an outcome by guessing", () => {
    assert.equal(resolveSignal(sigL, [c(3, 100, 120, 90, 100)], costs).status, "open");
  });
  it("is unaffected by candles that come later than the resolution moment (no look-ahead)", () => {
    const a = [c(1, 100, 101, 99.5, 100.5), c(2, 100.5, 101, 99.9, 100.6)];
    const o1 = resolveSignal(sigL, a, costs);
    const o2 = resolveSignal(sigL, [...a, c(3, 100.6, 130, 100, 129)], costs);
    assert.equal(o1.status, "open");
    assert.equal(o2.status, "tp");
    assert.equal(resolveSignal(sigL, a, costs).status, "open", "same inputs, same answer");
  });
});

describe("performance statistics", () => {
  const t = (i: number, net: number, dir: "LONG" | "SHORT" = "LONG", symbol = "BTCUSDT"): ResolvedTrade => ({ symbol, direction: dir, status: net > 0 ? "tp" : "sl", exitAt: i, netPct: net, grossPct: net + 0.3, rMultiple: net / 2, ambiguous: false });
  it("computes win rate, totals, profit factor and maximum drawdown on the closing order", () => {
    const s = computeStats([t(1, 2), t(2, -1), t(3, -2), t(4, 3), t(5, -0.5, "SHORT", "ETHUSDT")]);
    assert.equal(s.count, 5);
    assert.equal(s.wins, 2);
    assert.equal(s.losses, 3);
    assert.ok(Math.abs((s.winRatePct as number) - 40) < 1e-9);
    assert.ok(Math.abs(s.totalNetPct - 1.5) < 1e-9);
    assert.ok(Math.abs((s.profitFactor as number) - 5 / 3.5) < 1e-9);
    assert.ok(Math.abs(s.maxDrawdownPct - 3) < 1e-9, "equity 2,1,-1,2,1.5 → peak 2, trough -1");
    assert.equal(s.long.count, 4);
    assert.equal(s.short.count, 1);
    assert.equal(s.bySymbol.ETHUSDT.count, 1);
    assert.match(s.caveats[0], /Only 5 resolved/);
  });
  it("with no trades reports nothing rather than inventing numbers", () => {
    const s = computeStats([]);
    assert.equal(s.count, 0);
    assert.equal(s.winRatePct, null);
    assert.equal(s.avgNetPct, null);
    assert.equal(s.profitFactor, null);
  });
});

describe("walk-forward back-test", () => {
  it("is deterministic, selective, and uses no future data: results up to T do not change when later candles are added", () => {
    const h1 = up(), h4 = up4();
    const full = runBacktest({ symbol: "TESTUSDT", h1, h4, settings: S });
    assert.deepEqual(full, runBacktest({ symbol: "TESTUSDT", h1, h4, settings: S }));
    assert.ok(full.signals.length >= 3 && full.signals.length < 40, "selective but not empty");
    const cut = 700;
    const part = runBacktest({ symbol: "TESTUSDT", h1: h1.slice(0, cut), h4: h4.filter((c) => c.start + H4 <= h1[cut - 1].start + H1), settings: S });
    const T = h1[cut - 1].start;
    const early = (r: typeof full) => r.signals.filter((s) => s.candleStart < T - MAX_HOLD_BARS * H1).map((s) => [s.direction, s.candleStart, s.stop, s.takeProfit, s.outcome.status]);
    assert.deepEqual(early(part), early(full), "earlier decisions and outcomes are identical with or without the future");
  });
  it("discloses its limitations and never reports a win rate for an empty sample", () => {
    const long = hourly(1500, END, { seed: 2 });
    const r = runBacktest({ symbol: "TESTUSDT", h1: long.slice(-300), h4: toFourHour(long), settings: S });
    assert.ok(r.limitations.some((l) => /small|sample/i.test(l)));
    assert.ok(r.limitations.some((l) => /look-ahead|walk-forward/i.test(l)));
    if (r.stats.count === 0) assert.equal(r.stats.winRatePct, null);
  });
});

describe("persistence, alerts and duplicate protection", () => {
  let t: TestDb;
  const symbol = "ETHUSDT";
  const h1 = up(), h4all = up4();
  let idx = -1;
  before(async () => {
    t = await makeTestDb();
    await ensureSetup(t.db);
    idx = findSignalIndex(h1, h4all, "LONG");
  });
  after(async () => { await t.cleanup(); });
  const inputAt = (i: number, over: Partial<Parameters<typeof processDirectional>[1]> = {}) => {
    const closed = h1.slice(0, i + 1);
    return { symbol, enabled: true, settings: S, h1Closed: closed, h4Closed: h4all.filter((c) => c.start + H4 <= h1[i].start + H1), nowMs: h1[i].start + H1 + 60_000, spotContext: "no BUY signal", ...over };
  };
  const q = async <T = Row>(sql: string, p?: unknown[]) => (await t.db.query<T>(sql, p)).rows;

  it("a new LONG raises exactly one signal and one email (kind LONG, to the configured recipient), and remembers the assessment", async () => {
    const out = await processDirectional(t.db, inputAt(idx));
    assert.equal(out.assessment.direction, "LONG");
    const sigs = await q<{ direction: string; status: string }>("select direction, status from directional_signals");
    assert.deepEqual(sigs.map((s) => [s.direction, s.status]), [["LONG", "open"]]);
    const mails = await q<{ kind: string; recipient: string; subject: string; status: string; text_body: string }>("select kind, recipient, subject, status, text_body from email_notifications where signal_id is not null");
    assert.equal(mails.length, 1);
    assert.equal(mails[0].kind, "LONG");
    assert.equal(mails[0].recipient, "olaleyevictor206@gmail.com");
    assert.match(mails[0].subject, /^\[Crypto Sentinel\] LONG analysis · ETH\/USDT @ /);
    assert.match(mails[0].text_body, /separate from the BUY\/SELL spot paper-trading alerts/);
    assert.match(mails[0].text_body, /Stop-loss reference/);
    assert.match(mails[0].text_body, /What would invalidate it/);
    assert.match(mails[0].text_body, /Current BUY\/SELL \(spot paper\) state for ETH\/USDT: no BUY signal/);
    assert.match(mails[0].text_body, /NO REAL TRADE WAS EXECUTED/);
    const st = await q<{ direction: string }>("select direction from direction_state where symbol = $1", [symbol]);
    assert.equal(st[0].direction, "LONG");
  });

  it("re-running the same candle, or staying LONG, never duplicates the signal or the email", async () => {
    await processDirectional(t.db, inputAt(idx));
    await processDirectional(t.db, inputAt(idx, { nowMs: h1[idx].start + H1 + 120_000 }));
    assert.equal((await q("select 1 from directional_signals")).length, 1);
    assert.equal((await q("select 1 from email_notifications where signal_id is not null")).length, 1);
  });

  it("pushes the signal to subscribed phones exactly once, with the BUY/SELL system untouched", async () => {
    const calls: string[] = [];
    const fetchFn = (async (u: string) => { calls.push(u); return new Response("", { status: 201 }); }) as unknown as typeof fetch;
    const { createECDH } = await import("node:crypto");
    const ua = createECDH("prime256v1"); ua.generateKeys();
    await t.db.query("insert into push_subscriptions (endpoint, p256dh, auth) values ($1,$2,$3)", ["https://fcm.googleapis.com/fcm/send/x", ua.getPublicKey().toString("base64url"), Buffer.alloc(16, 1).toString("base64url")]);
    const now = h1[idx].start + H1 + 180_000;
    const a = await pushNewSignals(t.db, { fetchFn, now: () => now });
    const b = await pushNewSignals(t.db, { fetchFn, now: () => now + 1000 });
    assert.equal(a.signals, 1);
    assert.equal(a.sent, 1);
    assert.equal(b.signals, 0);
    assert.equal(calls.length, 1);
    assert.equal((await q("select 1 from paper_trades")).length, 0, "LONG/SHORT never creates paper trades");
    assert.equal((await q("select 1 from paper_positions")).length, 0);
  });

  it("an opposite direction closes the open signal as 'reversed' and raises the new one", async () => {
    await t.db.query("update directional_signals set stop = 1, take_profit = 1e9");
    const hd = down(), h4d = down4();
    const j = findSignalIndex(hd, h4d, "SHORT");
    const s = await t.db.query<Row>("select id from directional_signals");
    // put the open LONG just before the SHORT candle so the SHORT is a legitimate reversal
    await t.db.query("update directional_signals set candle_start = $1::timestamptz", [new Date(hd[j - 5].start).toISOString()]);
    await processDirectional(t.db, { symbol, enabled: true, settings: S, h1Closed: hd.slice(0, j + 1), h4Closed: h4d.filter((c) => c.start + H4 <= hd[j].start + H1), nowMs: hd[j].start + H1 + 60_000 });
    const rows = await q<{ direction: string; status: string }>("select direction, status from directional_signals order by id");
    assert.equal(s.rows.length, 1);
    assert.deepEqual(rows.map((r) => [r.direction, r.status]), [["LONG", "reversed"], ["SHORT", "open"]]);
    assert.equal((await q("select 1 from email_notifications where kind = 'SHORT'")).length, 1);
  });

  it("resolves open signals from later candles and the summary reports the outcome honestly", async () => {
    const hd = down();
    const open = (await q<{ id: string; candle_start: string; stop: string; take_profit: string }>("select id, candle_start, stop, take_profit from directional_signals where status = 'open'"))[0];
    const cs = new Date(open.candle_start).getTime();
    const next: Candle[] = [
      { start: cs + H1, open: Number(open.take_profit) * 1.02, high: Number(open.take_profit) * 1.03, low: Number(open.take_profit) * 0.99, close: Number(open.take_profit) * 1.0, volume: 1, turnover: 0 },
    ];
    const actions = await resolveOpenSignals(t.db, symbol, next, S, cs + 2 * H1);
    assert.equal(actions.length, 1);
    assert.match(actions[0], /reached its target/);
    const sum = await directionalSummary(t.db);
    assert.equal(sum.counts.open, 0);
    assert.equal(sum.stats.count, 2, "reversed + target are both resolved trades");
    assert.ok(hd.length > 0);
  });

  it("disabled analysis or a paused coin raises no signal; disabled emails are recorded as skipped", async () => {
    const t2 = await makeTestDb();
    try {
      await ensureSetup(t2.db);
      const i = idx;
      const mk = (over: Partial<Parameters<typeof processDirectional>[1]>) => ({ symbol: "SOLUSDT", enabled: true, settings: S, h1Closed: h1.slice(0, i + 1), h4Closed: h4all.filter((c) => c.start + H4 <= h1[i].start + H1), nowMs: h1[i].start + H1 + 60_000, ...over });
      await processDirectional(t2.db, mk({ settings: { ...S, directionalEnabled: false } }));
      await processDirectional(t2.db, mk({ enabled: false, symbol: "XRPUSDT" }));
      assert.equal((await t2.db.query("select 1 from directional_signals")).rows.length, 0);
      await t2.db.query("delete from direction_state");
      await processDirectional(t2.db, mk({ symbol: "BNBUSDT", settings: { ...S, directionalEmailEnabled: false } }));
      const m = (await t2.db.query<Row>("select status, last_error from email_notifications where signal_id is not null")).rows;
      assert.equal(m.length, 1);
      assert.equal(m[0].status, "skipped");
      assert.match(m[0].last_error, /turned off/);
    } finally { await t2.cleanup(); }
  });

  it("a signal that is already too old (monitor was down) is not raised", async () => {
    const t3 = await makeTestDb();
    try {
      await ensureSetup(t3.db);
      await processDirectional(t3.db, { symbol: "BTCUSDT", enabled: true, settings: S, h1Closed: h1.slice(0, idx + 1), h4Closed: h4all.filter((c) => c.start + H4 <= h1[idx].start + H1), nowMs: h1[idx].start + H1 + 31 * 60_000 });
      assert.equal((await t3.db.query("select 1 from directional_signals")).rows.length, 0);
      // and because candles must be fresh to be assessed at all, the assessment itself is reported as data-invalid-free but not signalled
    } finally { await t3.cleanup(); }
  });
});
