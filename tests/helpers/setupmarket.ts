import type { Candle } from "@/lib/types";
import { H1, H4, rng, toFourHour } from "./market";

export { H1, H4 };
/** Piecewise-linear path through [index, price] anchors, with deterministic tiny noise so swing pivots are strict. */
export function pathAt(anchors: Array<[number, number]>, i: number): number {
  for (let k = 1; k < anchors.length; k++) {
    const [i0, p0] = anchors[k - 1], [i1, p1] = anchors[k];
    if (i <= i1) return p0 + ((p1 - p0) * (i - i0)) / Math.max(1, i1 - i0);
  }
  return anchors[anchors.length - 1][1];
}

export interface PathOpts { n: number; endStart: number; anchors: Array<[number, number]>; seed?: number; wick?: number; volume?: (i: number) => number; noise?: number }

/** Hourly candles following a price path. `endStart` is the START time of the last candle. */
export function candlesFromPath(o: PathOpts): Candle[] {
  const r = rng(o.seed ?? 7);
  const wick = o.wick ?? 0.25;
  const noise = o.noise ?? 0.08;
  const out: Candle[] = [];
  let prev = pathAt(o.anchors, 0);
  for (let i = 0; i < o.n; i++) {
    const close = pathAt(o.anchors, i) + (r() - 0.5) * noise;
    const hi = Math.max(prev, close) + wick * (0.4 + r());
    const lo = Math.min(prev, close) - wick * (0.4 + r());
    out.push({ start: o.endStart - (o.n - 1 - i) * H1, open: prev, high: hi, low: lo, close, volume: o.volume ? o.volume(i) : 100, turnover: 0 });
    prev = close;
  }
  return out;
}

export const hourStart = (t: number) => Math.floor(t / H1) * H1;

/** 4H candles from hourly ones (complete groups only). */
export const to4h = (h1: Candle[]) => toFourHour(h1);

import type { EvalInput } from "@/lib/setups";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { NOW } from "./fixtures";

export interface Scenario { h1Closed: Candle[]; h4Closed: Candle[]; forming: Candle | null; now: number }

function rangeAnchors(): { anchors: Array<[number, number]>; idx: number } {
  const anchors: Array<[number, number]> = [[0, 105]];
  let idx = 0;
  for (let k = 0; k < 24; k++) { idx += 14; anchors.push([idx, 110]); idx += 14; anchors.push([idx, 100]); }
  return { anchors, idx };
}

function finish(h1all: Candle[], forming: boolean, now: number): Scenario {
  const h4 = to4h(h1all).filter((c) => c.start + H4 <= now);
  if (forming) return { h1Closed: h1all.slice(0, -1).slice(-400), h4Closed: h4, forming: h1all[h1all.length - 1], now };
  return { h1Closed: h1all.slice(-400), h4Closed: h4, forming: null, now };
}

/**
 * A long 100–110 range (so 100 is an established support and 110 an established resistance), then a drop into support
 * and a 3-candle bounce on rising volume. `forming` makes the final candle the unfinished one.
 */
export function bounceScenario(o: { forming?: boolean; now?: number; volume?: number; noBounceCandle?: boolean } = {}): Scenario {
  const now = o.now ?? NOW;
  const { anchors, idx0 } = (() => { const r = rangeAnchors(); return { anchors: r.anchors, idx0: r.idx }; })();
  let idx = idx0;
  idx += 14; anchors.push([idx, 110]);
  idx += 12; anchors.push([idx, 100.2]);
  const steps = 3;
  for (let q = 1; q <= steps; q++) anchors.push([idx + q, o.noBounceCandle ? 100.2 - 0.05 * q : 100.2 + 0.4 * q]);
  const total = idx + steps + 1;
  const endStart = o.forming ? hourStart(now) : hourStart(now) - H1;
  const vol = o.volume ?? 160;
  const h1 = candlesFromPath({ n: total, endStart, anchors, volume: (i) => (i >= total - 2 ? vol : 100) });
  if (o.forming) {
    const el = Math.max(0, Math.min(1, (now - hourStart(now)) / H1));
    const L = h1[h1.length - 1];
    h1[h1.length - 1] = { ...L, volume: L.volume * el };
  }
  return finish(h1, !!o.forming, now);
}

/** The mirror: a rally into the 110 resistance, a few weakening candles, then a shooting-star rejection on high volume. */
export function exitScenario(o: { now?: number; noStar?: boolean; steadyRise?: boolean } = {}): Scenario {
  const now = o.now ?? NOW;
  const r = rangeAnchors();
  const anchors = r.anchors;
  let idx = r.idx;
  idx += 14; anchors.push([idx, 109.6]);
  const steps = 3;
  for (let q = 1; q <= steps; q++) anchors.push([idx + q, 109.6 - 0.15 * q]);
  const total = idx + steps + 1;
  const h1 = candlesFromPath({ n: total, endStart: hourStart(now) - H1, anchors, volume: (i) => (i >= total - 2 ? 170 : 100) });
  if (!o.noStar) {
    const L = h1[h1.length - 1], pc = h1[h1.length - 2];
    const open = pc.close, close = open - 0.08;
    h1[h1.length - 1] = { ...L, open, close, high: open + 1.0, low: close - 0.05 };
  }
  return finish(h1, false, now);
}

/** A steadily rising market with no established resistance and no rejection: "price rose" must not be a SELL warning. */
export function steadyRiseScenario(now = NOW): Scenario {
  const h1 = candlesFromPath({ n: 700, endStart: hourStart(now) - H1, anchors: [[0, 50], [699, 150]], seed: 3 });
  return finish(h1, false, now);
}

/** A steadily falling market: "price fell" must not be a BUY. */
export function steadyFallScenario(now = NOW): Scenario {
  const h1 = candlesFromPath({ n: 700, endStart: hourStart(now) - H1, anchors: [[0, 150], [699, 50]], seed: 5 });
  return finish(h1, false, now);
}

export const toInput = (sc: Scenario, over: Partial<EvalInput> = {}): EvalInput => ({
  symbol: "SOLUSDT", h1Closed: sc.h1Closed, h4Closed: sc.h4Closed, forming: sc.forming, now: sc.now, settings: DEFAULT_SETTINGS, ...over,
});

/** BTC-like 4H candles in a clear downtrend: every swing high and swing low is lower than the one before. */
export function btcDowntrend4h(now = NOW): Candle[] {
  const anchors: Array<[number, number]> = [[0, 150]];
  let idx = 0;
  for (let k = 0; k < 29; k++) { idx += 12; anchors.push([idx, 140 - 3.5 * k]); idx += 12; anchors.push([idx, 148 - 3.5 * (k + 1)]); }
  const h1 = candlesFromPath({ n: idx + 1, endStart: hourStart(now) - H1, anchors, seed: 11 });
  return to4h(h1).filter((c) => c.start + H4 <= now);
}
