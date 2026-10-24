import { atr, ema, macd, rsi } from "./indicators";
import { checkContinuity, closedCandles, expectedLastClosedStart, requiredCandles } from "./rules";
import { fmtPrice } from "./format";
import { INTERVAL_MS, type Candle, type Settings } from "./types";

/**
 * LONG / SHORT / NEUTRAL analysis.
 *
 * This is a SEPARATE system from the BUY/SELL spot paper-trading rules:
 *   • BUY/SELL  – long-only spot simulation (buy, then sell to close). A SELL is an exit, never a short.
 *   • LONG/SHORT – a directional assessment (could apply to either direction, e.g. on derivatives). It never opens
 *     paper positions and never places orders; its outcomes are only tracked to measure how the rules would have fared.
 *
 * Everything here is pure and uses CLOSED candles only (no look-ahead). The 1h timeframe finds the setup, the 4h
 * timeframe must confirm the trend. A direction is only reported when ALL hard conditions agree; otherwise NEUTRAL.
 */

export type Direction = "LONG" | "SHORT" | "NEUTRAL";
export type Trend = "UP" | "DOWN" | "SIDEWAYS" | "UNKNOWN";

export interface DirCheck {
  id: string;
  label: string;
  /** null = could not be evaluated */
  long: boolean | null;
  short: boolean | null;
  detail: string;
}

export interface DirLevels {
  entry: number;
  stop: number;
  takeProfit: number;
  atr: number;
  riskPct: number;
  rewardPct: number;
  riskReward: number;
  /** Reward/risk after estimated fees and slippage. */
  netRiskReward: number;
  /** "swing" when the target was capped by a nearby support/resistance level, otherwise "2R". */
  targetBasis: "2R" | "swing";
}

export interface DirectionalAssessment {
  direction: Direction;
  dataOk: boolean;
  dataIssue: string | null;
  evaluatedAt: number;
  /** Start of the last CLOSED 1h candle used. */
  candleStart: number | null;
  /** Close of that candle: the reference price (a signal can only be seen after the candle closes). */
  price: number | null;
  h1Trend: Trend;
  h4Trend: Trend;
  longScore: number;
  shortScore: number;
  checks: DirCheck[];
  reasons: string[];
  invalidations: string[];
  /** Why the opposite / neutral outcome was reached (always filled; explains NEUTRAL). */
  notes: string[];
  levels: DirLevels | null;
  support: number | null;
  resistance: number | null;
  volume: { last: number; avg: number; ratio: number } | null;
  volatility: { atr: number; atrPct: number; regime: "low" | "normal" | "high" } | null;
  costs: { feePerSidePct: number; slippagePerSidePct: number; roundTripPct: number };
  limitations: string[];
}

export const MAX_HOLD_BARS = 48; // an unresolved setup is closed (at market) after 48 hourly candles
const ATR_STOP_MULT = 1.5;
const TARGET_R = 2;
const PIVOT_K = 3;
const SR_LOOKBACK = 120;
const VOL_AVG_N = 20;
const VOL_MIN_RATIO = 0.8;

export const STANDING_LIMITATIONS = [
  "Based on Bybit SPOT candles. Futures/perpetual prices, funding rates, liquidation levels, leverage and margin are not modelled.",
  "Signals are evaluated only after a 1h candle closes; the live price may already be different when you read this.",
  "Support/resistance comes from recent swing highs/lows and may be missing or unreliable. Volume is Bybit spot volume only.",
  "Fees use your spot fee setting; derivatives fee schedules differ. Slippage is an assumption, not a measurement.",
  "This is a rule-based analytical estimate. It does not predict the future, and past results do not guarantee future results.",
];

const last = <T,>(a: T[]): T => a[a.length - 1];
const num = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Confirmed swing pivots (need PIVOT_K candles on each side, so the newest candidates are not used). Equal highs/lows count once (the earlier one). */
export function swingLevels(candles: Candle[], lookback = SR_LOOKBACK, k = PIVOT_K): { highs: number[]; lows: number[] } {
  const start = Math.max(k, candles.length - lookback);
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = start; i < candles.length - k; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= k; j++) {
      if (!(candles[i].high > candles[i - j].high && candles[i].high >= candles[i + j].high)) isHigh = false;
      if (!(candles[i].low < candles[i - j].low && candles[i].low <= candles[i + j].low)) isLow = false;
    }
    if (isHigh) highs.push(candles[i].high);
    if (isLow) lows.push(candles[i].low);
  }
  return { highs, lows };
}

