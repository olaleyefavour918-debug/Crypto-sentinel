import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exitVerdict, aggregate, bootstrapMeanCI, firstBarrier, formatReport, buildReport, M5, replay, rng, simulateSignals, simulateTrade, statsOf, verdict, type Trade } from "@/lib/setups-backtest";
import type { Candle } from "@/lib/types";

const H = 3600_000;
const T0 = Date.UTC(2026, 0, 1);
const c = (start: number, o: number, h: number, l: number, cl: number, v = 10): Candle => ({ start, open: o, high: h, low: l, close: cl, volume: v, turnover: v * cl });
const flat = (n: number, price = 100, from = T0) => Array.from({ length: n }, (_, i) => c(from + i * M5, price, price, price, price));
const idx = (a: Candle[]) => new Map(a.map((x, i) => [x.start, i]));
const walk = (seed: number, n: number): Candle[] => {
  const r = rng(seed); let p = 100; const out: Candle[] = []; let drift = 0, left = 0;
  for (let i = 0; i < n; i++) {
    if (left-- <= 0) { drift = (r() - 0.5) * 0.0012; left = 200 + Math.floor(r() * 1500); }
    const o = p, cl = o * (1 + drift + (r() - 0.5) * 0.004);
    out.push(c(T0 + i * M5, o, Math.max(o, cl) * (1 + r() * 0.001), Math.min(o, cl) * (1 - r() * 0.001), cl, 50 + r() * 100)); p = cl;
  }
  return out;
};

