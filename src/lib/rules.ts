import { fmtPrice } from "./format";
import { atr, ema, macd, rsi, type Series } from "./indicators";
import { fmtUtcShort } from "./time";
import {
  INTERVAL_MS,
  type BuyEvaluation,
  type Candle,
  type Condition,
  type ExitDecision,
  type OpenPositionLike,
  type Settings,
  type TimeframeSnapshot,
} from "./types";

/** Tolerance after a candle boundary before a missing "just closed" candle counts as stale. */
export const CANDLE_GRACE_MS = 120_000;
/** A ticker (last price) older than this is not used for entries or exits. */
export const MAX_TICKER_AGE_MS = 120_000;

/** How many closed candles are needed for the indicator settings to be trustworthy (3× longest lookback). */
export function requiredCandles(s: Settings): number {
  return Math.max(s.emaSlow, s.macdSlow + s.macdSignal, s.rsiPeriod + 1, s.atrPeriod + 1) * 3;
}

/** How many candles to request from the exchange per timeframe (max 1000 per Bybit call). */
export function candlesToFetch(s: Settings): number {
  return Math.min(1000, requiredCandles(s) + 50);
}

/** Keeps only fully closed candles (start + interval ≤ now), sorted ascending and de-duplicated. */
export function closedCandles(candles: Candle[], intervalMs: number, nowMs: number): Candle[] {
  const seen = new Set<number>();
  return candles
    .filter((c) => c.start + intervalMs <= nowMs)
    .sort((a, b) => a.start - b.start)
    .filter((c) => (seen.has(c.start) ? false : (seen.add(c.start), true)));
}

/** Start time of the most recent candle that must exist if the data is current. */
export function expectedLastClosedStart(nowMs: number, intervalMs: number, graceMs = CANDLE_GRACE_MS): number {
  return Math.floor((nowMs - graceMs) / intervalMs) * intervalMs - intervalMs;
}

export function checkContinuity(
  candles: Candle[],
  intervalMs: number,
  lookback: number,
): { ok: boolean; gapAt?: number } {
  const tail = candles.slice(-lookback);
  for (let i = 1; i < tail.length; i++) {
    if (tail[i].start - tail[i - 1].start !== intervalMs) return { ok: false, gapAt: tail[i].start };
  }
  return { ok: true };
}

export interface IndicatorSeries {
  emaFast: Series;
  emaSlow: Series;
  rsi: Series;
  macd: Series;
  macdSignal: Series;
  macdHist: Series;
  atr: Series;
}

export function computeSeries(candles: Candle[], s: Settings): IndicatorSeries {
  const closes = candles.map((c) => c.close);
  const m = macd(closes, s.macdFast, s.macdSlow, s.macdSignal);
  return {
    emaFast: ema(closes, s.emaFast),
    emaSlow: ema(closes, s.emaSlow),
    rsi: rsi(closes, s.rsiPeriod),
    macd: m.macd,
    macdSignal: m.signal,
    macdHist: m.hist,
    atr: atr(candles, s.atrPeriod),
  };
}

export function snapshotAt(candles: Candle[], series: IndicatorSeries, idx: number): TimeframeSnapshot {
  if (idx < 0 || idx >= candles.length) return emptySnapshot();
  return {
    candleStart: candles[idx].start,
    close: candles[idx].close,
    emaFast: series.emaFast[idx],
    emaSlow: series.emaSlow[idx],
    rsi: series.rsi[idx],
    macd: series.macd[idx],
    macdSignal: series.macdSignal[idx],
    macdHist: series.macdHist[idx],
    atr: series.atr[idx],
  };
}

export function emptySnapshot(): TimeframeSnapshot {
  return {
    candleStart: null, close: null, emaFast: null, emaSlow: null, rsi: null,
    macd: null, macdSignal: null, macdHist: null, atr: null,
  };
}

export function latestSnapshot(closed: Candle[], s: Settings): TimeframeSnapshot {
  if (closed.length === 0) return emptySnapshot();
  return snapshotAt(closed, computeSeries(closed, s), closed.length - 1);
}