function trendOf(closes: number[], fast: Array<number | null>, slow: Array<number | null>): Trend {
  const i = closes.length - 1;
  const f = fast[i];
  const sl = slow[i];
  const slPrev = slow[i - 3];
  if (!num(f) || !num(sl) || !num(slPrev)) return "UNKNOWN";
  if (closes[i] > sl && f > sl && sl > slPrev) return "UP";
  if (closes[i] < sl && f < sl && sl < slPrev) return "DOWN";
  return "SIDEWAYS";
}

const trendWord = (t: Trend) => (t === "UP" ? "uptrend" : t === "DOWN" ? "downtrend" : t === "SIDEWAYS" ? "sideways / mixed" : "unknown");

function emptyAssessment(now: number, s: Settings, issue: string, candleStart: number | null, price: number | null): DirectionalAssessment {
  return {
    direction: "NEUTRAL", dataOk: false, dataIssue: issue, evaluatedAt: now, candleStart, price,
    h1Trend: "UNKNOWN", h4Trend: "UNKNOWN", longScore: 0, shortScore: 0, checks: [], reasons: [],
    invalidations: [], notes: [`No assessment: ${issue}`], levels: null, support: null, resistance: null, volume: null, volatility: null,
    costs: costsOf(s), limitations: STANDING_LIMITATIONS,
  };
}

function costsOf(s: Settings) {
  return { feePerSidePct: s.feeRatePct, slippagePerSidePct: s.slippagePct, roundTripPct: 2 * (s.feeRatePct + s.slippagePct) };
}

