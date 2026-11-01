import { step, type SetupState } from "./lifecycle";
import { DEFAULT_SETTINGS } from "./settings";
import { elapsedFraction, evaluateStrategy, SETUP, STRATEGIES, type SetupEval, type SetupLevels, type StrategyId } from "./setups";
import { INTERVAL_MS, type Candle, type Settings } from "./types";

/**
 * Historical back-test of the three setup strategies. Pure functions, no network, no database.
 *
 * It replays 5-minute history exactly the way the live monitor scans: every 5 minutes it builds the closed 1H and 4H
 * candles known at that moment plus the still-forming 1H candle, then calls the SAME `evaluateStrategy` and `step`
 * functions the monitor uses. Nothing after the scan time is visible to a scan (tested: a replay of truncated data
 * reproduces the signals of the full replay).
 *
 * Trades are simulated separately from signal detection so the same signals can be re-priced under different
 * execution delays, fees and slippage. Nothing here places an order; it is arithmetic on historical candles.
 */

export const M5 = 5 * 60_000;
const H1 = INTERVAL_MS["60"];
const H4 = INTERVAL_MS["240"];

// ── candles ──────────────────────────────────────────────────────────────────

/** Aggregates 5m candles into complete candles of `ms` (incomplete buckets are dropped, never padded). */
export function aggregate(c5: Candle[], ms: number): Candle[] {
  const per = ms / M5;
  const buckets = new Map<number, Candle[]>();
  for (const c of c5) {
    const b = Math.floor(c.start / ms) * ms;
    const arr = buckets.get(b);
    if (arr) arr.push(c); else buckets.set(b, [c]);
  }
  const out: Candle[] = [];
  for (const [start, arr] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (arr.length !== per) continue;
    out.push(merge(start, arr));
  }
  return out;
}

function merge(start: number, arr: Candle[]): Candle {
  let high = -Infinity, low = Infinity, volume = 0, turnover = 0;
  for (const c of arr) { if (c.high > high) high = c.high; if (c.low < low) low = c.low; volume += c.volume; turnover += c.turnover; }
  return { start, open: arr[0].open, high, low, close: arr[arr.length - 1].close, volume, turnover };
}

// ── replay (signal detection) ────────────────────────────────────────────────

export interface Sig {
  symbol: string;
  strategy: StrategyId;
  kind: "POTENTIAL" | "CONFIRMED";
  /** Scan time. The signal uses only data that existed before this moment. */
  at: number;
  price: number;
  levels: SetupLevels | null;
  atr: number | null;
  converted: boolean;
}

export interface ReplayOptions {
  startMs: number;
  endMs: number;
  /** Design default true. False skips the 4H-momentum conflict check (sensitivity run). */
  h4Conflict?: boolean;
  settings?: Settings;
  strategies?: StrategyId[];
}

export interface ReplayResult {
  sigs: Sig[];
  raised: Record<StrategyId, number>;
  converted: Record<StrategyId, number>;
  scans: number;
  skippedScans: number;
}