describe("back-test: candles and trade arithmetic", () => {
  it("aggregates 5m into complete hourly candles and drops incomplete hours", () => {
    const a = flat(12 + 7);
    a[0] = c(T0, 100, 105, 99, 101, 5);
    a[11] = c(T0 + 11 * M5, 100, 103, 90, 102, 5);
    const h = aggregate(a, H);
    assert.equal(h.length, 1);
    assert.deepEqual([h[0].open, h[0].high, h[0].low, h[0].close, h[0].volume], [100, 105, 90, 102, 5 + 10 * 10 + 5]);
  });
  it("a hour with a missing 5m candle is not invented", () => {
    const a = flat(12); a.splice(5, 1);
    assert.equal(aggregate(a, H).length, 0);
  });
  it("target hit: entry at the open after the delay, costs and slippage applied on both sides", () => {
    const a = flat(40);
    a[3] = c(T0 + 3 * M5, 100, 104.5, 100, 104.2);
    const sig = { symbol: "X", at: T0 + 2 * M5, levels: null };
    const o = simulateTrade(sig, a, idx(a), { feePct: 0.1, slipPct: 0.05, delayMin: 5 }, { stopPct: 2, targetPct: 4, maxHoldMs: 24 * H });
    assert.ok("trade" in o);
    const t = (o as { trade: Trade }).trade;
    assert.equal(t.reason, "target");
    assert.equal(t.entryAt, T0 + 3 * M5, "5 minute delay: filled on the candle that starts 5 min after the signal");
    const fill = 100 * 1.0005, exit = 104 * 0.9995;
    assert.ok(Math.abs(t.netPct - ((exit * 0.999) / (fill * 1.001) - 1) * 100) < 1e-9);
    assert.ok(t.netPct < 4 && t.netPct > 3.5, "costs reduce the 4% target");
  });
  it("a candle touching both stop and target counts as the stop", () => {
    const a = flat(40);
    a[3] = c(T0 + 3 * M5, 100, 105, 97, 100);
    const o = simulateTrade({ symbol: "X", at: T0 + 2 * M5, levels: null }, a, idx(a), { feePct: 0, slipPct: 0, delayMin: 5 }, { stopPct: 2, targetPct: 4, maxHoldMs: 24 * H });
    assert.equal((o as { trade: Trade }).trade.reason, "stop");
    assert.ok((o as { trade: Trade }).trade.netPct < -1.99);
  });
  it("a gap below the stop exits at the worse price, not at the stop", () => {
    const a = flat(40);
    a[4] = c(T0 + 4 * M5, 95, 96, 94, 95);
    const o = simulateTrade({ symbol: "X", at: T0 + 2 * M5, levels: null }, a, idx(a), { feePct: 0, slipPct: 0, delayMin: 5 }, { stopPct: 2, targetPct: 4, maxHoldMs: 24 * H });
    assert.ok((o as { trade: Trade }).trade.netPct < -4.9);
  });
  it("time exit after the maximum hold", () => {
    const a = flat(400);
    const o = simulateTrade({ symbol: "X", at: T0, levels: null }, a, idx(a), { feePct: 0.1, slipPct: 0.05, delayMin: 5 }, { stopPct: 2, targetPct: 4, maxHoldMs: 1 * H });
    assert.equal((o as { trade: Trade }).trade.reason, "time");
    assert.ok((o as { trade: Trade }).trade.netPct < -0.29 && (o as { trade: Trade }).trade.netPct > -0.31, "a flat market still costs 2 x (0.1% fee + 0.05% slippage)");
  });
  it("a longer delay fills at the later price", () => {
    const a = flat(60);
    for (let i = 6; i < 60; i++) a[i] = c(T0 + i * M5, 101, 101, 101, 101);
    const s = { symbol: "X", at: T0, levels: null };
    const f = (d: number) => ((simulateTrade(s, a, idx(a), { feePct: 0, slipPct: 0, delayMin: d }, { stopPct: 5, targetPct: 9, maxHoldMs: H }) as { trade: Trade }).trade.entry);
    assert.equal(f(0), 100);
    assert.equal(f(15), 100);
    assert.equal(f(30), 101);
  });
  it("not fillable when the price is already beyond the target; overlapping signals are skipped, not stacked", () => {
    const a = flat(100);
    const lv = { entry: 100, stop: 98, target: 99.5, targetBasis: "2R" as const, riskPct: 2, riskReward: 1, netRiskReward: 1 };
    const r = simulateSignals([{ symbol: "X", at: T0, levels: lv }], a, idx(a), { feePct: 0.1, slipPct: 0.05, delayMin: 5 }, { stopPct: 2, targetPct: 4, maxHoldMs: H });
    assert.equal(r.skippedNotFillable, 1);
    const r2 = simulateSignals([{ symbol: "X", at: T0, levels: null }, { symbol: "X", at: T0 + 2 * M5, levels: null }], a, idx(a), { feePct: 0, slipPct: 0, delayMin: 5 }, { stopPct: 2, targetPct: 4, maxHoldMs: H });
    assert.equal(r2.trades.length, 1);
    assert.equal(r2.skippedOverlap, 1);
  });
  it("firstBarrier reports which level is touched first and applies the stated tie rule", () => {
    const a = flat(10); a[2] = c(T0 + 2 * M5, 100, 101, 100, 101); a[3] = c(T0 + 3 * M5, 100, 100, 99, 99.5);
    assert.equal(firstBarrier(a, 0, 101, 99, H, "down"), "up");
    const b = flat(10); b[2] = c(T0 + 2 * M5, 100, 101, 99, 100);
    assert.equal(firstBarrier(b, 0, 101, 99, H, "down"), "down");
    assert.equal(firstBarrier(b, 0, 101, 99, H, "up"), "up");
    assert.equal(firstBarrier(flat(10), 0, 101, 99, H, "up"), "none");
  });
});