export function analyzeDirection(input: { h1: Candle[]; h4: Candle[]; now: number; settings: Settings }): DirectionalAssessment {
  const { h1, h4, now, settings: s } = input;
  const H1 = INTERVAL_MS["60"];
  const H4 = INTERVAL_MS["240"];
  const need = requiredCandles(s);
  const lastH1 = h1.length ? last(h1) : null;
  if (h1.length < need || h4.length < need) return emptyAssessment(now, s, `not enough closed candles (1h ${h1.length}/${need}, 4h ${h4.length}/${need})`, lastH1?.start ?? null, lastH1?.close ?? null);
  if (!checkContinuity(h1, H1, need).ok || !checkContinuity(h4, H4, need).ok) return emptyAssessment(now, s, "missing candles (gap) in the recent history", lastH1?.start ?? null, lastH1?.close ?? null);
  const expected1 = expectedLastClosedStart(now, H1);
  const expected4 = expectedLastClosedStart(now, H4);
  if (last(h1).start < expected1) return emptyAssessment(now, s, "1h data is stale (latest closed candle is not the most recent one)", lastH1?.start ?? null, lastH1?.close ?? null);
  if (last(h4).start < expected4) return emptyAssessment(now, s, "4h data is stale (latest closed candle is not the most recent one)", lastH1?.start ?? null, lastH1?.close ?? null);

  const c1 = h1.map((c) => c.close);
  const c4 = h4.map((c) => c.close);
  const i = h1.length - 1;
  const j = h4.length - 1;
  const eF1 = ema(c1, s.emaFast), eS1 = ema(c1, s.emaSlow);
  const eF4 = ema(c4, s.emaFast), eS4 = ema(c4, s.emaSlow);
  const rs = rsi(c1, s.rsiPeriod);
  const mc = macd(c1, s.macdFast, s.macdSlow, s.macdSignal);
  const at = atr(h1, s.atrPeriod);

  const price = c1[i];
  const emaF = eF1[i], emaS = eS1[i], rsiV = rs[i], hist = mc.hist[i], histPrev = mc.hist[i - 1], macdV = mc.macd[i], sigV = mc.signal[i], atrV = at[i];
  if (![emaF, emaS, rsiV, hist, histPrev, macdV, sigV, atrV].every(num) || !num(eF4[j]) || !num(eS4[j])) {
    return emptyAssessment(now, s, "indicators could not be computed", last(h1).start, price);
  }
  const E1F = emaF as number, E1S = emaS as number, RSI = rsiV as number, H = hist as number, HP = histPrev as number, M = macdV as number, SG = sigV as number, ATR = atrV as number;

  const h1Trend = trendOf(c1, eF1, eS1);
  const h4Trend = trendOf(c4, eF4, eS4);

  // Volume: last closed candle vs the average of the 20 candles before it.
  const prevVols = h1.slice(-1 - VOL_AVG_N, -1).map((c) => c.volume);
  const avgVol = prevVols.reduce((a, b) => a + b, 0) / Math.max(1, prevVols.length);
  const volume = avgVol > 0 ? { last: last(h1).volume, avg: avgVol, ratio: last(h1).volume / avgVol } : null;

  // Volatility regime: today's ATR relative to the median ATR of the last 100 candles.
  const atrHist = at.slice(-100).filter(num) as number[];
  const medAtr = atrHist.length >= 20 ? median(atrHist) : null;
  const atrRatio = medAtr && medAtr > 0 ? ATR / medAtr : null;
  const regime: "low" | "normal" | "high" = atrRatio === null ? "normal" : atrRatio > 1.8 ? "high" : atrRatio < 0.6 ? "low" : "normal";
  const volatility = { atr: ATR, atrPct: (ATR / price) * 100, regime };

  // Support / resistance from confirmed swing pivots.
  const sw = swingLevels(h1);
  const resistance = sw.highs.filter((x) => x > price).sort((a, b) => a - b)[0] ?? null;
  const support = sw.lows.filter((x) => x < price).sort((a, b) => b - a)[0] ?? null;

  const costs = costsOf(s);
  const stopDist = ATR * ATR_STOP_MULT;

  // Levels for each side, capped by the nearest opposing swing level.
  const build = (dir: "LONG" | "SHORT"): DirLevels | null => {
    const sign = dir === "LONG" ? 1 : -1;
    const stop = price - sign * stopDist;
    if (stop <= 0) return null;
    let tp = price + sign * TARGET_R * stopDist;
    let basis: "2R" | "swing" = "2R";
    const opposing = dir === "LONG" ? resistance : support;
    if (opposing !== null && (dir === "LONG" ? opposing < tp : opposing > tp)) {
      tp = opposing;
      basis = "swing";
    }
    const reward = Math.abs(tp - price);
    if (reward <= 0) return null;
    const riskPct = (stopDist / price) * 100;
    const rewardPct = (reward / price) * 100;
    return {
      entry: price, stop, takeProfit: tp, atr: ATR, riskPct, rewardPct,
      riskReward: reward / stopDist,
      netRiskReward: (rewardPct - costs.roundTripPct) / (riskPct + costs.roundTripPct),
      targetBasis: basis,
    };
  };
  const levelsLong = build("LONG");
  const levelsShort = build("SHORT");

  const p = fmtPrice;
  const checks: DirCheck[] = [
    {
      id: "h4_trend", label: "4h trend confirms",
      long: h4Trend === "UP", short: h4Trend === "DOWN",
      detail: `4h: ${trendWord(h4Trend)} (close ${p(c4[j])}, EMA${s.emaFast} ${p(eF4[j] as number)}, EMA${s.emaSlow} ${p(eS4[j] as number)})`,
    },
    {
      id: "h1_ema", label: "1h EMA alignment",
      long: price > E1S && E1F > E1S, short: price < E1S && E1F < E1S,
      detail: `1h: close ${p(price)}, EMA${s.emaFast} ${p(E1F)}, EMA${s.emaSlow} ${p(E1S)} (${trendWord(h1Trend)})`,
    },
    {
      id: "macd", label: "1h MACD momentum",
      long: H > 0 && H >= HP && M > SG, short: H < 0 && H <= HP && M < SG,
      detail: `histogram ${Number(H.toPrecision(3))} (previous ${Number(HP.toPrecision(3))}); MACD ${M > SG ? "above" : "below"} signal`,
    },
    {
      id: "rsi", label: "1h RSI in a healthy band",
      long: RSI >= 50 && RSI <= 70, short: RSI >= 30 && RSI <= 50,
      detail: `RSI ${RSI.toFixed(1)} (LONG wants 50–70, SHORT wants 30–50; outside that is momentum-less or already stretched)`,
    },
    {
      id: "volume", label: "Volume not drying up",
      long: volume ? volume.ratio >= VOL_MIN_RATIO : null, short: volume ? volume.ratio >= VOL_MIN_RATIO : null,
      detail: volume ? `last candle volume is ${volume.ratio.toFixed(2)}× the previous ${VOL_AVG_N}-candle average (needs ≥ ${VOL_MIN_RATIO})` : "volume average unavailable",
    },
    {
      id: "volatility", label: "Volatility not extreme",
      long: regime !== "high", short: regime !== "high",
      detail: `ATR ${volatility.atrPct.toFixed(2)}% of price (${regime}${atrRatio !== null ? `, ${atrRatio.toFixed(2)}× its 100-candle median` : ""}); extreme volatility makes stops unreliable`,
    },
    {
      id: "rr", label: `Reward/risk at least ${s.minRiskReward}`,
      long: levelsLong ? levelsLong.riskReward >= s.minRiskReward : null,
      short: levelsShort ? levelsShort.riskReward >= s.minRiskReward : null,
      detail: `LONG ${levelsLong ? levelsLong.riskReward.toFixed(2) : "n/a"}, SHORT ${levelsShort ? levelsShort.riskReward.toFixed(2) : "n/a"} (target capped by nearby ${resistance !== null ? `resistance ${p(resistance)}` : "no resistance found"} / ${support !== null ? `support ${p(support)}` : "no support found"})`,
    },
    {
      id: "costs", label: "Still worthwhile after estimated costs (net reward/risk ≥ 1)",
      long: levelsLong ? levelsLong.netRiskReward >= 1 : null,
      short: levelsShort ? levelsShort.netRiskReward >= 1 : null,
      detail: `round-trip costs ≈ ${costs.roundTripPct.toFixed(2)}% (fees ${s.feeRatePct}% + slippage ${s.slippagePct}% per side); net R/R LONG ${levelsLong ? levelsLong.netRiskReward.toFixed(2) : "n/a"}, SHORT ${levelsShort ? levelsShort.netRiskReward.toFixed(2) : "n/a"}`,
    },
  ];

  const weights: Record<string, number> = { h4_trend: 30, h1_ema: 20, macd: 15, rsi: 15, volume: 10, volatility: 0, rr: 5, costs: 5 };
  const score = (side: "long" | "short") => checks.reduce((a, c) => a + (c[side] === true ? weights[c.id] : 0), 0);
  const longScore = score("long");
  const shortScore = score("short");
  const allPass = (side: "long" | "short") => checks.every((c) => c[side] === true);

  let direction: Direction = "NEUTRAL";
  if (allPass("long") && levelsLong) direction = "LONG";
  else if (allPass("short") && levelsShort) direction = "SHORT";

  const reasons: string[] = [];
  const notes: string[] = [];
  let invalidations: string[] = [];
  let levels: DirLevels | null = null;

  if (direction === "LONG" || direction === "SHORT") {
    const side = direction === "LONG" ? "long" : "short";
    levels = direction === "LONG" ? levelsLong : levelsShort;
    for (const c of checks) if (c[side] === true && c.id !== "volatility") reasons.push(`${c.label}: ${c.detail}`);
    const lv = levels as DirLevels;
    const up = direction === "LONG";
    invalidations = [
      `A 1h candle closes ${up ? "below" : "above"} the stop reference ${p(lv.stop)} (${lv.riskPct.toFixed(2)}% ${up ? "below" : "above"} entry).`,
      `4h trend stops being a ${up ? "uptrend" : "downtrend"} (4h close crosses ${up ? "below" : "above"} EMA${s.emaSlow}, currently ${p(eS4[j] as number)}).`,
      `1h close crosses ${up ? "below" : "above"} EMA${s.emaSlow} (${p(E1S)}).`,
      `1h MACD histogram turns ${up ? "negative" : "positive"}.`,
      `1h RSI leaves the ${up ? "50–70" : "30–50"} band.`,
      `Not reached within ${MAX_HOLD_BARS} hourly candles: treat the setup as expired.`,
    ];
    notes.push(`${direction} setup: all ${checks.length} conditions agree (score ${direction === "LONG" ? longScore : shortScore}/100).`);
  } else {
    // Explain NEUTRAL honestly: contradictory timeframes, or the closest side and what it lacks.
    if ((h4Trend === "UP" && (h1Trend === "DOWN" || price < E1S)) || (h4Trend === "DOWN" && (h1Trend === "UP" || price > E1S))) {
      notes.push(`Timeframes contradict each other: 4h is a ${trendWord(h4Trend)} but the 1h chart points the other way.`);
    }
    if (h4Trend === "SIDEWAYS") notes.push("4h trend is sideways / mixed, so there is no trend to confirm a direction.");
    const closest: "long" | "short" = longScore >= shortScore ? "long" : "short";
    const failed = checks.filter((c) => c[closest] !== true);
    notes.push(`Closest side is ${closest.toUpperCase()} (score ${closest === "long" ? longScore : shortScore}/100) but it fails: ${failed.map((c) => c.label).join("; ") || "nothing"}.`);
    for (const c of failed) notes.push(`${c.label} — ${c.detail}`);
    invalidations = ["Nothing to invalidate: no setup is active. A setup appears only when every condition agrees on the same side."];
  }

  return {
    direction, dataOk: true, dataIssue: null, evaluatedAt: now, candleStart: last(h1).start, price,
    h1Trend, h4Trend, longScore, shortScore, checks, reasons, invalidations, notes, levels,
    support, resistance, volume, volatility, costs, limitations: STANDING_LIMITATIONS,
  };
}

