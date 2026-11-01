import { geq, gt, leq, RSI_SCALE } from "./floatcmp";
import { fmtPrice } from "./format";
import { checkContinuity, computeSeries, evaluateBuy, expectedLastClosedStart, requiredCandles } from "./rules";
import {
  buildZones, classifyBreaks, findPivots, nearestResistance, nearestSupport, projectedVolume, STRUCTURE, structureState, volumeRatio,
} from "./structure";
import { INTERVAL_MS, type Candle, type Settings } from "./types";

/**
 * Three independent strategies evaluated on 1H candles (setup) with 4H candles (context):
 *   TREND_BUY     – the existing trend-following BUY rule, unchanged (it is wrapped, not rewritten)
 *   BOUNCE        – NEW: price at an established support zone with evidence of recovery
 *   EXIT_WARNING  – NEW: price at resistance (or losing support) with bearish evidence; needs no open paper trade
 *
 * Each evaluator returns the full checklist. "full" may only be trusted when it was computed on CLOSED candles; the
 * caller (lifecycle) never lets a result computed with a forming candle count as confirmed.
 */

export type StrategyId = "TREND_BUY" | "BOUNCE" | "EXIT_WARNING";

export const STRATEGY_LABEL: Record<StrategyId, string> = {
  TREND_BUY: "Trend BUY",
  BOUNCE: "Support-Bounce",
  EXIT_WARNING: "Exit warning",
};

export const SETUP = {
  /** Candle must be at least this far along before a forming-candle preview is used (volume is meaningless earlier). */
  minElapsed: 0.25,
  rsiOversold: 38,
  rsiRecovery: 4,
  rsiOverbought: 68,
  rsiRollover: 3,
  minBounceNetRR: 1.3,
  minStopAtr: 0.5,
  maxStopAtr: 3.5,
  stopPadAtr: 0.5,
  reversalCloseFrac: 0.6,
  bearishVolume: 1.2,
  /** An alert counts as "current" for this many hourly candles after the signal candle closes. */
  validCandles: 6,
} as const;

export interface Cond {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
  group: "data" | "context" | "trigger";
}

export interface SetupLevels {
  entry: number;
  stop: number;
  target: number;
  targetBasis: "resistance" | "2R";
  riskPct: number;
  riskReward: number;
  netRiskReward: number;
}

export interface SetupEval {
  strategy: StrategyId;
  dataOk: boolean;
  dataIssue: string | null;
  conditions: Cond[];
  /** WATCH-level: the setting is developing. */
  context: boolean;
  /** POTENTIAL-level: all price/indicator evidence present (may use a forming candle). */
  potential: boolean;
  /** CONFIRMED-level: everything holds. Only meaningful when computed on closed candles. */
  full: boolean;
  /** Reference price (last close, or the live price of the forming candle). */
  price: number | null;
  /** Start of the 1H candle the evaluation is about. */
  candleStart: number | null;
  levels: SetupLevels | null;
  reasons: string[];
  variant: string | null;
  /** The zone the setup is about (used for expiry rules) and the 1H ATR at evaluation time. */
  refs: { zoneLow: number | null; zoneHigh: number | null; atr: number | null };
}

export interface EvalInput {
  symbol: string;
  h1Closed: Candle[];
  h4Closed: Candle[];
  /** The unfinished 1H candle, or null to evaluate on closed candles only. */
  forming: Candle | null;
  now: number;
  settings: Settings;
  /** BTC 4H closed candles for the market-wide guard (null/undefined = not available, guard not applied). */
  btcH4?: Candle[] | null;
  /** Sensitivity-test switch: set false to skip the 4H-momentum conflict check (default true = the approved design). */
  h4Conflict?: boolean;
}

const H1 = INTERVAL_MS["60"];
const H4 = INTERVAL_MS["240"];
const f = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? "n/a" : fmtPrice(n));
const x1 = (n: number) => n.toFixed(1);
const x2 = (n: number) => n.toFixed(2);

/** Fraction of the forming 1H candle that has elapsed at `now`. */
export function elapsedFraction(candleStart: number, now: number): number {
  return Math.max(0, Math.min(1, (now - candleStart) / H1));
}