export function replay(symbol: string, c5: Candle[], btc5: Candle[] | null, opts: ReplayOptions): ReplayResult {
  const settings = opts.settings ?? DEFAULT_SETTINGS;
  const strategies = opts.strategies ?? STRATEGIES;
  const idx = new Map<number, number>();
  c5.forEach((c, i) => idx.set(c.start, i));
  const h1 = aggregate(c5, H1);
  const h4 = aggregate(c5, H4);
  const btc4 = btc5 ? aggregate(btc5, H4) : null;
  const res: ReplayResult = { sigs: [], raised: { TREND_BUY: 0, BOUNCE: 0, EXIT_WARNING: 0 }, converted: { TREND_BUY: 0, BOUNCE: 0, EXIT_WARNING: 0 }, scans: 0, skippedScans: 0 };
  const prev: Partial<Record<StrategyId, SetupState | null>> = {};
  let n1 = 0, n4 = 0, nb = 0;
  let cacheKey = -1;
  let cache: Partial<Record<StrategyId, SetupEval>> = {};
  const start = Math.ceil(opts.startMs / M5) * M5;

  for (let T = start; T <= opts.endMs; T += M5) {
    const last = idx.get(T - M5);
    if (last === undefined) { res.skippedScans++; continue; } // no data for this moment: the live monitor would also see nothing new
    while (n1 < h1.length && h1[n1].start + H1 <= T) n1++;
    while (n4 < h4.length && h4[n4].start + H4 <= T) n4++;
    while (btc4 && nb < btc4.length && btc4[nb].start + H4 <= T) nb++;
    if (n1 < 60 || n4 < 30) { res.skippedScans++; continue; }
    const h1Closed = h1.slice(Math.max(0, n1 - 400), n1);
    const h4Closed = h4.slice(Math.max(0, n4 - 150), n4);
    const btcClosed = btc4 ? btc4.slice(Math.max(0, nb - 150), nb) : null;
    const common = { symbol, h1Closed, h4Closed, now: T, settings, btcH4: btcClosed, h4Conflict: opts.h4Conflict };
    if (cacheKey !== n1) { cache = {}; cacheKey = n1; }

    // The unfinished 1H candle as the exchange would show it at this moment.
    const hs = Math.floor(T / H1) * H1;
    let forming: Candle | null = null;
    if (T > hs && h1Closed[h1Closed.length - 1].start === hs - H1 && elapsedFraction(hs, T) >= SETUP.minElapsed) {
      const i0 = idx.get(hs);
      if (i0 !== undefined) forming = merge(hs, c5.slice(i0, last + 1));
    }

    res.scans++;
    const price = c5[last].close;
    for (const strategy of strategies) {
      const closed = (cache[strategy] ??= evaluateStrategy(strategy, { ...common, forming: null }));
      if (!closed.dataOk) continue;
      const preview = forming ? evaluateStrategy(strategy, { ...common, forming }) : null;
      const r = step(prev[strategy] ?? null, symbol, strategy, { now: T, price, closed, preview });
      if (r.state) prev[strategy] = r.state;
      for (const ev of r.events) {
        if (ev.kind !== "POTENTIAL" && ev.kind !== "CONFIRMED") continue;
        const st = r.state as SetupState;
        if (ev.kind === "POTENTIAL") res.raised[strategy]++;
        if (ev.kind === "CONFIRMED" && st.convertedFromPotential) res.converted[strategy]++;
        res.sigs.push({ symbol, strategy, kind: ev.kind, at: T, price: ev.price ?? price, levels: st.levels, atr: st.refs.atr, converted: ev.kind === "CONFIRMED" && st.convertedFromPotential });
      }
    }
  }
  return res;
}

// ── trade simulation ─────────────────────────────────────────────────────────

export interface Costs {
  /** Per side, percent. */
  feePct: number;
  /** Per side, percent, applied against us on every fill. */
  slipPct: number;
  /** Minutes between the signal and the fill. */
  delayMin: number;
}

export interface Exits {
  /** Used when the signal has no levels (Trend BUY): fixed percentages of the fill price, like the existing rules. */
  stopPct: number;
  targetPct: number;
  maxHoldMs: number;
}

export const BASE_COSTS: Costs = { feePct: 0.1, slipPct: 0.05, delayMin: 5 };
export const STRESS_COSTS: Costs = { feePct: 0.2, slipPct: 0.1, delayMin: 5 };
export const DEFAULT_EXITS: Exits = { stopPct: 2, targetPct: 4, maxHoldMs: 24 * 3600_000 };

export interface Trade {
  symbol: string;
  signalAt: number;
  entryAt: number;
  exitAt: number;
  entry: number;
  exit: number;
  reason: "target" | "stop" | "time";
  netPct: number;
  /** Net result divided by the planned risk (distance to the stop, as a fraction of the fill price). */
  r: number;
}

export type SimOutcome = { trade: Trade } | { skipped: "not-fillable" | "no-data" };