// ── Outcome tracking ─────────────────────────────────────────────────────────

export type SignalStatus = "open" | "tp" | "sl" | "expired" | "reversed" | "missed";

export interface SignalOutcome {
  status: SignalStatus;
  fillPrice: number | null;
  exitPrice: number | null;
  exitAt: number | null;
  bars: number;
  grossPct: number | null;
  netPct: number | null;
  rMultiple: number | null;
  mfePct: number | null;
  maePct: number | null;
  ambiguous: boolean;
}

export interface TrackedSignal {
  direction: "LONG" | "SHORT";
  /** Start of the 1h candle whose close produced the signal. */
  candleStart: number;
  stop: number;
  takeProfit: number;
}

/**
 * Walks forward through candles AFTER the signal candle. The simulated fill is the next candle's OPEN (the signal was
 * only knowable once its candle closed). If both stop and target lie inside one candle the STOP is assumed first
 * (pessimistic). Costs: 2 × (fee + slippage) are deducted from the gross percentage.
 * Returns status "open" while unresolved. `reverseAt` closes it early at a given price/time ("reversed").
 */
export function resolveSignal(
  sig: TrackedSignal,
  candles: Candle[],
  settings: Pick<Settings, "feeRatePct" | "slippagePct">,
  opts: { reverseAt?: { price: number; at: number } } = {},
): SignalOutcome {
  const H1 = INTERVAL_MS["60"];
  const after = candles.filter((c) => c.start > sig.candleStart).sort((a, b) => a.start - b.start);
  const cost = 2 * (settings.feeRatePct + settings.slippagePct);
  const open: SignalOutcome = { status: "open", fillPrice: null, exitPrice: null, exitAt: null, bars: 0, grossPct: null, netPct: null, rMultiple: null, mfePct: null, maePct: null, ambiguous: false };
  if (!after.length) return open;
  const up = sig.direction === "LONG";
  const fill = after[0].open;
  if (after[0].start !== sig.candleStart + H1) return open; // continuity broken: wait for good data rather than guess
  if (up ? fill <= sig.stop || fill >= sig.takeProfit : fill >= sig.stop || fill <= sig.takeProfit) {
    return { ...open, status: "missed", fillPrice: fill };
  }
  const risk = Math.abs(fill - sig.stop);
  const pct = (px: number) => (up ? (px - fill) / fill : (fill - px) / fill) * 100;
  let mfe = 0;
  let mae = 0;
  const finish = (status: SignalStatus, exit: number, at: number, bars: number, ambiguous = false): SignalOutcome => {
    const gross = pct(exit);
    const net = gross - cost;
    return {
      status, fillPrice: fill, exitPrice: exit, exitAt: at, bars, grossPct: gross, netPct: net,
      rMultiple: risk > 0 ? net / ((risk / fill) * 100) : null, mfePct: mfe, maePct: mae, ambiguous,
    };
  };
  let bars = 0;
  for (const c of after) {
    if (bars > 0 && c.start !== after[bars - 1].start + H1) break; // gap: stop walking, stay open
    bars++;
    const end = c.start + H1;
    if (opts.reverseAt && end > opts.reverseAt.at) return finish("reversed", opts.reverseAt.price, opts.reverseAt.at, bars - 1 || 1);
    const favourable = up ? c.high : c.low;
    const adverse = up ? c.low : c.high;
    mfe = Math.max(mfe, pct(favourable));
    mae = Math.min(mae, pct(adverse));
    const hitStop = up ? c.low <= sig.stop : c.high >= sig.stop;
    const hitTp = up ? c.high >= sig.takeProfit : c.low <= sig.takeProfit;
    if (hitStop && hitTp) return finish("sl", sig.stop, end, bars, true);
    if (hitStop) return finish("sl", sig.stop, end, bars);
    if (hitTp) return finish("tp", sig.takeProfit, end, bars);
    if (bars >= MAX_HOLD_BARS) return finish("expired", c.close, end, bars);
  }
  if (opts.reverseAt && opts.reverseAt.at >= after[after.length - 1].start + H1) return finish("reversed", opts.reverseAt.price, opts.reverseAt.at, bars);
  return { ...open, fillPrice: fill, bars, mfePct: mfe, maePct: mae };
}