function empty(strategy: StrategyId, issue: string): SetupEval {
  return { strategy, dataOk: false, dataIssue: issue, conditions: [{ id: "data", label: "Market data usable", passed: false, detail: issue, group: "data" }], context: false, potential: false, full: false, price: null, candleStart: null, levels: null, reasons: [], variant: null, refs: { zoneLow: null, zoneHigh: null, atr: null } };
}

interface Prepared {
  h1: Candle[];
  n: number;
  previewing: boolean;
  /** True when the forming candle is too young for its volume to mean anything. */
  volPending: boolean;
  closedCount: number;
}

/** Data gates shared by every strategy. Returns an issue string when the data cannot be trusted. */
function dataIssue(input: EvalInput): string | null {
  const s = input.settings;
  const need = requiredCandles(s);
  if (input.h1Closed.length < need || input.h4Closed.length < need) return `Not enough completed candles (1h ${input.h1Closed.length}/${need}, 4h ${input.h4Closed.length}/${need}).`;
  if (!checkContinuity(input.h1Closed, H1, need).ok || !checkContinuity(input.h4Closed, H4, need).ok) return "Gap detected in the candle history.";
  const last1 = input.h1Closed[input.h1Closed.length - 1].start;
  const last4 = input.h4Closed[input.h4Closed.length - 1].start;
  if (last1 < expectedLastClosedStart(input.now, H1) || last4 < expectedLastClosedStart(input.now, H4)) return "Market data is delayed (the latest closed candle is older than expected).";
  if (input.forming && input.forming.start !== last1 + H1) return "The unfinished candle does not follow the last closed candle.";
  return null;
}

function prepare(input: EvalInput): Prepared {
  const closed = input.h1Closed;
  if (!input.forming) return { h1: closed, n: closed.length, previewing: false, volPending: false, closedCount: closed.length };
  const el = elapsedFraction(input.forming.start, input.now);
  const proj = projectedVolume(input.forming.volume, el);
  const adj: Candle = { ...input.forming, volume: proj ?? 0 };
  return { h1: [...closed, adj], n: closed.length + 1, previewing: true, volPending: proj === null, closedCount: closed.length };
}

/** Mean volume ratio of the last three candles (skipping the forming candle's value when it is still pending). */
function meanVr3(h1: Candle[], i: number, skipLast: boolean): number | null {
  const idxs = [i, i - 1, i - 2].filter((x) => !(skipLast && x === i));
  const vs = idxs.map((x) => volumeRatio(h1, x)).filter((v): v is number => v !== null);
  return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
}

const cond = (id: string, label: string, passed: boolean, detail: string, group: Cond["group"]): Cond => ({ id, label, passed, detail, group });
const reasonsOf = (c: Cond[]) => c.filter((x) => x.passed && x.group !== "data").map((x) => `${x.label} — ${x.detail}`);

// ── Trend BUY (existing rule, wrapped) ───────────────────────────────────────

export function evaluateTrendSetup(input: EvalInput): SetupEval {
  const issue = dataIssue(input);
  if (issue) return empty("TREND_BUY", issue);
  const p = prepare(input);
  if (p.previewing && p.volPending) {
    const e = evaluateTrendSetup({ ...input, forming: null });
    return { ...e, potential: false, full: false, variant: "waiting for 25% of the candle before an early read is allowed" };
  }
  const ev = evaluateBuy({ h1: p.h1, h4: input.h4Closed, now: input.now, settings: input.settings });
  if (ev.status === "DATA_INVALID") return empty("TREND_BUY", ev.summary);
  const core = new Set(["h1_ema_trend", "h4_ema_trend", "h1_rsi_range", "h1_macd_hist"]);
  const conditions: Cond[] = ev.conditions.map((c) => cond(c.id, c.label, c.passed, c.detail, c.id.startsWith("data_") ? "data" : core.has(c.id) ? "context" : "trigger"));
  const coreOk = conditions.filter((c) => core.has(c.id)).every((c) => c.passed);
  const sig = ev.status === "SIGNAL";
  const last = p.h1[p.h1.length - 1];
  return {
    strategy: "TREND_BUY", dataOk: true, dataIssue: null, conditions, context: coreOk, potential: sig, full: sig && !p.previewing,
    price: last.close, candleStart: last.start, levels: null, reasons: reasonsOf(conditions), variant: null,
    refs: { zoneLow: null, zoneHigh: null, atr: null },
  };
}

// ── Shared candle helpers ────────────────────────────────────────────────────