export function simulateTrade(sig: { symbol: string; at: number; levels: SetupLevels | null }, c5: Candle[], index: Map<number, number>, costs: Costs, exits: Exits, override?: { stopFrac: number; targetFrac: number }): SimOutcome {
  const entryStart = Math.ceil((sig.at + costs.delayMin * 60_000) / M5) * M5;
  const i0 = index.get(entryStart);
  if (i0 === undefined) return { skipped: "no-data" };
  const slip = costs.slipPct / 100, fee = costs.feePct / 100;
  const raw = c5[i0].open;
  const fill = raw * (1 + slip);
  let stop: number, target: number;
  if (override) { stop = raw * (1 - override.stopFrac); target = raw * (1 + override.targetFrac); }
  else if (sig.levels) { stop = sig.levels.stop; target = sig.levels.target; }
  else { stop = raw * (1 - exits.stopPct / 100); target = raw * (1 + exits.targetPct / 100); }
  if (!(fill > stop) || !(fill < target)) return { skipped: "not-fillable" }; // price already beyond the stop or the target
  const riskFrac = (fill - stop) / fill;
  const last = Math.min(c5.length - 1, i0 + Math.round(exits.maxHoldMs / M5));
  let exitRaw = c5[last].close, reason: Trade["reason"] = "time", exitAt = c5[last].start + M5;
  for (let j = i0; j <= last; j++) {
    const c = c5[j];
    if (c.low <= stop) { exitRaw = Math.min(stop, c.open); reason = "stop"; exitAt = c.start + M5; break; } // a candle that touches both counts as the stop
    if (c.high >= target) { exitRaw = target; reason = "target"; exitAt = c.start + M5; break; }
  }
  const exitFill = exitRaw * (1 - slip);
  const netPct = ((exitFill * (1 - fee)) / (fill * (1 + fee)) - 1) * 100;
  return { trade: { symbol: sig.symbol, signalAt: sig.at, entryAt: c5[i0].start, exitAt, entry: fill, exit: exitFill, reason, netPct, r: riskFrac > 0 ? netPct / (riskFrac * 100) : 0 } };
}

export interface SimSummary { trades: Trade[]; skippedNotFillable: number; skippedNoData: number; skippedOverlap: number }

/** Simulates one list of signals (one coin, in time order). A new signal is ignored while the previous trade of the same row is still open. */
export function simulateSignals(sigs: Array<{ symbol: string; at: number; levels: SetupLevels | null }>, c5: Candle[], index: Map<number, number>, costs: Costs, exits: Exits, override?: { stopFrac: number; targetFrac: number }): SimSummary {
  const out: SimSummary = { trades: [], skippedNotFillable: 0, skippedNoData: 0, skippedOverlap: 0 };
  let busyUntil = 0;
  for (const s of [...sigs].sort((a, b) => a.at - b.at)) {
    if (s.at < busyUntil) { out.skippedOverlap++; continue; }
    const r = simulateTrade(s, c5, index, costs, exits, override);
    if ("skipped" in r) { if (r.skipped === "not-fillable") out.skippedNotFillable++; else out.skippedNoData++; continue; }
    out.trades.push(r.trade);
    busyUntil = r.trade.exitAt;
  }
  return out;
}

// ── statistics ───────────────────────────────────────────────────────────────

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export interface Stats {
  n: number;
  winRatePct: number | null;
  avgNetPct: number | null;
  avgR: number | null;
  profitFactor: number | null;
  maxDrawdownPct: number;
  totalNetPct: number;
  /** 95% bootstrap interval of the mean R (percentile method, fixed seed). */
  ciR: [number, number] | null;
  losers: number;
}

export function bootstrapMeanCI(xs: number[], draws = 2000, seed = 12345): [number, number] | null {
  if (xs.length < 2) return null;
  const r = rng(seed);
  const means: number[] = [];
  for (let d = 0; d < draws; d++) { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[Math.floor(r() * xs.length)]; means.push(s / xs.length); }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * draws)], means[Math.min(draws - 1, Math.floor(0.975 * draws))]];
}

export function statsOf(trades: Trade[]): Stats {
  const t = [...trades].sort((a, b) => a.exitAt - b.exitAt);
  const n = t.length;
  if (n === 0) return { n: 0, winRatePct: null, avgNetPct: null, avgR: null, profitFactor: null, maxDrawdownPct: 0, totalNetPct: 0, ciR: null, losers: 0 };
  const wins = t.filter((x) => x.netPct > 0), losses = t.filter((x) => x.netPct <= 0);
  const gw = wins.reduce((a, x) => a + x.netPct, 0), gl = Math.abs(losses.reduce((a, x) => a + x.netPct, 0));
  let eq = 0, peak = 0, dd = 0;
  for (const x of t) { eq += x.netPct; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; }
  const total = t.reduce((a, x) => a + x.netPct, 0);
  return { n, winRatePct: (wins.length / n) * 100, avgNetPct: total / n, avgR: t.reduce((a, x) => a + x.r, 0) / n, profitFactor: gl > 0 ? gw / gl : null, maxDrawdownPct: dd, totalNetPct: total, ciR: bootstrapMeanCI(t.map((x) => x.r)), losers: losses.length };
}

export const MIN_SIGNALS = 30;