// ── Performance statistics ───────────────────────────────────────────────────

export interface ResolvedTrade {
  symbol: string;
  direction: "LONG" | "SHORT";
  status: SignalStatus;
  exitAt: number;
  netPct: number;
  grossPct: number;
  rMultiple: number | null;
  ambiguous: boolean;
}

export interface PerfBucket {
  count: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  avgNetPct: number | null;
  totalNetPct: number;
  avgR: number | null;
  profitFactor: number | null;
  maxDrawdownPct: number;
}

export interface PerfStats extends PerfBucket {
  long: PerfBucket;
  short: PerfBucket;
  bySymbol: Record<string, PerfBucket>;
  byExit: Record<string, number>;
  /** Plain-language caveats that apply to these numbers. */
  caveats: string[];
}

function bucket(trades: ResolvedTrade[]): PerfBucket {
  const sorted = [...trades].sort((a, b) => a.exitAt - b.exitAt);
  const wins = sorted.filter((t) => t.netPct > 0);
  const losses = sorted.filter((t) => t.netPct <= 0);
  const gw = wins.reduce((a, t) => a + t.netPct, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.netPct, 0));
  let equity = 0, peak = 0, dd = 0;
  for (const t of sorted) {
    equity += t.netPct;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
  }
  const rs = sorted.map((t) => t.rMultiple).filter(num);
  return {
    count: sorted.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: sorted.length ? (wins.length / sorted.length) * 100 : null,
    avgNetPct: sorted.length ? sorted.reduce((a, t) => a + t.netPct, 0) / sorted.length : null,
    totalNetPct: sorted.reduce((a, t) => a + t.netPct, 0),
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    profitFactor: gl > 0 ? gw / gl : gw > 0 ? null : null,
    maxDrawdownPct: dd,
  };
}

