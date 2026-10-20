import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkContinuity, closedCandles, evaluateBuy, evaluateExit, expectedLastClosedStart, requiredCandles } from "@/lib/rules";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { H1, H4, NOW, downMarket, makeCandles, signalMarket } from "./helpers/fixtures";
import type { OpenPositionLike } from "@/lib/types";

const S = DEFAULT_SETTINGS;
const failed = (ev: ReturnType<typeof evaluateBuy>) => ev.conditions.filter((c) => !c.passed).map((c) => c.id);

describe("closed candles", () => {
  it("requires 150 candles with default settings (3× the longest lookback)", () => assert.equal(requiredCandles(S), 150));
  it("drops the still-forming candle and de-duplicates", () => {
    const { h1 } = signalMarket();
    const forming = { ...h1[h1.length - 1], start: Math.floor(NOW / H1) * H1 };
    const out = closedCandles([forming, ...h1, h1[3]], H1, NOW);
    assert.equal(out.length, h1.length);
    assert.equal(out[out.length - 1].start, Math.floor(NOW / H1) * H1 - H1);
    assert.ok(out.every((c, i) => i === 0 || c.start > out[i - 1].start));
  });
});

describe("BUY rule (1h signal + 4h confirmation)", () => {
  it("signals when every condition passes, and explains each one", () => {
    const { h1, h4 } = signalMarket();
    const ev = evaluateBuy({ h1, h4, now: NOW, settings: S });
    assert.equal(ev.status, "SIGNAL");
    assert.equal(ev.conditions.length, 7);
    assert.ok(ev.conditions.every((c) => c.passed && c.evaluated));
    assert.ok(ev.indicators.h1.rsi! >= 50 && ev.indicators.h1.rsi! <= 65);
    assert.ok(ev.indicators.h1.macdHist! > 0);
    assert.ok(ev.indicators.h1.emaFast! > ev.indicators.h1.emaSlow!);
    assert.equal(ev.h1CandleStart, Math.floor(NOW / H1) * H1 - H1);
  });
  it("fails when the 4h trend is down (even if the 1h setup is fine)", () => {
    const { h1 } = signalMarket();
    const { h4 } = downMarket();
    const ev = evaluateBuy({ h1, h4, now: NOW, settings: S });
    assert.equal(ev.status, "NO_SIGNAL");
    assert.deepEqual(failed(ev), ["h4_ema_trend"]);
  });
  it("fails when the 1h EMA trend is down", () => {
    const { h4 } = signalMarket();
    const ev = evaluateBuy({ h1: downMarket().h1, h4, now: NOW, settings: S });
    assert.equal(ev.status, "NO_SIGNAL");
    assert.ok(failed(ev).includes("h1_ema_trend"));
  });
  it("fails when RSI is outside the configured band (both sides)", () => {
    const { h1, h4 } = signalMarket();
    assert.deepEqual(failed(evaluateBuy({ h1, h4, now: NOW, settings: { ...S, rsiMax: 50.5 } })), ["h1_rsi_range"]);
    assert.deepEqual(failed(evaluateBuy({ h1, h4, now: NOW, settings: { ...S, rsiMin: 60, rsiMax: 70 } })), ["h1_rsi_range"]);
  });
  it("fails when the MACD histogram is not positive", () => {
    const { h4 } = signalMarket();
    const h1 = makeCandles(220, Math.floor(NOW / H1) * H1, H1, (i) => 60000 + 8 * i + 200 * Math.sin(i / 2.2)); // phase puts hist < 0
    const ev = evaluateBuy({ h1, h4, now: NOW, settings: S });
    assert.ok(failed(ev).includes("h1_macd_hist"));
    assert.equal(ev.status, "NO_SIGNAL");
  });
});

