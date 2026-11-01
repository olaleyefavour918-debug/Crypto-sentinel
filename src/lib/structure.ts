import type { Candle } from "./types";

/**
 * Market structure: swing pivots, higher-high/higher-low (and lower-high/lower-low) state, support/resistance zones,
 * breakouts, breakdowns and false breakouts. Pure functions on candle arrays; nothing here touches the network or a
 * database. Every definition is deliberately simple and documented so it can be tested and challenged.
 *
 * Pivots are only KNOWN `k` candles after they happen (a pivot needs `k` candles on each side), so structure lags the
 * market by design. The newest `k` candles can never be pivots.
 */

export const STRUCTURE = {
  pivotK1h: 3,
  pivotK4h: 2,
  lookback1h: 120,
  lookback4h: 90,
  /** Pivots within this many ATRs of each other form one zone. */
  clusterAtr: 0.5,
  /** A zone is widened by this many ATRs on each side. */
  padAtr: 0.25,
  /**
   * Zones wider than this (ATRs) are too vague to trade against. NOTE: with the current construction a zone is at most
   * clusterAtr + 2 * padAtr = 1.0 ATR wide, so this guard cannot trigger today (confirmed on 150 days of real data:
   * widest zone 1.00 ATR). It is kept, unchanged, as a safety net that becomes active if clustering or padding is ever
   * widened; `MAX_CONSTRUCTED_WIDTH_ATR` and a test pin that relationship so it cannot silently drift.
   */
  maxWidthAtr: 1.5,
  /** Tolerance (ATRs) when comparing pivots for higher/lower highs and lows. */
  trendTolAtr: 0.15,
  /** A breakout / breakdown needs a close this far (ATRs) beyond the zone... */
  breakAtr: 0.25,
  /** ...on at least this multiple of average volume. */
  breakVolume: 1.2,
  /** A breakout counts as false if price closes back inside within this many candles. */
  falseWithin: 3,
} as const;

/** Widest zone the current clustering + padding can produce, in ATRs (see `STRUCTURE.maxWidthAtr`). */
export const MAX_CONSTRUCTED_WIDTH_ATR = STRUCTURE.clusterAtr + 2 * STRUCTURE.padAtr;

export interface Pivot {
  index: number;
  start: number;
  price: number;
}

export function findPivots(c: Candle[], k: number, lookback: number): { highs: Pivot[]; lows: Pivot[] } {
  const highs: Pivot[] = [];
  const lows: Pivot[] = [];
  const from = Math.max(k, c.length - lookback);
  for (let i = from; i <= c.length - 1 - k; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= k; j++) {
      if (!(c[i].high > c[i - j].high && c[i].high >= c[i + j].high)) isHigh = false;
      if (!(c[i].low < c[i - j].low && c[i].low <= c[i + j].low)) isLow = false;
    }
    if (isHigh) highs.push({ index: i, start: c[i].start, price: c[i].high });
    if (isLow) lows.push({ index: i, start: c[i].start, price: c[i].low });
  }
  return { highs, lows };
}

export type StructureState = "UPTREND" | "DOWNTREND" | "RANGE" | "UNKNOWN";

export interface StructureReport {
  state: StructureState;
  higherHigh: boolean | null;
  higherLow: boolean | null;
  lastHigh: number | null;
  prevHigh: number | null;
  lastLow: number | null;
  prevLow: number | null;
  detail: string;
}

/** UPTREND = higher high AND higher low; DOWNTREND = lower high AND lower low; otherwise RANGE. Needs two pivots of each kind. */
export function structureState(p: { highs: Pivot[]; lows: Pivot[] }, atr: number): StructureReport {
  const h = p.highs.slice(-2);
  const l = p.lows.slice(-2);
  if (h.length < 2 || l.length < 2 || !(atr > 0)) {
    return { state: "UNKNOWN", higherHigh: null, higherLow: null, lastHigh: h[1]?.price ?? null, prevHigh: h[0]?.price ?? null, lastLow: l[1]?.price ?? null, prevLow: l[0]?.price ?? null, detail: "Fewer than two swing highs and two swing lows found." };
  }
  const tol = STRUCTURE.trendTolAtr * atr;
  const hh = h[1].price > h[0].price + tol;
  const lh = h[1].price < h[0].price - tol;
  const hl = l[1].price > l[0].price + tol;
  const ll = l[1].price < l[0].price - tol;
  const state: StructureState = hh && hl ? "UPTREND" : lh && ll ? "DOWNTREND" : "RANGE";
  const word = (up: boolean, down: boolean, u: string, d: string) => (up ? u : down ? d : "flat");
  return {
    state,
    higherHigh: hh ? true : lh ? false : null,
    higherLow: hl ? true : ll ? false : null,
    lastHigh: h[1].price,
    prevHigh: h[0].price,
    lastLow: l[1].price,
    prevLow: l[0].price,
    detail: `Swing highs: ${word(hh, lh, "higher high", "lower high")}; swing lows: ${word(hl, ll, "higher low", "lower low")}.`,
  };
}

