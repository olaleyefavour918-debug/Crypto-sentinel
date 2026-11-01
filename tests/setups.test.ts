import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildZones, classifyBreaks, findPivots, nearestResistance, nearestSupport, projectedVolume, structureState, volumeRatio, type Zone } from "@/lib/structure";
import { evaluateBounce, evaluateExitWarning, evaluateTrendSetup, STRATEGIES, evaluateStrategy } from "@/lib/setups";
import type { Candle } from "@/lib/types";
import { H1, btcDowntrend4h, bounceScenario, candlesFromPath, exitScenario, steadyFallScenario, steadyRiseScenario, toInput } from "./helpers/setupmarket";
import { signalMarket, downMarket, NOW } from "./helpers/fixtures";

const ids = (e: { conditions: Array<{ id: string; passed: boolean }> }) => e.conditions.filter((c) => !c.passed).map((c) => c.id);
const mk = (start: number, o: number, h: number, l: number, c: number, v = 100): Candle => ({ start, open: o, high: h, low: l, close: c, volume: v, turnover: 0 });

describe("market structure: pivots, trend state, zones", () => {
  it("finds strict swing highs and lows only once k candles exist on each side", () => {
    const c = [5, 6, 7, 9, 7, 6, 5, 4, 3, 4, 5, 6].map((p, i) => mk(i * H1, p, p + 0.2, p - 0.2, p));
    const { highs, lows } = findPivots(c, 2, 50);
    assert.deepEqual(highs.map((p) => p.index), [3]);
    assert.deepEqual(lows.map((p) => p.index), [8]);
    assert.equal(findPivots(c.slice(0, 5), 2, 50).highs.length, 0, "too young to be a pivot");
  });
  it("labels higher highs + higher lows as an UPTREND and lower highs + lower lows as a DOWNTREND", () => {
    const up = structureState({ highs: [{ index: 1, start: 1, price: 10 }, { index: 2, start: 2, price: 12 }], lows: [{ index: 1, start: 1, price: 8 }, { index: 2, start: 2, price: 9 }] }, 1);
    assert.equal(up.state, "UPTREND");
    assert.equal(up.higherHigh, true);
    assert.equal(up.higherLow, true);
    const dn = structureState({ highs: [{ index: 1, start: 1, price: 12 }, { index: 2, start: 2, price: 10 }], lows: [{ index: 1, start: 1, price: 9 }, { index: 2, start: 2, price: 8 }] }, 1);
    assert.equal(dn.state, "DOWNTREND");
    const mixed = structureState({ highs: [{ index: 1, start: 1, price: 10 }, { index: 2, start: 2, price: 12 }], lows: [{ index: 1, start: 1, price: 9 }, { index: 2, start: 2, price: 8 }] }, 1);
    assert.equal(mixed.state, "RANGE");
    assert.equal(structureState({ highs: [], lows: [] }, 1).state, "UNKNOWN");
  });
  it("clusters nearby pivots into zones; one touch is not 'established'; far-apart prices do not merge", () => {
    const pv = (price: number, i: number) => ({ index: i, start: i, price });
    const zones = buildZones([pv(100, 1), pv(100.2, 2), pv(110, 3), pv(130, 4), pv(130.1, 5)], 1);
    assert.equal(zones.length, 3);
    assert.equal(zones[0].touches, 2);
    assert.equal(zones[0].established, true);
    assert.equal(zones[1].established, false);
    assert.ok(zones[0].low < 100 && zones[0].high > 100.2, "zone is padded by 0.25 ATR each side");
  });
  it("picks the nearest support below and the nearest resistance above", () => {
    const z = (low: number, high: number): Zone => ({ low, high, touches: 3, lastTouch: 0, established: true });
    const zones = [z(90, 91), z(99, 100), z(110, 111), z(120, 121)];
    assert.equal(nearestSupport(zones, 101, 1)?.low, 99);
    assert.equal(nearestResistance(zones, 101, 1)?.low, 110);
    assert.equal(nearestSupport([{ ...z(99, 100), established: false }], 101, 1), null);
  });
  it("volume ratio compares to the previous 20 candles; forming-candle volume is unusable before 25% elapsed", () => {
    const c = Array.from({ length: 30 }, (_, i) => mk(i * H1, 1, 2, 0.5, 1, i === 29 ? 300 : 100));
    assert.equal(volumeRatio(c, 29), 3);
    assert.equal(volumeRatio(c.slice(0, 5), 4), null);
    assert.equal(projectedVolume(50, 0.1), null);
    assert.equal(projectedVolume(50, 0.5), 100);
  });
});