export function computeStats(trades: ResolvedTrade[]): PerfStats {
  const all = bucket(trades);
  const bySymbol: Record<string, PerfBucket> = {};
  for (const sym of new Set(trades.map((t) => t.symbol))) bySymbol[sym] = bucket(trades.filter((t) => t.symbol === sym));
  const byExit: Record<string, number> = {};
  for (const t of trades) byExit[t.status] = (byExit[t.status] ?? 0) + 1;
  const caveats = [
    "Each trade is counted with equal weight (net % of the entry price); cumulative % is a simple sum, not compounded, and ignores position size and leverage.",
    "Net % already subtracts estimated fees and slippage on both sides. Real fills, funding and liquidity can differ.",
    "If a stop and a target fell inside the same 1h candle, the stop is assumed to hit first (pessimistic).",
    "Maximum drawdown is the largest peak-to-trough fall of the cumulative net % in the order trades closed.",
  ];
  if (all.count < 30) caveats.unshift(`Only ${all.count} resolved signal(s): too few to say anything reliable about win rate or profitability (30+ is a bare minimum, and even then it is not proof).`);
  return { ...all, long: bucket(trades.filter((t) => t.direction === "LONG")), short: bucket(trades.filter((t) => t.direction === "SHORT")), bySymbol, byExit, caveats };
}

// ── Historical back-test (walk-forward, no look-ahead) ───────────────────────

export interface BacktestSignal {
  direction: "LONG" | "SHORT";
  candleStart: number;
  price: number;
  stop: number;
  takeProfit: number;
  riskReward: number;
  outcome: SignalOutcome;
}