// Adaptive precision so sub-$1 coins (e.g. XRP) are not rounded into meaninglessness.
const f2 = (n: number | null) => (n === null ? "n/a" : fmtPrice(n));
const f4 = (n: number | null) => (n === null ? "n/a" : String(Number(n.toPrecision(4))));

/**
 * Extra "is this a good-quality setup?" checks that sit on top of the four basic BUY conditions. They only ever make
 * a BUY rarer (never create one): real buying volume, a trend that is actually rising (not a flat range), price not
 * stretched far above its average (chasing a spike), and the 4h chart agreeing in momentum without being exhausted.
 */
export const QUALITY = { minVolumeRatio: 0.8, maxStretchAtr: 2.5, slopeBars: 5, h4RsiCeiling: 72 } as const;

export function qualityGates(h1: Candle[], h4: Candle[], s: Settings, snap1: TimeframeSnapshot): Array<[string, string, boolean, string]> {
  const out: Array<[string, string, boolean, string]> = [];
  const last = h1[h1.length - 1];
  const prev = h1.slice(-21, -1);
  const avgVol = prev.length ? prev.reduce((a, c) => a + c.volume, 0) / prev.length : 0;
  const ratio = avgVol > 0 ? last.volume / avgVol : 0;
  out.push(["h1_volume", `1h volume at least ${QUALITY.minVolumeRatio}× its 20-candle average (real participation)`, avgVol > 0 && ratio >= QUALITY.minVolumeRatio, `Volume ${ratio.toFixed(2)}× average`]);

  const ser1 = computeSeries(h1, s);
  const slowNow = ser1.emaSlow[h1.length - 1];
  const slowThen = ser1.emaSlow[h1.length - 1 - QUALITY.slopeBars];
  const rising = slowNow !== null && slowThen !== null && slowNow > slowThen;
  out.push(["h1_trend_rising", `1h EMA${s.emaSlow} is rising (not a flat, choppy range)`, rising, slowNow !== null && slowThen !== null ? `EMA${s.emaSlow} ${f2(slowThen)} → ${f2(slowNow)} over ${QUALITY.slopeBars} candles` : "Not enough data"]);

  const atr1 = snap1.atr;
  const fast = snap1.emaFast;
  const stretch = atr1 && atr1 > 0 && fast !== null ? (last.close - fast) / atr1 : null;
  out.push(["h1_not_extended", `Price is not stretched more than ${QUALITY.maxStretchAtr}× ATR above EMA${s.emaFast} (not chasing a spike)`, stretch !== null && stretch <= QUALITY.maxStretchAtr, stretch === null ? "ATR unavailable" : `${stretch.toFixed(2)}× ATR above EMA${s.emaFast}`]);

  const ser4 = computeSeries(h4, s);
  const hist4 = ser4.macdHist[h4.length - 1];
  const rsi4 = ser4.rsi[h4.length - 1];
  out.push(["h4_momentum", "4h MACD histogram is positive (higher timeframe agrees)", hist4 !== null && hist4 > 0, hist4 === null ? "Unavailable" : `4h histogram ${f4(hist4)}`]);
  out.push(["h4_not_exhausted", `4h RSI below ${QUALITY.h4RsiCeiling} (room left to rise)`, rsi4 !== null && rsi4 < QUALITY.h4RsiCeiling, rsi4 === null ? "Unavailable" : `4h RSI ${rsi4.toFixed(1)}`]);
  return out;
}

/**
 * Evaluates the educational BUY rule on CLOSED candles only:
 *   1h EMA fast > EMA slow, 4h EMA fast > EMA slow, 1h RSI within [rsiMin, rsiMax], 1h MACD histogram > 0,
 *   plus data-quality gates (enough candles, no gaps, not stale). If any data gate fails, the status is
 *   DATA_INVALID and no signal can be produced — missing data never yields a BUY.
 */