export interface Verdict { label: "INCONCLUSIVE" | "NOT VALIDATED" | "SCREEN PASSED"; reasons: string[] }

/**
 * The only rule used to describe a strategy. It looks at OUT-OF-SAMPLE trades only (the last 40% of the period, never used to design anything).
 * "SCREEN PASSED" is the most this back-test can ever say: it is a minimum filter, not proof of profit.
 */
export function verdict(oos: Trade[], oosStress: Trade[]): Verdict {
  const s = statsOf(oos);
  if (s.n < MIN_SIGNALS) return { label: "INCONCLUSIVE", reasons: [`only ${s.n} out-of-sample trade(s); at least ${MIN_SIGNALS} are needed before any conclusion`] };
  const reasons: string[] = [];
  if (!(s.avgR !== null && s.avgR > 0)) reasons.push(`average net result per trade is not positive (${s.avgR?.toFixed(2)}R)`);
  if (!(s.ciR && s.ciR[0] > 0)) reasons.push(`the 95% bootstrap interval of the average includes zero or below (${s.ciR ? s.ciR[0].toFixed(2) : "n/a"}R lower bound)`);
  const st = statsOf(oosStress);
  if (!(st.avgR !== null && st.avgR > 0)) reasons.push(`with costs doubled the average is not positive (${st.avgR?.toFixed(2)}R)`);
  return reasons.length ? { label: "NOT VALIDATED", reasons } : { label: "SCREEN PASSED", reasons: ["positive out of sample, interval above zero, and still positive with doubled costs. This is a minimum screen, not proof of future profit"] };
}

// ── market helpers ───────────────────────────────────────────────────────────