const body = (c: Candle) => Math.abs(c.close - c.open);
const range = (c: Candle) => c.high - c.low;
const lowerWick = (c: Candle) => Math.min(c.open, c.close) - c.low;
const upperWick = (c: Candle) => c.high - Math.max(c.open, c.close);

/** b6: RSI dipped to the oversold level within the window and has recovered by the required amount and is rising. Ties are decided without floating-point noise. */
export function rsiRecovering(minRsi: number | null, rNow: number | null, rPrev: number | null): boolean {
  return minRsi !== null && leq(minRsi, SETUP.rsiOversold, RSI_SCALE) && rNow !== null && rPrev !== null && geq(rNow, minRsi + SETUP.rsiRecovery, RSI_SCALE) && gt(rNow, rPrev, RSI_SCALE);
}

/** e2: RSI reached the overbought level within the window and has rolled over by the required amount. */
export function rsiRollingOver(maxRsi: number | null, rNow: number | null): boolean {
  return maxRsi !== null && rNow !== null && geq(maxRsi, SETUP.rsiOverbought, RSI_SCALE) && leq(rNow, maxRsi - SETUP.rsiRollover, RSI_SCALE);
}

/** Net reward/risk after round-trip fees and slippage. */
function netRR(entry: number, stop: number, target: number, s: Settings): { rr: number; net: number } {
  const risk = entry - stop;
  const reward = target - entry;
  const costs = entry * (2 * (s.feeRatePct + s.slippagePct)) / 100;
  return { rr: risk > 0 ? reward / risk : 0, net: risk + costs > 0 ? (reward - costs) / (risk + costs) : 0 };
}

// ── Support-Bounce ───────────────────────────────────────────────────────────