export interface Zone {
  low: number;
  high: number;
  touches: number;
  /** Start time of the most recent pivot in the zone. */
  lastTouch: number;
  established: boolean;
}

/** Clusters pivot prices (highs AND lows: a broken support often becomes resistance) into zones. */
export function buildZones(pivots: Pivot[], atr: number): Zone[] {
  if (!(atr > 0) || pivots.length === 0) return [];
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const groups: Pivot[][] = [];
  for (const p of sorted) {
    const g = groups[groups.length - 1];
    if (g && p.price - g[0].price <= STRUCTURE.clusterAtr * atr) g.push(p);
    else groups.push([p]);
  }
  return groups.map((g) => {
    const lo = g[0].price - STRUCTURE.padAtr * atr;
    const hi = g[g.length - 1].price + STRUCTURE.padAtr * atr;
    return {
      low: lo,
      high: hi,
      touches: g.length,
      lastTouch: Math.max(...g.map((x) => x.start)),
      established: g.length >= 2 && hi - lo <= STRUCTURE.maxWidthAtr * atr,
    };
  });
}

/** Nearest established zone that acts as support for `price` (its top is at or below price + 0.5 ATR); the highest such zone. */
export function nearestSupport(zones: Zone[], price: number, atr: number): Zone | null {
  const c = zones.filter((z) => z.established && z.high <= price + 0.5 * atr);
  return c.sort((a, b) => b.high - a.high)[0] ?? null;
}

/** Nearest established zone that acts as resistance (its bottom is at or above price − 0.5 ATR); the lowest such zone. */
export function nearestResistance(zones: Zone[], price: number, atr: number): Zone | null {
  const c = zones.filter((z) => z.established && z.low >= price - 0.5 * atr);
  return c.sort((a, b) => a.low - b.low)[0] ?? null;
}

/** Volume of candle i divided by the average of the 20 candles before it (null if there is no usable average). */
export function volumeRatio(c: Candle[], i: number): number | null {
  const prev = c.slice(Math.max(0, i - 20), i);
  if (prev.length < 10) return null;
  const avg = prev.reduce((a, x) => a + x.volume, 0) / prev.length;
  return avg > 0 ? c[i].volume / avg : null;
}

/**
 * A candle that is still forming has only part of its volume. After 25% of the candle has passed the volume is
 * projected linearly; before that the volume is NOT usable and null is returned (shown as "pending").
 */
export function projectedVolume(volume: number, elapsedFraction: number): number | null {
  if (!(elapsedFraction >= 0.25)) return null;
  return volume / Math.min(1, elapsedFraction);
}

export interface BreakReport {
  /** Closed candle beyond the zone on strong volume (index into the candles, or null). */
  breakoutUp: number | null;
  breakdownDown: number | null;
  /** The breakout above a resistance zone did not hold (price closed back inside within the window), or a wick poked out and closed inside. */
  falseBreakout: boolean;
  rejectionAbove: boolean;
  /** Mirror images below a support zone. A false breakdown (bear trap) is bullish evidence. */
  falseBreakdown: boolean;
  rejectionBelow: boolean;
}

/**
 * Looks at the last `window` candles (the last one may be a forming candle: the caller decides what that means).
 * Breakout = close > zone.high + 0.25 ATR on volume >= 1.2x average. False breakout = a close above the zone followed,
 * within 3 candles, by a close back at or below the zone's top.
 */
export function classifyBreaks(c: Candle[], zone: Zone | null, atr: number, side: "resistance" | "support", window = 6): BreakReport {
  const none: BreakReport = { breakoutUp: null, breakdownDown: null, falseBreakout: false, rejectionAbove: false, falseBreakdown: false, rejectionBelow: false };
  if (!zone || !(atr > 0) || c.length < 22) return none;
  const out = { ...none };
  const start = Math.max(1, c.length - window);
  const pad = STRUCTURE.breakAtr * atr;
  for (let i = start; i < c.length; i++) {
    const vr = volumeRatio(c, i);
    const strong = vr !== null && vr >= STRUCTURE.breakVolume;
    if (side === "resistance") {
      if (c[i].close > zone.high + pad && strong) {
        out.breakoutUp = i;
        for (let j = i + 1; j <= Math.min(c.length - 1, i + STRUCTURE.falseWithin); j++) if (c[j].close <= zone.high) out.falseBreakout = true;
      }
      if (c[i].high > zone.high && c[i].close <= zone.high) out.rejectionAbove = true;
    } else {
      if (c[i].close < zone.low - pad && strong) {
        out.breakdownDown = i;
        for (let j = i + 1; j <= Math.min(c.length - 1, i + STRUCTURE.falseWithin); j++) if (c[j].close >= zone.low) out.falseBreakdown = true;
      }
      if (c[i].low < zone.low && c[i].close >= zone.low) out.rejectionBelow = true;
    }
  }
  return out;
}