export function evaluateBuy(input: { h1: Candle[]; h4: Candle[]; now: number; settings: Settings }): BuyEvaluation {
  const { h1, h4, now, settings: s } = input;
  const need = requiredCandles(s);
  const H1 = INTERVAL_MS["60"];
  const H4 = INTERVAL_MS["240"];
  const conditions: Condition[] = [];

  const enough1 = h1.length >= need;
  const enough4 = h4.length >= need;
  conditions.push({
    id: "data_enough",
    label: "Enough completed candles (1h and 4h)",
    passed: enough1 && enough4,
    evaluated: true,
    detail: `1h: ${h1.length}/${need}, 4h: ${h4.length}/${need} closed candles available`,
  });

  const c1 = enough1 ? checkContinuity(h1, H1, need) : { ok: false };
  const c4 = enough4 ? checkContinuity(h4, H4, need) : { ok: false };
  conditions.push({
    id: "data_continuous",
    label: "No missing candles in the lookback window",
    passed: c1.ok && c4.ok,
    evaluated: true,
    detail: c1.ok && c4.ok
      ? `Last ${need} candles are contiguous on both timeframes`
      : `Gap or insufficient data detected${"gapAt" in c1 && c1.gapAt ? ` (1h near ${fmtUtcShort(c1.gapAt)})` : ""}${"gapAt" in c4 && c4.gapAt ? ` (4h near ${fmtUtcShort(c4.gapAt)})` : ""}`,
  });

  const last1 = h1.length ? h1[h1.length - 1].start : null;
  const last4 = h4.length ? h4[h4.length - 1].start : null;
  const need1 = expectedLastClosedStart(now, H1);
  const need4 = expectedLastClosedStart(now, H4);
  const fresh = last1 !== null && last4 !== null && last1 >= need1 && last4 >= need4;
  conditions.push({
    id: "data_fresh",
    label: "Market data is current (not stale)",
    passed: fresh,
    evaluated: true,
    detail: fresh
      ? `Latest closed candles: 1h ${fmtUtcShort(last1)}, 4h ${fmtUtcShort(last4)}`
      : `Latest closed candles 1h ${fmtUtcShort(last1)} (expected ≥ ${fmtUtcShort(need1)}), 4h ${fmtUtcShort(last4)} (expected ≥ ${fmtUtcShort(need4)})`,
  });

  const dataOk = enough1 && enough4 && c1.ok && c4.ok && fresh;
  const indLabels: Array<[string, string]> = [
    ["h1_ema_trend", `1h EMA${s.emaFast} above EMA${s.emaSlow}`],
    ["h4_ema_trend", `4h EMA${s.emaFast} above EMA${s.emaSlow} (trend confirmation)`],
    ["h1_rsi_range", `1h RSI${s.rsiPeriod} between ${s.rsiMin} and ${s.rsiMax}`],
    ["h1_macd_hist", `1h MACD(${s.macdFast},${s.macdSlow},${s.macdSignal}) histogram positive`],
  ];

  if (!dataOk) {
    for (const [id, label] of indLabels) {
      conditions.push({ id, label, passed: false, evaluated: false, detail: "Not evaluated: market data failed quality checks" });
    }
    return {
      status: "DATA_INVALID",
      evaluatedAt: now,
      h1CandleStart: last1,
      h4CandleStart: last4,
      conditions,
      indicators: { h1: emptySnapshot(), h4: emptySnapshot() },
      summary: "No signal possible: market data is missing, incomplete or stale.",
    };
  }

  const snap1 = latestSnapshot(h1, s);
  const snap4 = latestSnapshot(h4, s);
  const values = [snap1.emaFast, snap1.emaSlow, snap1.rsi, snap1.macdHist, snap4.emaFast, snap4.emaSlow];
  if (values.some((v) => v === null || !Number.isFinite(v as number))) {
    for (const [id, label] of indLabels) {
      conditions.push({ id, label, passed: false, evaluated: false, detail: "Indicator value unavailable" });
    }
    return {
      status: "DATA_INVALID",
      evaluatedAt: now,
      h1CandleStart: last1,
      h4CandleStart: last4,
      conditions,
      indicators: { h1: snap1, h4: snap4 },
      summary: "No signal possible: an indicator could not be computed.",
    };
  }

  const e1 = snap1.emaFast as number, e1s = snap1.emaSlow as number;
  const e4 = snap4.emaFast as number, e4s = snap4.emaSlow as number;
  const r = snap1.rsi as number;
  const h = snap1.macdHist as number;
  const results: Array<[string, string, boolean, string]> = [
    ["h1_ema_trend", indLabels[0][1], e1 > e1s, `EMA${s.emaFast} ${f2(e1)} vs EMA${s.emaSlow} ${f2(e1s)}`],
    ["h4_ema_trend", indLabels[1][1], e4 > e4s, `EMA${s.emaFast} ${f2(e4)} vs EMA${s.emaSlow} ${f2(e4s)}`],
    ["h1_rsi_range", indLabels[2][1], r >= s.rsiMin && r <= s.rsiMax, `RSI ${r.toFixed(1)}`],
    ["h1_macd_hist", indLabels[3][1], h > 0, `Histogram ${f4(h)}`],
    ...qualityGates(h1, h4, s, snap1),
  ];
  for (const [id, label, passed, detail] of results) conditions.push({ id, label, passed, evaluated: true, detail });

  const failed = conditions.filter((c) => !c.passed).map((c) => c.label);
  const pass = failed.length === 0;
  return {
    status: pass ? "SIGNAL" : "NO_SIGNAL",
    evaluatedAt: now,
    h1CandleStart: last1,
    h4CandleStart: last4,
    conditions,
    indicators: { h1: snap1, h4: snap4 },
    summary: pass
      ? `All educational BUY conditions were met on the closed 1h candle of ${fmtUtcShort(last1)}. This is a rule match, not a prediction.`
      : `No BUY signal. Failed: ${failed.join("; ")}.`,
  };
}