export function evaluateBounce(input: EvalInput): SetupEval {
  const issue = dataIssue(input);
  if (issue) return empty("BOUNCE", issue);
  const s = input.settings;
  const p = prepare(input);
  const { h1, n } = p;
  const i = n - 1;
  const last = h1[i];
  const price = last.close;
  const s1 = computeSeries(h1, s);
  const atr = s1.atr[i];
  if (atr === null || !(atr > 0)) return empty("BOUNCE", "ATR could not be computed.");

  const piv = findPivots(h1, STRUCTURE.pivotK1h, STRUCTURE.lookback1h);
  const zones = buildZones([...piv.highs, ...piv.lows], atr);
  const support = nearestSupport(zones, price, atr);
  const conds: Cond[] = [];

  conds.push(cond("b1_support", "An established support zone exists (2+ touches)", support !== null,
    support ? `Zone ${f(support.low)}–${f(support.high)}, ${support.touches} touches` : "No established support zone found nearby", "context"));

  let touched = false, near = false, brokeDown = false;
  if (support) {
    const win = h1.slice(-6);
    touched = win.some((c) => c.low <= support.high + 0.25 * atr);
    near = price >= support.low - 0.25 * atr && price <= support.high + 1.5 * atr;
    brokeDown = win.some((c) => c.close < support.low - 0.25 * atr);
  }
  conds.push(cond("b2_approach", "Price recently touched the zone and is still close to it", support !== null && touched && near,
    support ? `Touched: ${touched ? "yes" : "no"}; price ${f(price)} is ${near ? "within" : "outside"} the near-zone band` : "No zone", "context"));
  conds.push(cond("b3_holding", "Support has not broken down (no close below it in the last 6 candles)", support !== null && !brokeDown,
    support ? (brokeDown ? `A close below ${f(support.low - 0.25 * atr)} was found` : "No close below the zone") : "No zone", "context"));

  // 4H context: do not buy into a falling knife.
  const s4 = computeSeries(input.h4Closed, s);
  const j = input.h4Closed.length - 1;
  const atr4 = s4.atr[j];
  const piv4 = findPivots(input.h4Closed, STRUCTURE.pivotK4h, STRUCTURE.lookback4h);
  const st4 = structureState(piv4, atr4 ?? 0);
  const zones4 = atr4 ? buildZones([...piv4.highs, ...piv4.lows], atr4) : [];
  const in4hSupport = !!atr4 && zones4.some((z) => z.established && price >= z.low - 0.25 * atr4 && price <= z.high + 0.5 * atr4);
  conds.push(cond("b4_h4_context", "4H is not in a downtrend (unless price sits on a 4H support zone)", !(st4.state === "DOWNTREND" && !in4hSupport),
    `4H structure ${st4.state}${in4hSupport ? ", price is on a 4H support zone" : ""}. ${st4.detail}`, "context"));

  const h4h = s4.macdHist;
  const deteriorating = h4h[j] !== null && h4h[j - 1] !== null && h4h[j - 2] !== null && (h4h[j] as number) < 0 && (h4h[j] as number) < (h4h[j - 1] as number) && (h4h[j - 1] as number) < (h4h[j - 2] as number);
  const checkH4 = input.h4Conflict !== false;
  conds.push(cond("b5_h4_momentum", "4H momentum is not deteriorating (no conflict with the 1H bounce)", !checkH4 || !deteriorating,
    !checkH4 ? "Check switched off (sensitivity test)" : h4h[j] === null ? "4H MACD unavailable" : `4H MACD histogram ${x2(h4h[j] as number)}${deteriorating ? ", negative and falling for 2 candles" : ""}`, "trigger"));

  // Oversold and recovering.
  const rs = s1.rsi;
  const win8 = rs.slice(-8).filter((v): v is number => v !== null);
  const minRsi = win8.length ? Math.min(...win8) : null;
  const rNow = rs[i], rPrev = rs[i - 1];
  const recovering = rsiRecovering(minRsi, rNow, rPrev);
  conds.push(cond("b6_rsi", `RSI was at or below ${SETUP.rsiOversold} in the last 8 candles and is recovering`, recovering,
    minRsi === null || rNow === null ? "RSI unavailable" : `Low ${x1(minRsi)}, now ${x1(rNow)}${rPrev !== null ? ` (previous ${x1(rPrev)})` : ""}`, "trigger"));

  const hh = s1.macdHist;
  const improving = hh[i] !== null && hh[i - 1] !== null && hh[i - 3] !== null && (hh[i] as number) > (hh[i - 1] as number) && (hh[i] as number) > (hh[i - 3] as number);
  conds.push(cond("b7_macd", "MACD momentum is improving", improving,
    hh[i] === null ? "MACD unavailable" : `Histogram ${x2(hh[i] as number)} vs ${hh[i - 1] === null ? "n/a" : x2(hh[i - 1] as number)} one candle ago and ${hh[i - 3] === null ? "n/a" : x2(hh[i - 3] as number)} three candles ago`, "trigger"));

  // Reversal candle: the latest candle or the one before it.
  let revIdx: number | null = null;
  for (const x of [i, i - 1]) {
    const c = h1[x], pc = h1[x - 1];
    if (!c || !pc || !(range(c) > 0)) continue;
    const bullish = c.close > c.open;
    const topClose = geq(c.close, c.low + SETUP.reversalCloseFrac * range(c), c.high);
    const strongRecovery = geq(lowerWick(c), body(c), c.high) || c.close > pc.high;
    if (bullish && topClose && strongRecovery) { revIdx = x; break; }
  }
  conds.push(cond("b8_reversal", "A bullish reversal candle formed (closes in its top 40% with a lower wick or above the prior high)", revIdx !== null,
    revIdx === null ? "No reversal candle in the last 2 candles" : `Candle starting ${new Date(h1[revIdx].start).toISOString().slice(11, 16)} UTC${revIdx === i && p.previewing ? " (still forming)" : ""}`, "trigger"));

  // Volume support.
  const vrAt = (x: number): number | null => (p.previewing && p.volPending && x === i ? null : volumeRatio(h1, x));
  let volOk = false;
  let volDetail = "No reversal candle yet";
  const lo = p.previewing && p.volPending ? i - 3 : i - 2;
  const upV = h1.slice(Math.max(0, lo), lo + 3).filter((c) => c.close >= c.open).reduce((a, c) => a + c.volume, 0);
  const dnV = h1.slice(Math.max(0, lo), lo + 3).filter((c) => c.close < c.open).reduce((a, c) => a + c.volume, 0);
  const rv = revIdx !== null ? vrAt(revIdx) : null;
  if (revIdx !== null) {
    if (rv === null && p.previewing && p.volPending && revIdx === i) volDetail = "Pending: the candle is less than 25% complete";
    else volDetail = `Reversal candle volume ${rv === null ? "n/a" : x2(rv) + "× average"}; recent up-candle volume ${upV > dnV ? "exceeds" : "does not exceed"} down-candle volume`;
    const m3 = meanVr3(h1, i, p.previewing && p.volPending);
    volOk = (rv !== null && rv >= 1.0) || (m3 !== null && m3 >= 1.0 && upV > dnV);
  }
  conds.push(cond("b9_volume", "Volume supports the move (reversal candle at or above average, or the last 3 candles average 1.0× with buyers ahead)", volOk, volDetail, "trigger"));

  // Levels and risk/reward.
  let levels: SetupLevels | null = null;
  let levelsOk = false;
  let levelsDetail = "No support zone";
  if (support) {
    const stop = support.low - SETUP.stopPadAtr * atr;
    const risk = price - stop;
    const res = zones.filter((z) => z.established && z.low > price + 0.5 * atr).sort((a, b) => a.low - b.low)[0] ?? null;
    const target = res ? res.low : price + 2 * risk;
    const { rr, net } = netRR(price, stop, target, s);
    levels = { entry: price, stop, target, targetBasis: res ? "resistance" : "2R", riskPct: risk > 0 ? (risk / price) * 100 : 0, riskReward: rr, netRiskReward: net };
    const sane = risk >= SETUP.minStopAtr * atr && risk <= SETUP.maxStopAtr * atr;
    levelsOk = sane && net >= SETUP.minBounceNetRR;
    levelsDetail = `Stop ${f(stop)} (${x2(levels.riskPct)}% away), target ${f(target)} (${res ? "next resistance" : "2R"}), net reward/risk ${x2(net)}${sane ? "" : " — stop distance outside 0.5–3.5 ATR"}`;
  }
  conds.push(cond("b10_levels", `Stop and target are sensible and net reward/risk is at least ${SETUP.minBounceNetRR} after costs`, levelsOk, levelsDetail, "trigger"));

  // BTC guard (skipped for BTC itself, or when BTC data is not available).
  let btcOk = true;
  let btcDetail = "Not applied (no BTC reference data, or this is BTC)";
  if (input.symbol !== "BTCUSDT" && input.btcH4 && input.btcH4.length >= requiredCandles(s)) {
    const sb = computeSeries(input.btcH4, s);
    const k = input.btcH4.length - 1;
    const pb = findPivots(input.btcH4, STRUCTURE.pivotK4h, STRUCTURE.lookback4h);
    const stb = structureState(pb, sb.atr[k] ?? 0);
    const below = sb.emaSlow[k] !== null && input.btcH4[k].close < (sb.emaSlow[k] as number);
    btcOk = !(stb.state === "DOWNTREND" && below);
    btcDetail = `BTC 4H structure ${stb.state}, BTC ${below ? "below" : "above"} its 4H EMA${s.emaSlow}`;
  }
  conds.push(cond("b11_btc", "Bitcoin is not in a 4H downtrend below its trend line (altcoins follow BTC)", btcOk, btcDetail, "trigger"));

  const all = (...ids: string[]) => ids.every((id) => conds.find((c) => c.id === id)?.passed);
  const context = all("b1_support", "b2_approach", "b3_holding", "b4_h4_context");
  const base = context && all("b5_h4_momentum", "b6_rsi", "b7_macd", "b10_levels", "b11_btc");
  const potential = base && (all("b8_reversal") || all("b9_volume"));
  const full = base && all("b8_reversal", "b9_volume");
  return {
    strategy: "BOUNCE", dataOk: true, dataIssue: null, conditions: conds, context, potential, full: full && !p.previewing,
    price, candleStart: last.start, levels, reasons: reasonsOf(conds), variant: null,
    refs: { zoneLow: support ? support.low : null, zoneHigh: support ? support.high : null, atr },
  };
}