export function atr14(h1: Candle[], endExclusive: number): number | null {
  if (endExclusive < 15) return null;
  let sum = 0;
  for (let i = endExclusive - 14; i < endExclusive; i++) {
    const c = h1[i], p = h1[i - 1];
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return sum / 14;
}

/** Which barrier is touched first in the 5m candles from index `i0`. A candle touching both counts as `tie`. */
export function firstBarrier(c5: Candle[], i0: number, upper: number, lower: number, maxMs: number, tie: "up" | "down"): "up" | "down" | "none" {
  const last = Math.min(c5.length - 1, i0 + Math.round(maxMs / M5));
  for (let j = i0; j <= last; j++) {
    const u = c5[j].high >= upper, d = c5[j].low <= lower;
    if (u && d) return tie;
    if (u) return "up";
    if (d) return "down";
  }
  return "none";
}

// ── whole report ─────────────────────────────────────────────────────────────

export interface CoinData { symbol: string; c5: Candle[]; on: ReplayResult; off: ReplayResult }

export interface RowResult {
  id: string;
  label: string;
  note: string;
  signals: number;
  perCoin: Record<string, number>;
  traded: number;
  skipped: { overlap: number; notFillable: number; noData: number };
  all: Stats;
  inSample: Stats;
  outOfSample: Stats;
  delay0: Stats;
  delay15: Stats;
  stress2x: Stats;
  baseline: { avgNetPct: number | null; draws: number };
  falsePositivePct: number | null;
  verdict: Verdict;
}

interface RowSpec { id: string; label: string; note: string; pick: (c: CoinData) => Sig[] }

const rowSpecs: RowSpec[] = [
  { id: "trend_confirmed", label: "Trend BUY · confirmed (closed candle)", note: "the existing BUY rules, fixed 2% stop / 4% target, 24h max hold", pick: (c) => c.on.sigs.filter((s) => s.strategy === "TREND_BUY" && s.kind === "CONFIRMED") },
  { id: "trend_early", label: "Trend BUY · early (forming candle)", note: "same rules read on the unfinished candle", pick: (c) => c.on.sigs.filter((s) => s.strategy === "TREND_BUY" && s.kind === "POTENTIAL") },
  { id: "bounce_confirmed", label: "Support-Bounce · confirmed (4H conflict check ON, as designed)", note: "stop below the zone, target = next resistance or 2R, 24h max hold", pick: (c) => c.on.sigs.filter((s) => s.strategy === "BOUNCE" && s.kind === "CONFIRMED") },
  { id: "bounce_early", label: "Support-Bounce · early (4H conflict check ON)", note: "read on the unfinished candle", pick: (c) => c.on.sigs.filter((s) => s.strategy === "BOUNCE" && s.kind === "POTENTIAL") },
  { id: "bounce_confirmed_no4h", label: "Support-Bounce · confirmed (4H conflict check OFF, sensitivity run)", note: "shown only to measure what the 4H check costs or saves", pick: (c) => c.off.sigs.filter((s) => s.strategy === "BOUNCE" && s.kind === "CONFIRMED") },
  { id: "bounce_early_no4h", label: "Support-Bounce · early (4H conflict check OFF, sensitivity run)", note: "sensitivity run", pick: (c) => c.off.sigs.filter((s) => s.strategy === "BOUNCE" && s.kind === "POTENTIAL") },
];

/**
 * Is a warning's precision better than a random moment? Needs at least MIN_SIGNALS warnings and a margin of 2 standard errors
 * (one-sided z test against the baseline rate). Anything less is not described as better than chance.
 */
export function exitVerdict(n: number, fell: number, baselinePct: number | null): string {
  if (n < MIN_SIGNALS) return `INCONCLUSIVE (only ${n} confirmed warning(s); ${MIN_SIGNALS} needed)`;
  if (baselinePct === null) return "INCONCLUSIVE (no baseline)";
  const b = baselinePct / 100, p = fell / n;
  const z = (p - b) / Math.sqrt((b * (1 - b)) / n);
  if (z >= 2) return `Better than a random moment in this sample (z=${z.toFixed(1)}). Still not proof of future value; no out-of-sample split is applied to this measure`;
  return `NOT VALIDATED: ${(p * 100).toFixed(1)}% vs ${baselinePct.toFixed(1)}% for a random moment (z=${z.toFixed(1)}); not distinguishable from chance`;
}

export interface ExitWarningResult {
  confirmed: { n: number; fellFirst: number; roseFirst: number; neither: number; precisionPct: number | null };
  early: { n: number; fellFirst: number; roseFirst: number; neither: number; precisionPct: number | null };
  baseline: { n: number; fellFirstPct: number | null };
  note: string;
  verdict: string;
}

export interface OpportunityResult {
  opportunities: number;
  caughtByConfirmed: number;
  caughtByEarly: number;
  missedPct: number | null;
  note: string;
}

export interface BacktestReport {
  period: { startMs: number; endMs: number; splitMs: number };
  coins: string[];
  scansPerCoin: Record<string, number>;
  costs: { base: Costs; stress: Costs };
  rows: RowResult[];
  exitWarning: ExitWarningResult;
  opportunities: OpportunityResult;
  conversion: { raised: Record<StrategyId, number>; converted: Record<StrategyId, number> };
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

export function buildReport(coins: CoinData[], period: { startMs: number; endMs: number }, seed = 7): BacktestReport {
  const splitMs = period.startMs + 0.6 * (period.endMs - period.startMs);
  const indexes = new Map(coins.map((c) => [c.symbol, new Map(c.c5.map((x, i) => [x.start, i]))]));
  const get = (c: CoinData) => ({ idx: indexes.get(c.symbol) as Map<number, number> });

  const rows: RowResult[] = rowSpecs.map((spec) => {
    const run = (costs: Costs, override?: (sigs: Sig[]) => { stopFrac: number; targetFrac: number } | undefined) => {
      const agg: SimSummary = { trades: [], skippedNotFillable: 0, skippedNoData: 0, skippedOverlap: 0 };
      for (const c of coins) {
        const sigs = spec.pick(c);
        const r = simulateSignals(sigs, c.c5, get(c).idx, costs, DEFAULT_EXITS, override ? override(sigs) : undefined);
        agg.trades.push(...r.trades); agg.skippedNotFillable += r.skippedNotFillable; agg.skippedNoData += r.skippedNoData; agg.skippedOverlap += r.skippedOverlap;
      }
      return agg;
    };
    const base = run(BASE_COSTS);
    const d0 = run({ ...BASE_COSTS, delayMin: 0 });
    const d15 = run({ ...BASE_COSTS, delayMin: 15 });
    const stress = run(STRESS_COSTS);
    const is = base.trades.filter((t) => t.signalAt < splitMs);
    const oos = base.trades.filter((t) => t.signalAt >= splitMs);
    const oosStress = stress.trades.filter((t) => t.signalAt >= splitMs);

    // Random-entry baseline with the same stop/target distances and costs, same number of entries per coin.
    let baselineAvg: number | null = null;
    const draws = 20;
    if (base.trades.length > 0) {
      const allSigs = coins.flatMap((c) => spec.pick(c));
      const withLevels = allSigs.filter((s) => s.levels);
      const stopFrac = withLevels.length ? median(withLevels.map((s) => ((s.levels as SetupLevels).entry - (s.levels as SetupLevels).stop) / (s.levels as SetupLevels).entry)) : DEFAULT_EXITS.stopPct / 100;
      const targetFrac = withLevels.length ? median(withLevels.map((s) => ((s.levels as SetupLevels).target - (s.levels as SetupLevels).entry) / (s.levels as SetupLevels).entry)) : DEFAULT_EXITS.targetPct / 100;
      const r = rng(seed);
      const means: number[] = [];
      for (let d = 0; d < draws; d++) {
        const nets: number[] = [];
        for (const c of coins) {
          const n = base.trades.filter((t) => t.symbol === c.symbol).length;
          const h = c.c5.filter((x) => x.start % H1 === 0 && x.start >= period.startMs && x.start <= period.endMs - 26 * 3600_000);
          for (let k = 0; k < n && h.length; k++) {
            const pick = h[Math.floor(r() * h.length)];
            const o = simulateTrade({ symbol: c.symbol, at: pick.start, levels: null }, c.c5, get(c).idx, BASE_COSTS, DEFAULT_EXITS, { stopFrac, targetFrac });
            if ("trade" in o) nets.push(o.trade.netPct);
          }
        }
        if (nets.length) means.push(nets.reduce((a, b) => a + b, 0) / nets.length);
      }
      baselineAvg = means.length ? means.reduce((a, b) => a + b, 0) / means.length : null;
    }

    const all = statsOf(base.trades);
    return {
      id: spec.id, label: spec.label, note: spec.note,
      signals: coins.reduce((a, c) => a + spec.pick(c).length, 0),
      perCoin: Object.fromEntries(coins.map((c) => [c.symbol, spec.pick(c).length])),
      traded: base.trades.length,
      skipped: { overlap: base.skippedOverlap, notFillable: base.skippedNotFillable, noData: base.skippedNoData },
      all, inSample: statsOf(is), outOfSample: statsOf(oos), delay0: statsOf(d0.trades), delay15: statsOf(d15.trades), stress2x: statsOf(stress.trades),
      baseline: { avgNetPct: baselineAvg, draws },
      falsePositivePct: all.n ? (all.losers / all.n) * 100 : null,
      verdict: verdict(oos, oosStress),
    };
  });

  // Exit warning: did price fall by 1.5 hourly ATR before rising by 1.5 ATR within 24h? (a tie counts as NOT a fall).
  const ew = (kind: "CONFIRMED" | "POTENTIAL") => {
    let fell = 0, rose = 0, none = 0;
    for (const c of coins) {
      const h1 = aggregate(c.c5, H1);
      const idx = get(c).idx;
      for (const s of c.on.sigs.filter((x) => x.strategy === "EXIT_WARNING" && x.kind === kind)) {
        const i0 = idx.get(Math.ceil((s.at + BASE_COSTS.delayMin * 60_000) / M5) * M5);
        const hi = h1.findIndex((x) => x.start >= Math.floor(s.at / H1) * H1);
        const a = atr14(h1, hi < 0 ? h1.length : hi);
        if (i0 === undefined || a === null) continue;
        const p = c.c5[i0].open;
        const o = firstBarrier(c.c5, i0, p + 1.5 * a, p - 1.5 * a, 24 * 3600_000, "up");
        if (o === "down") fell++; else if (o === "up") rose++; else none++;
      }
    }
    const n = fell + rose + none;
    return { n, fellFirst: fell, roseFirst: rose, neither: none, precisionPct: n ? (fell / n) * 100 : null };
  };
  const ewConfirmed = ew("CONFIRMED"), ewEarly = ew("POTENTIAL");
  let bFell = 0, bN = 0;
  for (const c of coins) {
    const h1 = aggregate(c.c5, H1);
    const idx = get(c).idx;
    for (let i = 20; i < h1.length; i++) {
      const t = h1[i].start + H1;
      if (t < period.startMs || t > period.endMs - 26 * 3600_000) continue;
      const i0 = idx.get(t); const a = atr14(h1, i + 1);
      if (i0 === undefined || a === null) continue;
      const p = c.c5[i0].open;
      bN++;
      if (firstBarrier(c.c5, i0, p + 1.5 * a, p - 1.5 * a, 24 * 3600_000, "up") === "down") bFell++;
    }
  }
  const baselineFell = bN ? (bFell / bN) * 100 : null;
  const exitWarning: ExitWarningResult = {
    confirmed: ewConfirmed, early: ewEarly, baseline: { n: bN, fellFirstPct: baselineFell },
    note: "Precision = share of warnings after which price fell 1.5 hourly ATR before rising 1.5 ATR within 24h (execution delay 5 min). The baseline is the same measure at EVERY hourly close, i.e. what a random moment gives.",
    verdict: exitVerdict(ewConfirmed.n, ewConfirmed.fellFirst, baselineFell),
  };

  // False negatives: hindsight pivot lows that were followed by +2R before -1R (R = 1.5 hourly ATR), and whether a LONG-type signal appeared near them.
  let opps = 0, caughtC = 0, caughtE = 0;
  for (const c of coins) {
    const h1 = aggregate(c.c5, H1);
    const idx = get(c).idx;
    const longSigs = c.on.sigs.filter((s) => s.strategy === "BOUNCE" || s.strategy === "TREND_BUY");
    for (let i = 3; i < h1.length - 3; i++) {
      const t = h1[i].start + H1;
      if (t < period.startMs || t > period.endMs - 26 * 3600_000) continue;
      let pivot = true;
      for (let k = 1; k <= 3; k++) if (!(h1[i].low < h1[i - k].low && h1[i].low <= h1[i + k].low)) { pivot = false; break; }
      if (!pivot) continue;
      const a = atr14(h1, i + 1);
      const i0 = idx.get(t);
      if (a === null || i0 === undefined) continue;
      const p = c.c5[i0].open;
      if (firstBarrier(c.c5, i0, p + 2 * 1.5 * a, p - 1.5 * a, 24 * 3600_000, "down") !== "up") continue;
      opps++;
      const win = (s: Sig) => s.at >= h1[i].start && s.at <= h1[i].start + 7 * H1;
      if (longSigs.some((s) => s.kind === "CONFIRMED" && win(s))) caughtC++;
      if (longSigs.some((s) => s.kind === "POTENTIAL" && win(s))) caughtE++;
    }
  }
  const opportunities: OpportunityResult = {
    opportunities: opps, caughtByConfirmed: caughtC, caughtByEarly: caughtE,
    missedPct: opps ? ((opps - Math.max(caughtC, caughtE)) / opps) * 100 : null,
    note: "Opportunity = a 1H swing low (known only in hindsight) after which price rose 2R before falling 1R within 24h, R = 1.5 hourly ATR. 'Caught' = a Support-Bounce or Trend BUY signal appeared between the low and 6 hours after it. Hindsight lows are an optimistic yardstick, so the miss rate is a rough guide, not a target.",
  };

  const raised = { TREND_BUY: 0, BOUNCE: 0, EXIT_WARNING: 0 }, converted = { TREND_BUY: 0, BOUNCE: 0, EXIT_WARNING: 0 };
  for (const c of coins) for (const k of STRATEGIES) { raised[k] += c.on.raised[k]; converted[k] += c.on.converted[k]; }
  return {
    period: { ...period, splitMs }, coins: coins.map((c) => c.symbol), scansPerCoin: Object.fromEntries(coins.map((c) => [c.symbol, c.on.scans])),
    costs: { base: BASE_COSTS, stress: STRESS_COSTS }, rows, exitWarning, opportunities, conversion: { raised, converted },
  };
}

// ── text output ──────────────────────────────────────────────────────────────

const f = (x: number | null, d = 2) => (x === null ? "n/a" : x.toFixed(d));
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const st = (s: Stats) => `n=${s.n} · win ${f(s.winRatePct, 0)}% · avg ${f(s.avgNetPct)}% (${f(s.avgR)}R) · PF ${f(s.profitFactor)} · maxDD ${f(s.maxDrawdownPct, 1)}%`;

export function formatReport(r: BacktestReport, source: string): string {
  const L: string[] = [];
  L.push(`# Setup strategies back-test`);
  L.push(`Data source: ${source}`);
  L.push(`Period replayed: ${day(r.period.startMs)} → ${day(r.period.endMs)} · in-sample (first 60%) ends ${day(r.period.splitMs)}; out-of-sample = the last 40% · coins: ${r.coins.join(", ")}`);
  L.push(`Costs per side: fee ${r.costs.base.feePct}% + slippage ${r.costs.base.slipPct}% · execution delay ${r.costs.base.delayMin} min (also tested 0 and 15 min) · stress run: fee ${r.costs.stress.feePct}% + slippage ${r.costs.stress.slipPct}%.`);
  L.push(`No parameter was tuned on this data. Paper arithmetic only: no order was placed.`);
  L.push("");
  for (const row of r.rows) {
    L.push(`## ${row.label}`);
    L.push(`(${row.note})`);
    L.push(`Signals: ${row.signals} (${Object.entries(row.perCoin).map(([k, v]) => `${k.replace("USDT", "")} ${v}`).join(", ")}) · simulated trades: ${row.traded} · skipped: ${row.skipped.overlap} overlapping, ${row.skipped.notFillable} not fillable, ${row.skipped.noData} no data`);
    if (row.signals < MIN_SIGNALS) L.push(`WARNING: fewer than ${MIN_SIGNALS} signals in total. Nothing below is statistically meaningful.`);
    L.push(`- All, delay 5 min:  ${st(row.all)}${row.all.ciR ? ` · 95% CI of avg R [${f(row.all.ciR[0])}, ${f(row.all.ciR[1])}]` : ""}`);
    L.push(`- In-sample (60%):   ${st(row.inSample)}`);
    L.push(`- OUT-of-sample:     ${st(row.outOfSample)}${row.outOfSample.ciR ? ` · 95% CI of avg R [${f(row.outOfSample.ciR[0])}, ${f(row.outOfSample.ciR[1])}]` : ""}`);
    L.push(`- Delay 0 / 15 min:  avg ${f(row.delay0.avgNetPct)}% (n=${row.delay0.n}) / ${f(row.delay15.avgNetPct)}% (n=${row.delay15.n})`);
    L.push(`- Costs doubled:     avg ${f(row.stress2x.avgNetPct)}% (n=${row.stress2x.n})`);
    L.push(`- Random-entry baseline (same stop/target, same costs, ${row.baseline.draws} draws): avg ${f(row.baseline.avgNetPct)}%`);
    L.push(`- False positives (losing trades): ${row.all.losers} of ${row.all.n} (${f(row.falsePositivePct, 0)}%)`);
    L.push(`- Verdict (out-of-sample rule): ${row.verdict.label} — ${row.verdict.reasons.join("; ")}`);
    L.push("");
  }
  const e = r.exitWarning;
  L.push(`## Exit warning (independent of any trade)`);
  L.push(`Confirmed: ${e.confirmed.n} warnings · fell first ${e.confirmed.fellFirst}, rose first ${e.confirmed.roseFirst}, neither ${e.confirmed.neither} · precision ${f(e.confirmed.precisionPct, 0)}%`);
  L.push(`Early: ${e.early.n} warnings · precision ${f(e.early.precisionPct, 0)}%`);
  L.push(`Random-moment baseline: ${f(e.baseline.fellFirstPct, 0)}% (n=${e.baseline.n})`);
  L.push(e.note);
  if (e.confirmed.n < MIN_SIGNALS) L.push(`WARNING: fewer than ${MIN_SIGNALS} confirmed exit warnings.`);
  L.push(`Verdict: ${e.verdict}`);
  L.push("");
  const o = r.opportunities;
  L.push(`## False negatives (missed opportunities)`);
  L.push(`${o.opportunities} hindsight opportunities · caught by a confirmed signal: ${o.caughtByConfirmed} · by an early signal: ${o.caughtByEarly} · missed: ${f(o.missedPct, 0)}%`);
  L.push(o.note);
  L.push("");
  L.push(`## Early → confirmed conversion`);
  for (const k of STRATEGIES) L.push(`${k}: ${r.conversion.raised[k]} early reads raised, ${r.conversion.converted[k]} confirmed at candle close, ${r.conversion.raised[k] - r.conversion.converted[k]} faded.`);
  L.push("");
  L.push(`## Limits of this test`);
  L.push(`- Prices come from ${source}. Bybit's own candles and order books differ slightly; fills, spreads and thin-market slippage are approximated by one fixed number.`);
  L.push(`- The unfinished candle is built from closed 5-minute candles, so an early read is seen up to 5 minutes later than the live monitor would see it.`);
  L.push(`- Trend BUY trades use fixed 2% stop / 4% target and a 24h limit; the live app also exits on a trend break, which is not modelled.`);
  L.push(`- One period of one market regime. Strong results here would still not predict future results; weak results are informative.`);
  return L.join("\n");
}