describe("data-quality gates never allow a signal", () => {
  it("too few completed candles → DATA_INVALID", () => {
    const { h1, h4 } = signalMarket();
    const ev = evaluateBuy({ h1: h1.slice(-100), h4, now: NOW, settings: S });
    assert.equal(ev.status, "DATA_INVALID");
    assert.ok(failed(ev).includes("data_enough"));
    assert.ok(ev.conditions.filter((c) => c.id.startsWith("h")).every((c) => !c.evaluated));
  });
  it("a missing candle inside the lookback window → DATA_INVALID", () => {
    const { h1, h4 } = signalMarket();
    const holes = h1.filter((_, i) => i !== h1.length - 20);
    const ev = evaluateBuy({ h1: holes, h4, now: NOW, settings: S });
    assert.equal(ev.status, "DATA_INVALID");
    assert.ok(failed(ev).includes("data_continuous"));
  });
  it("stale data (no new candle for 3 hours) → DATA_INVALID", () => {
    const { h1, h4 } = signalMarket();
    const ev = evaluateBuy({ h1, h4, now: NOW + 3 * H1, settings: S });
    assert.equal(ev.status, "DATA_INVALID");
    assert.ok(failed(ev).includes("data_fresh"));
  });
  it("stale 4h data alone also blocks the signal", () => {
    const { h1 } = signalMarket();
    const h4 = signalMarket(NOW - 8 * H1).h4; // two 4h candles behind
    assert.equal(evaluateBuy({ h1, h4, now: NOW, settings: S }).status, "DATA_INVALID");
  });
  it("empty input is DATA_INVALID, never a signal", () => {
    assert.equal(evaluateBuy({ h1: [], h4: [], now: NOW, settings: S }).status, "DATA_INVALID");
  });
  it("tolerates the short grace period right after an hourly close", () => {
    const t = Math.floor(NOW / H1) * H1 + 30_000; // 15:00:30 — the 14:00 candle may not be published yet
    assert.equal(expectedLastClosedStart(t, H1), Math.floor(NOW / H1) * H1 - 2 * H1);
    assert.equal(expectedLastClosedStart(t + 150_000, H1), Math.floor(NOW / H1) * H1 - H1);
  });
  it("checkContinuity reports the gap position", () => {
    const c = makeCandles(10, 10 * H1, H1, () => 1);
    c.splice(5, 1);
    const r = checkContinuity(c, H1, 9);
    assert.equal(r.ok, false);
    assert.equal(r.gapAt, c[5].start);
  });
});

describe("SELL / exit rules", () => {
  const pos: OpenPositionLike = { entryPrice: 100, quantity: 0.1, amountUsdt: 10, openedAt: NOW, stopLossPct: 2, takeProfitPct: 4, trendExitEnabled: false };
  it("holds while price is between the thresholds", () => assert.equal(evaluateExit({ position: pos, currentPrice: 101, h1: null }).exit, false));
  it("exits on the downside threshold (inclusive)", () => {
    const d = evaluateExit({ position: pos, currentPrice: 98, h1: null });
    assert.deepEqual([d.exit, d.reason], [true, "STOP_LOSS"]);
  });
  it("exits on the upside threshold (inclusive)", () => {
    const d = evaluateExit({ position: pos, currentPrice: 104, h1: null });
    assert.deepEqual([d.exit, d.reason], [true, "TAKE_PROFIT"]);
  });
  it("does not exit just below the thresholds", () => {
    assert.equal(evaluateExit({ position: pos, currentPrice: 98.01, h1: null }).exit, false);
    assert.equal(evaluateExit({ position: pos, currentPrice: 103.99, h1: null }).exit, false);
  });
  it("uses the thresholds frozen in the position, not today's settings", () => {
    const wide = { ...pos, stopLossPct: 10, takeProfitPct: 20 };
    assert.equal(evaluateExit({ position: wide, currentPrice: 95, h1: null }).exit, false);
  });
  it("optional trend-change exit only fires when enabled and the candle closed after entry", () => {
    const bearish = { candleStart: NOW - H1, close: 100, emaFast: 99, emaSlow: 100, rsi: 40, macd: -1, macdSignal: 0, macdHist: -1, atr: 1 };
    assert.equal(evaluateExit({ position: pos, currentPrice: 100.5, h1: bearish }).exit, false); // disabled
    const on = { ...pos, trendExitEnabled: true };
    assert.equal(evaluateExit({ position: on, currentPrice: 100.5, h1: { ...bearish, candleStart: NOW } }).reason, "TREND_CHANGE");
    assert.equal(evaluateExit({ position: { ...on, openedAt: NOW + 2 * H1 }, currentPrice: 100.5, h1: bearish }).exit, false); // candle closed before entry
  });
  it("never exits on an invalid price", () => {
    for (const p of [0, -1, NaN, Infinity]) assert.equal(evaluateExit({ position: pos, currentPrice: p, h1: null }).exit, false);
  });
  it("works for sub-$1 coins", () => {
    const xrp = { ...pos, entryPrice: 0.5 };
    assert.equal(evaluateExit({ position: xrp, currentPrice: 0.52, h1: null }).reason, "TAKE_PROFIT");
    assert.equal(evaluateExit({ position: xrp, currentPrice: 0.49, h1: null }).reason, "STOP_LOSS");
  });
});

void H4;