export interface BacktestResult {
  symbol: string;
  from: number | null;
  to: number | null;
  candles1h: number;
  candles4h: number;
  signals: BacktestSignal[];
  stats: PerfStats;
  skippedMissed: number;
  stillOpen: number;
  limitations: string[];
}

/**
 * Replays the exact live rules candle by candle. At each step ONLY candles that had closed by that moment are given
 * to the analysis; a signal is raised on a transition into LONG/SHORT (like live), and its outcome is resolved with
 * candles that come strictly AFTER it. One open signal per coin at a time.
 */
export function runBacktest(input: { symbol: string; h1: Candle[]; h4: Candle[]; settings: Settings }): BacktestResult {
  const { symbol, settings } = input;
  const H1 = INTERVAL_MS["60"];
  const h1 = closedCandles(input.h1, H1, Number.MAX_SAFE_INTEGER);
  const h4 = closedCandles(input.h4, INTERVAL_MS["240"], Number.MAX_SAFE_INTEGER);
  const need = requiredCandles(settings);
  const signals: BacktestSignal[] = [];
  let prev: Direction = "NEUTRAL";
  let openSig: { idx: number; sig: TrackedSignal } | null = null;

  for (let i = need; i < h1.length; i++) {
    const now = h1[i].start + H1; // the moment candle i closes
    // resolve the open signal with data up to and including candle i
    if (openSig) {
      const o = resolveSignal(openSig.sig, h1.slice(0, i + 1), settings);
      if (o.status !== "open") {
        signals[openSig.idx].outcome = o;
        openSig = null;
      }
    }
    const h1Slice = h1.slice(0, i + 1);
    const h4Slice = h4.filter((c) => c.start + INTERVAL_MS["240"] <= now);
    const a = analyzeDirection({ h1: h1Slice, h4: h4Slice, now: now + 1000, settings });
    if (!a.dataOk) { prev = "NEUTRAL"; continue; }
    if (a.direction !== "NEUTRAL" && a.direction !== prev && a.levels) {
      if (openSig && signals[openSig.idx].direction !== a.direction) {
        const o = resolveSignal(openSig.sig, h1Slice, settings, { reverseAt: { price: h1[i].close, at: now } });
        signals[openSig.idx].outcome = o.status === "open" ? { ...o, status: "reversed", exitPrice: h1[i].close, exitAt: now } : o;
        openSig = null;
      }
      if (!openSig) {
        const sig: TrackedSignal = { direction: a.direction, candleStart: h1[i].start, stop: a.levels.stop, takeProfit: a.levels.takeProfit };
        signals.push({ direction: a.direction, candleStart: h1[i].start, price: a.price as number, stop: a.levels.stop, takeProfit: a.levels.takeProfit, riskReward: a.levels.riskReward, outcome: { status: "open", fillPrice: null, exitPrice: null, exitAt: null, bars: 0, grossPct: null, netPct: null, rMultiple: null, mfePct: null, maePct: null, ambiguous: false } });
        openSig = { idx: signals.length - 1, sig };
      }
    }
    prev = a.direction;
  }

  const resolved: ResolvedTrade[] = signals
    .filter((s) => ["tp", "sl", "expired", "reversed"].includes(s.outcome.status) && s.outcome.netPct !== null)
    .map((s) => ({ symbol, direction: s.direction, status: s.outcome.status, exitAt: s.outcome.exitAt as number, netPct: s.outcome.netPct as number, grossPct: s.outcome.grossPct as number, rMultiple: s.outcome.rMultiple, ambiguous: s.outcome.ambiguous }));
  return {
    symbol,
    from: h1.length ? h1[0].start : null,
    to: h1.length ? last(h1).start + H1 : null,
    candles1h: h1.length,
    candles4h: h4.length,
    signals,
    stats: computeStats(resolved),
    skippedMissed: signals.filter((s) => s.outcome.status === "missed").length,
    stillOpen: signals.filter((s) => s.outcome.status === "open").length,
    limitations: [
      `Only the most recent ${h1.length} hourly candles (about ${Math.round(h1.length / 24)} days) were available from one request, so the sample is small and covers a single market regime.`,
      "The rules and thresholds were NOT tuned on this data, but a short back-test still cannot show that they will work in other conditions.",
      "Walk-forward: each decision uses only candles that had already closed; fills are the next candle's open; same-candle stop/target ties count as stops.",
      ...STANDING_LIMITATIONS,
    ],
  };
}