describe("back-test: statistics and the verdict rule", () => {
  const mk = (n: number, net: number, r: number, at = 0): Trade[] => Array.from({ length: n }, (_, i) => ({ symbol: "X", signalAt: at + i, entryAt: at + i, exitAt: at + i + 1, entry: 100, exit: 100 + net, reason: "target" as const, netPct: net, r }));
  it("stats on a known set", () => {
    const t = [...mk(3, 2, 1), ...mk(1, -1, -0.5, 10)];
    const s = statsOf(t);
    assert.equal(s.n, 4); assert.equal(s.winRatePct, 75); assert.equal(s.avgNetPct, 1.25); assert.equal(s.profitFactor, 6); assert.equal(s.losers, 1);
  });
  it("bootstrap is deterministic and brackets the mean", () => {
    const xs = Array.from({ length: 50 }, (_, i) => (i % 2 ? 1 : -0.5));
    const a = bootstrapMeanCI(xs), b = bootstrapMeanCI(xs);
    assert.deepEqual(a, b);
    assert.ok(a && a[0] < 0.25 && a[1] > 0.25);
  });
  it("fewer than 30 out-of-sample trades is INCONCLUSIVE even if every trade won", () => {
    const v = verdict(mk(29, 3, 2), mk(29, 2, 1.5));
    assert.equal(v.label, "INCONCLUSIVE");
  });
  it("30 consistent winners pass only the minimum screen", () => {
    const v = verdict(mk(40, 3, 2), mk(40, 2, 1.5));
    assert.equal(v.label, "SCREEN PASSED");
    assert.match(v.reasons[0], /not proof/);
  });
  it("a positive average whose interval includes zero is NOT VALIDATED", () => {
    const noisy = [...mk(20, 3, 2), ...mk(20, -2, -1.9, 100)];
    const v = verdict(noisy, noisy);
    assert.equal(v.label, "NOT VALIDATED");
  });
  it("positive at normal costs but negative when costs double is NOT VALIDATED", () => {
    const v = verdict(mk(40, 0.5, 0.4), mk(40, -0.2, -0.1));
    assert.equal(v.label, "NOT VALIDATED");
    assert.ok(v.reasons.some((r) => /costs doubled/.test(r)));
  });
  it("negative average is NOT VALIDATED", () => {
    assert.equal(verdict(mk(40, -1, -0.5), mk(40, -1.2, -0.6)).label, "NOT VALIDATED");
  });
});

describe("back-test: exit-warning verdict", () => {
  it("47% against a 47% random baseline is NOT better than chance", () => {
    assert.match(exitVerdict(1774, 833, 46.9), /^NOT VALIDATED/);
  });
  it("too few warnings is INCONCLUSIVE", () => {
    assert.match(exitVerdict(12, 11, 47), /^INCONCLUSIVE/);
  });
  it("a large, clear margin over the baseline is described only as better in this sample", () => {
    const v = exitVerdict(400, 240, 47);
    assert.match(v, /^Better than a random moment in this sample/);
    assert.match(v, /not proof/);
  });
});

describe("back-test: no look-ahead and honest reporting", () => {
  const data = walk(5, 12 * 24 * 70);
  const start = T0 + 40 * 24 * H;
  const end = T0 + 68 * 24 * H;
  it("signals found with data cut at time X equal the signals found up to X with all data", () => {
    const cutAt = start + 14 * 24 * H;
    const full = replay("X", data, null, { startMs: start, endMs: end });
    const cut = replay("X", data.filter((x) => x.start + M5 <= cutAt), null, { startMs: start, endMs: cutAt });
    const key = (s: { strategy: string; kind: string; at: number; price: number }) => `${s.strategy}|${s.kind}|${s.at}|${s.price.toFixed(8)}`;
    const fullBefore = full.sigs.filter((s) => s.at <= cutAt).map(key);
    assert.ok(cut.sigs.length > 0, "the scenario produces signals to compare");
    assert.deepEqual(cut.sigs.map(key), fullBefore);
  });
  it("the replay is deterministic", () => {
    const a = replay("X", data, null, { startMs: start, endMs: end }), b = replay("X", data, null, { startMs: start, endMs: end });
    assert.deepEqual(a.sigs, b.sigs);
  });
  it("a CONFIRMED signal never appears before a candle has closed, and always within 30 minutes of a close", () => {
    const r = replay("X", data, null, { startMs: start, endMs: end });
    const confirmed = r.sigs.filter((s) => s.kind === "CONFIRMED");
    for (const s of confirmed) assert.ok(s.at % H <= 30 * 60_000, `at ${new Date(s.at).toISOString()}`);
  });
  it("the report states plainly when there are fewer than 30 signals and never calls a small sample validated", () => {
    const r = replay("X", data, null, { startMs: start, endMs: end });
    const rep = buildReport([{ symbol: "X", c5: data, on: r, off: r }], { startMs: start, endMs: end });
    const text = formatReport(rep, "unit-test data");
    assert.match(text, /fewer than 30/);
    for (const row of rep.rows) if (row.outOfSample.n < 30) assert.equal(row.verdict.label, "INCONCLUSIVE");
    assert.doesNotMatch(text, /profitable|guaranteed profit/i);
  });
});