// ── Exit warning ─────────────────────────────────────────────────────────────

export function evaluateExitWarning(input: EvalInput): SetupEval {
  const issue = dataIssue(input);
  if (issue) return empty("EXIT_WARNING", issue);
  const s = input.settings;
  const p = prepare(input);
  const { h1, n } = p;
  const i = n - 1;
  const last = h1[i];
  const price = last.close;
  const s1 = computeSeries(h1, s);
  const atr = s1.atr[i];
  if (atr === null || !(atr > 0)) return empty("EXIT_WARNING", "ATR could not be computed.");

  const piv = findPivots(h1, STRUCTURE.pivotK1h, STRUCTURE.lookback1h);
  const zones = buildZones([...piv.highs, ...piv.lows], atr);
  const res = nearestResistance(zones, price, atr);
  const conds: Cond[] = [];

  const atRes = !!res && price >= res.low - 1.0 * atr && price <= res.high + 0.25 * atr;
  conds.push(cond("e1_resistance", "Price is at or just below an established resistance zone", atRes,
    res ? `Zone ${f(res.low)}–${f(res.high)}, ${res.touches} touches; price ${f(price)}` : "No established resistance zone nearby", "context"));

  // E2 overbought and rolling over.
  const rs = s1.rsi;
  const w6 = rs.slice(-6).filter((v): v is number => v !== null);
  const maxRsi = w6.length ? Math.max(...w6) : null;
  const rNow = rs[i];
  const s4 = computeSeries(input.h4Closed, s);
  const r4 = s4.rsi[input.h4Closed.length - 1];
  const rolling = rsiRollingOver(maxRsi, rNow);
  const h4Over = r4 !== null && r4 >= 70;
  conds.push(cond("e2_rsi", `RSI was overbought (${SETUP.rsiOverbought}+) and is rolling over, or 4H RSI is 70+`, rolling || h4Over,
    `1h RSI high ${maxRsi === null ? "n/a" : x1(maxRsi)}, now ${rNow === null ? "n/a" : x1(rNow)}; 4h RSI ${r4 === null ? "n/a" : x1(r4)}`, "trigger"));

  // E3 MACD weakening.
  const hh = s1.macdHist, ml = s1.macd, sg = s1.macdSignal;
  const falling2 = hh[i] !== null && hh[i - 1] !== null && hh[i - 2] !== null && (hh[i] as number) < (hh[i - 1] as number) && (hh[i - 1] as number) < (hh[i - 2] as number);
  let crossedDown = false;
  for (let k = 1; k <= 3; k++) {
    if (ml[i] !== null && sg[i] !== null && ml[i - k] !== null && sg[i - k] !== null && (ml[i] as number) < (sg[i] as number) && (ml[i - k] as number) >= (sg[i - k] as number)) crossedDown = true;
  }
  conds.push(cond("e3_macd", "MACD momentum is weakening (histogram falling 2 candles in a row, or a bearish cross)", falling2 || crossedDown,
    hh[i] === null ? "MACD unavailable" : `Histogram ${x2(hh[i] as number)}${falling2 ? ", falling 2 candles" : ""}${crossedDown ? ", MACD crossed below its signal line" : ""}`, "trigger"));

  // E4 bearish reversal evidence at the zone.
  let bearIdx: number | null = null;
  let bearKind = "";
  if (res) {
    for (const x of [i, i - 1]) {
      const c = h1[x], pc = h1[x - 1];
      if (!c || !pc || !(range(c) > 0)) continue;
      const atZone = c.high >= res.low - 0.25 * atr;
      if (!atZone) continue;
      const star = geq(upperWick(c), 2 * Math.max(body(c), 1e-12), c.high) && leq(c.close, c.low + 0.4 * range(c), c.high);
      const engulf = c.close < c.open && pc.close > pc.open && c.close < pc.open && c.open >= pc.close;
      const belowLow = c.close < pc.low;
      if (star) { bearIdx = x; bearKind = "shooting-star rejection"; break; }
      if (engulf) { bearIdx = x; bearKind = "bearish engulfing"; break; }
      if (belowLow) { bearIdx = x; bearKind = "close below the prior low after touching the zone"; break; }
    }
  }
  conds.push(cond("e4_reversal", "Bearish reversal evidence at the zone", bearIdx !== null,
    bearIdx === null ? "No shooting star, bearish engulfing or close below the prior low at the zone" : `${bearKind}${bearIdx === i && p.previewing ? " (candle still forming)" : ""}`, "trigger"));

  // E5 volume supports the selling.
  const vrAt = (x: number): number | null => (p.previewing && p.volPending && x === i ? null : volumeRatio(h1, x));
  const lo = p.previewing && p.volPending ? i - 3 : i - 2;
  const trio = h1.slice(Math.max(0, lo), lo + 3);
  const upV = trio.filter((c) => c.close >= c.open).reduce((a, c) => a + c.volume, 0);
  const dnV = trio.filter((c) => c.close < c.open).reduce((a, c) => a + c.volume, 0);
  const bearVr = bearIdx !== null ? vrAt(bearIdx) : null;
  const m3e = meanVr3(h1, i, p.previewing && p.volPending);
  const volOk = (bearVr !== null && bearVr >= SETUP.bearishVolume && h1[bearIdx as number].close < h1[bearIdx as number].open) || (m3e !== null && m3e >= 1.0 && dnV > upV);
  conds.push(cond("e5_volume", "Volume supports the selling (bearish candle at 1.2× average, or the last 3 candles average 1.0× with sellers ahead)", volOk,
    `Bearish candle volume ${bearVr === null ? (bearIdx !== null && p.volPending && bearIdx === i ? "pending (candle < 25% complete)" : "n/a") : x2(bearVr) + "× average"}; down-candle volume ${dnV > upV ? "exceeds" : "does not exceed"} up-candle volume`, "trigger"));

  // E6 false breakout above the zone.
  const br = classifyBreaks(h1, res, atr, "resistance", 6);
  const falseB = br.falseBreakout || br.rejectionAbove;
  conds.push(cond("e6_false_breakout", "A false breakout / rejection above the resistance zone", falseB,
    br.falseBreakout ? "Price closed above the zone then back inside it" : br.rejectionAbove ? "A wick poked above the zone but the candle closed inside it" : "None seen", "trigger"));

  // E7 lower high after a higher high.
  const hs = piv.highs;
  let lowerHigh = false;
  let lhDetail = "Fewer than three swing highs";
  if (hs.length >= 3) {
    const a = hs[hs.length - 3].price, b = hs[hs.length - 2].price, c = hs[hs.length - 1].price;
    lowerHigh = b > a + STRUCTURE.trendTolAtr * atr && c < b - STRUCTURE.trendTolAtr * atr;
    lhDetail = `Swing highs ${f(a)} → ${f(b)} → ${f(c)}${lowerHigh ? " (a higher high followed by a lower high)" : ""}`;
  }
  conds.push(cond("e7_lower_high", "Structure weakening: a lower high after a higher high", lowerHigh, lhDetail, "trigger"));

  // Breakdown variant: a strong close below established support.
  let bd = false;
  let bdDetail = "No established support zone nearby";
  const supBefore = nearestSupport(zones, h1[i - 1].close, atr);
  if (supBefore) {
    const vr = vrAt(i);
    bd = last.close < supBefore.low - STRUCTURE.breakAtr * atr && vr !== null && vr >= STRUCTURE.breakVolume;
    bdDetail = `Support ${f(supBefore.low)}–${f(supBefore.high)}; close ${f(last.close)}; volume ${vr === null ? "pending" : x2(vr) + "×"}`;
  }
  conds.push(cond("e8_breakdown", "Breakdown: a close below established support on strong volume", bd, bdDetail, "trigger"));

  const evidence = ["e2_rsi", "e3_macd", "e4_reversal", "e5_volume", "e6_false_breakout", "e7_lower_high"].filter((id) => conds.find((c) => c.id === id)?.passed);
  const has = (id: string) => evidence.includes(id);
  const resPotential = atRes && evidence.length >= 3 && (has("e4_reversal") || has("e6_false_breakout"));
  const resFull = resPotential && has("e5_volume");
  const context = (atRes && evidence.length >= 1) || bd;
  const potential = resPotential || bd;
  const full = resFull || bd;
  return {
    strategy: "EXIT_WARNING", dataOk: true, dataIssue: null, conditions: conds, context, potential, full: full && !p.previewing,
    price, candleStart: last.start, levels: null, reasons: reasonsOf(conds), variant: bd && !resPotential ? "breakdown" : "resistance",
    refs: bd && !resPotential ? { zoneLow: supBefore ? supBefore.low : null, zoneHigh: supBefore ? supBefore.high : null, atr } : { zoneLow: res ? res.low : null, zoneHigh: res ? res.high : null, atr },
  };
}

export function evaluateStrategy(id: StrategyId, input: EvalInput): SetupEval {
  return id === "TREND_BUY" ? evaluateTrendSetup(input) : id === "BOUNCE" ? evaluateBounce(input) : evaluateExitWarning(input);
}

export const STRATEGIES: StrategyId[] = ["TREND_BUY", "BOUNCE", "EXIT_WARNING"];