describe("breakouts, breakdowns and false breakouts", () => {
  const zone: Zone = { low: 109.5, high: 110.5, touches: 3, lastTouch: 0, established: true };
  const base = Array.from({ length: 30 }, (_, i) => mk(i * H1, 105, 106, 104, 105, 100));
  it("a strong close above resistance on volume is a breakout, and holding it is not false", () => {
    const c = [...base, mk(30 * H1, 105, 112, 105, 111.5, 200), mk(31 * H1, 111.5, 112, 111, 111.8, 120)];
    const r = classifyBreaks(c, zone, 1, "resistance");
    assert.equal(r.breakoutUp, 30);
    assert.equal(r.falseBreakout, false);
  });
  it("closing back inside the zone within 3 candles makes it a FALSE breakout", () => {
    const c = [...base, mk(30 * H1, 105, 112, 105, 111.5, 200), mk(31 * H1, 111.5, 111.6, 108, 109.8, 150)];
    assert.equal(classifyBreaks(c, zone, 1, "resistance").falseBreakout, true);
  });
  it("a close above the zone on WEAK volume is not a breakout", () => {
    const c = [...base, mk(30 * H1, 105, 112, 105, 111.5, 50)];
    assert.equal(classifyBreaks(c, zone, 1, "resistance").breakoutUp, null);
  });
  it("a wick above resistance that closes inside is a rejection", () => {
    const c = [...base, mk(30 * H1, 108, 112, 107.5, 109, 120)];
    assert.equal(classifyBreaks(c, zone, 1, "resistance").rejectionAbove, true);
  });
  it("breakdowns and false breakdowns (bear traps) mirror this below support", () => {
    const sup: Zone = { low: 99.5, high: 100.5, touches: 3, lastTouch: 0, established: true };
    const down = [...base, mk(30 * H1, 102, 102, 97, 98, 220)];
    assert.equal(classifyBreaks(down, sup, 1, "support").breakdownDown, 30);
    const trap = [...down, mk(31 * H1, 98, 101.5, 97.8, 101, 150)];
    assert.equal(classifyBreaks(trap, sup, 1, "support").falseBreakdown, true);
    const wick = [...base, mk(30 * H1, 102, 102, 98.5, 101, 120)];
    assert.equal(classifyBreaks(wick, sup, 1, "support").rejectionBelow, true);
  });
});

describe("Support-Bounce strategy", () => {
  it("all conditions can pass (4H-conflict check off) and the result carries levels and reasons", () => {
    const e = evaluateBounce(toInput(bounceScenario(), { h4Conflict: false }));
    assert.deepEqual(ids(e), []);
    assert.equal(e.context && e.potential && e.full, true);
    assert.ok(e.levels && e.levels.stop < e.levels.entry && e.levels.target > e.levels.entry);
    assert.ok(e.levels!.netRiskReward >= 1.3);
    assert.ok(e.reasons.length >= 8);
  });
  it("by default the 4H-momentum conflict check blocks a bounce while 4H momentum is still falling", () => {
    const e = evaluateBounce(toInput(bounceScenario()));
    assert.deepEqual(ids(e), ["b5_h4_momentum"]);
    assert.equal(e.context, true, "still WATCH");
    assert.equal(e.potential, false);
    assert.equal(e.full, false);
  });
  it("a price that has merely FALLEN is never a bounce (no support, no recovery)", () => {
    const e = evaluateBounce(toInput(steadyFallScenario(), { h4Conflict: false }));
    assert.equal(e.potential, false);
    assert.equal(e.full, false);
  });
  it("needs evidence of recovery: without a reversal candle it is not CONFIRMED", () => {
    const e = evaluateBounce(toInput(bounceScenario({ noBounceCandle: true }), { h4Conflict: false }));
    assert.equal(e.full, false);
    assert.ok(ids(e).includes("b8_reversal") || ids(e).includes("b6_rsi") || ids(e).includes("b7_macd"));
  });
  it("weak volume blocks the CONFIRMED level", () => {
    const e = evaluateBounce(toInput(bounceScenario({ volume: 60 }), { h4Conflict: false }));
    assert.ok(ids(e).includes("b9_volume"));
    assert.equal(e.full, false);
  });
  it("a close below support is a breakdown, not a bounce", () => {
    const sc = bounceScenario();
    const h = [...sc.h1Closed];
    const L = h[h.length - 1];
    h[h.length - 1] = { ...L, close: 96, low: 95.5, open: h[h.length - 2].close };
    const e = evaluateBounce(toInput({ ...sc, h1Closed: h }, { h4Conflict: false }));
    assert.ok(ids(e).includes("b3_holding"));
    assert.equal(e.potential, false);
  });
  it("the BTC guard blocks altcoin bounces when BTC is in a 4H downtrend below its trend line", () => {
    const btc = btcDowntrend4h();
    const e = evaluateBounce(toInput(bounceScenario(), { h4Conflict: false, btcH4: btc }));
    assert.ok(ids(e).includes("b11_btc"));
    assert.equal(e.potential, false);
    const btcOwn = evaluateBounce(toInput(bounceScenario(), { h4Conflict: false, symbol: "BTCUSDT", btcH4: btc }));
    assert.equal(btcOwn.conditions.find((c) => c.id === "b11_btc")?.passed, true, "not applied to BTC itself");
  });
  it("delayed market data produces no evaluation at all", () => {
    const e = evaluateBounce(toInput(bounceScenario(), { now: NOW + 4 * H1, h4Conflict: false }));
    assert.equal(e.dataOk, false);
    assert.match(e.dataIssue ?? "", /delayed/i);
    assert.equal(e.potential, false);
  });
});