/**
 * Decides whether an open simulated position should be closed at `currentPrice`.
 * Order of precedence is deliberately conservative: stop-loss, then take-profit, then optional trend change.
 */
export function evaluateExit(input: {
  position: OpenPositionLike;
  currentPrice: number;
  h1: TimeframeSnapshot | null;
  settings?: Settings;
}): ExitDecision {
  const { position: p, currentPrice, h1 } = input;
  if (!(currentPrice > 0) || !Number.isFinite(currentPrice)) {
    return { exit: false, detail: "No valid current price; exit not evaluated." };
  }
  const stop = p.entryPrice * (1 - p.stopLossPct / 100);
  const take = p.entryPrice * (1 + p.takeProfitPct / 100);
  if (currentPrice <= stop) {
    return {
      exit: true,
      reason: "STOP_LOSS",
      detail: `Price ${f2(currentPrice)} reached the ${p.stopLossPct}% downside threshold (${f2(stop)}).`,
    };
  }
  if (currentPrice >= take) {
    return {
      exit: true,
      reason: "TAKE_PROFIT",
      detail: `Price ${f2(currentPrice)} reached the ${p.takeProfitPct}% upside threshold (${f2(take)}).`,
    };
  }
  if (
    p.trendExitEnabled &&
    h1 &&
    h1.candleStart !== null &&
    h1.emaFast !== null &&
    h1.emaSlow !== null &&
    h1.candleStart + INTERVAL_MS["60"] > p.openedAt // the closed candle must have closed after entry
  ) {
    if (h1.emaFast < h1.emaSlow) {
      return {
        exit: true,
        reason: "TREND_CHANGE",
        detail: `1h EMA fast ${f2(h1.emaFast)} crossed below EMA slow ${f2(h1.emaSlow)} on a candle closed after entry.`,
      };
    }
    // Earlier warning than the EMA cross (which lags): a 1h close below the slow EMA with MACD momentum negative.
    if (h1.close !== null && h1.macdHist !== null && h1.close < h1.emaSlow && h1.macdHist < 0) {
      return {
        exit: true,
        reason: "TREND_CHANGE",
        detail: `A 1h candle closed at ${f2(h1.close)}, below EMA slow ${f2(h1.emaSlow)}, with MACD momentum negative (${f4(h1.macdHist)}): the uptrend has broken.`,
      };
    }
  }
  return {
    exit: false,
    detail: `Holding: price ${f2(currentPrice)} is between stop ${f2(stop)} and target ${f2(take)}.`,
  };
}