describe("forming (unfinished) candles are never CONFIRMED", () => {
  const at = (sc: ReturnType<typeof bounceScenario>, frac: number) => ({ ...sc, now: Math.floor(sc.now / H1) * H1 + frac * H1 });
  it("before 25% of the candle has passed, volume is pending and nothing is POTENTIAL on volume alone", () => {
    const sc = at(bounceScenario({ forming: true, now: NOW }), 0.1);
    const e = evaluateBounce(toInput(sc, { h4Conflict: false }));
    assert.equal(e.full, false);
    const vol = e.conditions.find((c) => c.id === "b9_volume");
    assert.match(vol?.detail ?? "", /Pending|pending|up-candle/);
  });
  it("after 25% the preview can reach POTENTIAL but full stays false (cannot be CONFIRMED)", () => {
    const sc = bounceScenario({ forming: true, now: Math.floor(NOW / H1) * H1 + 0.5 * H1 });
    const e = evaluateBounce(toInput(sc, { h4Conflict: false }));
    assert.equal(e.potential, true);
    assert.equal(e.full, false, "an unfinished candle can never be confirmed");
  });
  it("the same holds for the exit warning and the trend strategy", () => {
    const sc = exitScenario();
    const closed = evaluateExitWarning(toInput(sc));
    assert.equal(closed.full, true);
    const forming = { ...sc.h1Closed[sc.h1Closed.length - 1], start: sc.h1Closed[sc.h1Closed.length - 1].start + H1 };
    const prev = evaluateExitWarning(toInput({ ...sc, forming, now: forming.start + 0.5 * H1 }));
    assert.equal(prev.full, false);
    const { h1, h4 } = signalMarket();
    const t = evaluateTrendSetup({ symbol: "BTCUSDT", h1Closed: h1.slice(0, -1), h4Closed: h4, forming: h1[h1.length - 1], now: h1[h1.length - 1].start + 0.5 * H1, settings: toInput(sc).settings });
    assert.equal(t.full, false);
  });
});

describe("Exit warning strategy", () => {
  it("fires at resistance with RSI roll-over, MACD weakening, a rejection candle and volume, and lists every check", () => {
    const e = evaluateExitWarning(toInput(exitScenario()));
    assert.equal(e.context && e.potential && e.full, true);
    for (const id of ["e1_resistance", "e3_macd", "e4_reversal", "e5_volume"]) assert.equal(e.conditions.find((c) => c.id === id)?.passed, true, id);
    assert.equal(e.variant, "resistance");
    assert.equal(e.levels, null, "an exit warning has no entry/stop/target and never touches a paper trade");
  });
  it("price that merely ROSE (no resistance zone, no rejection) is not a warning", () => {
    const e = evaluateExitWarning(toInput(steadyRiseScenario()));
    assert.equal(e.context, false);
    assert.equal(e.potential, false);
    assert.equal(e.full, false);
  });
  it("without actual bearish price evidence (no rejection candle or false breakout) it is at most WATCH", () => {
    const e = evaluateExitWarning(toInput(exitScenario({ noStar: true })));
    assert.equal(e.potential, false);
    assert.equal(e.full, false);
  });
  it("a volume-backed breakdown below support is a warning on its own (closed candles only)", () => {
    const sc = bounceScenario();
    const h = [...sc.h1Closed];
    const L = h[h.length - 1];
    h[h.length - 1] = { ...L, open: h[h.length - 2].close, close: 96, low: 95.5, volume: 300 };
    const e = evaluateExitWarning(toInput({ ...sc, h1Closed: h }));
    assert.equal(e.conditions.find((c) => c.id === "e8_breakdown")?.passed, true);
    assert.equal(e.variant, "breakdown");
    assert.equal(e.full, true);
  });
});

describe("Trend BUY wrapper keeps the existing rule exactly", () => {
  it("matches evaluateBuy: SIGNAL on the fixture uptrend, nothing on a downtrend", () => {
    const up = signalMarket();
    const sig = evaluateTrendSetup({ symbol: "BTCUSDT", h1Closed: up.h1, h4Closed: up.h4, forming: null, now: NOW, settings: toInput(exitScenario()).settings });
    assert.equal(sig.full, true);
    assert.equal(sig.conditions.length, 13);
    const dn = downMarket();
    const none = evaluateTrendSetup({ symbol: "BTCUSDT", h1Closed: dn.h1, h4Closed: dn.h4, forming: null, now: NOW, settings: toInput(exitScenario()).settings });
    assert.equal(none.full, false);
    assert.equal(none.context, false);
  });
  it("evaluateStrategy dispatches to all three strategies without throwing on thin data", () => {
    const thin = candlesFromPath({ n: 30, endStart: Math.floor(NOW / H1) * H1 - H1, anchors: [[0, 1], [29, 2]] });
    for (const s of STRATEGIES) {
      const e = evaluateStrategy(s, { symbol: "ETHUSDT", h1Closed: thin, h4Closed: [], forming: null, now: NOW, settings: toInput(exitScenario()).settings });
      assert.equal(e.dataOk, false);
      assert.equal(e.potential || e.full || e.context, false);
    }
  });
});
