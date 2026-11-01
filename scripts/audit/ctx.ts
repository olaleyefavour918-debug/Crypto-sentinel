import { computeSeries, evaluateBuy, evaluateExit, latestSnapshot } from "@/lib/rules";
import { evaluateBounce, evaluateExitWarning, type SetupEval } from "@/lib/setups";
import { aggregate, firstBarrier, M5 } from "@/lib/setups-backtest";
import { INTERVAL_MS, type BuyEvaluation, type Candle, type Settings, type TimeframeSnapshot } from "@/lib/types";

export const H1 = INTERVAL_MS["60"];
export const H4 = INTERVAL_MS["240"];
export const DAY = 86_400_000;
/** The live monitor fetches this many candles per timeframe (candlesToFetch with default settings). */
export const LIVE_WINDOW = 200;

export interface Feat { close: number; stretchAtr: number | null; riseAtr: number | null; ret6: number | null; ret24: number | null; rsi: number | null; volRatio: number | null; age1h: number; age4h: number; atr: number | null }

export interface HourRec {
  p: number;
  /** Time the candle closed (= the earliest moment a decision on it can be made). */
  ct: number;
  day: number;
  buy: BuyEvaluation;
  pass: Record<string, boolean>;
  snap: TimeframeSnapshot;
  bounce: SetupEval;
  exitW: SetupEval;
  feat: Feat | null;
}

export interface Ctx {
  symbol: string;
  c5: Candle[];
  idx: Map<number, number>;
  h1: Candle[];
  h4: Candle[];
  hours: HourRec[];
  settings: Settings;
}

export function buildCtx(symbol: string, c5: Candle[], btc5: Candle[] | null, evalFrom: number, endMs: number, settings: Settings): Ctx {
  const idx = new Map<number, number>();
  c5.forEach((c, i) => idx.set(c.start, i));
  const h1 = aggregate(c5, H1);
  const h4 = aggregate(c5, H4);
  const btc4 = btc5 ? aggregate(btc5, H4) : null;
  const full1 = computeSeries(h1, settings);
  const full4 = computeSeries(h4, settings);
  const hours: HourRec[] = [];
  let n4 = 0, nb = 0;
  for (let p = 0; p < h1.length; p++) {
    const ct = h1[p].start + H1;
    while (n4 < h4.length && h4[n4].start + H4 <= ct) n4++;
    while (btc4 && nb < btc4.length && btc4[nb].start + H4 <= ct) nb++;
    if (ct < evalFrom || ct > endMs || p < 60 || n4 < 30) continue;
    const h1w = h1.slice(Math.max(0, p + 1 - LIVE_WINDOW), p + 1);
    const h4w = h4.slice(Math.max(0, n4 - LIVE_WINDOW), n4);
    const btcw = btc4 ? btc4.slice(Math.max(0, nb - LIVE_WINDOW), nb) : null;
    const buy = evaluateBuy({ h1: h1w, h4: h4w, now: ct, settings });
    const pass: Record<string, boolean> = {};
    for (const c of buy.conditions) pass[c.id] = c.passed;
    const common = { symbol, h1Closed: h1w, h4Closed: h4w, forming: null, now: ct, settings, btcH4: btcw } as const;
    const snap = latestSnapshot(h1w, settings);
    let feat: Feat | null = null;
    if (buy.status !== "DATA_INVALID" && snap.atr && snap.emaFast !== null) {
      const last = h1[p];
      const lows = h1.slice(Math.max(0, p - 23), p + 1).map((c) => c.low);
      const prev = h1.slice(Math.max(0, p - 20), p);
      const avgVol = prev.length ? prev.reduce((a, c) => a + c.volume, 0) / prev.length : 0;
      let age1h = 0;
      for (let q = p; q >= 0; q--) { const a = full1.emaFast[q], b = full1.emaSlow[q]; if (a !== null && b !== null && a > b) age1h++; else break; }
      let age4h = 0;
      for (let q = n4 - 1; q >= 0; q--) { const a = full4.emaFast[q], b = full4.emaSlow[q]; if (a !== null && b !== null && a > b) age4h++; else break; }
      feat = {
        close: last.close, atr: snap.atr,
        stretchAtr: (last.close - snap.emaFast) / snap.atr,
        riseAtr: (last.close - Math.min(...lows)) / snap.atr,
        ret6: p >= 6 ? last.close / h1[p - 6].close - 1 : null,
        ret24: p >= 24 ? last.close / h1[p - 24].close - 1 : null,
        rsi: snap.rsi, volRatio: avgVol > 0 ? last.volume / avgVol : null, age1h, age4h,
      };
    }
    hours.push({ p, ct, day: Math.floor(ct / DAY), buy, pass, snap, bounce: evaluateBounce(common), exitW: evaluateExitWarning(common), feat });
  }
  return { symbol, c5, idx, h1, h4, hours, settings };
}

/** Price at time t = open of the 5-minute candle starting at t (what a scan at t would see). */
export const priceAt = (c: Ctx, t: number): number | null => { const i = c.idx.get(Math.floor(t / M5) * M5); return i === undefined ? null : c.c5[i].open; };

/** Gross forward return (fraction) from the decision time to `hours` later, or null when data is missing. */
export function fwd(c: Ctx, t: number, hours: number): number | null {
  const a = priceAt(c, t), b = priceAt(c, t + hours * H1);
  return a && b ? b / a - 1 : null;
}

export function barrier(c: Ctx, t: number, upper: number, lower: number, hours: number): "up" | "down" | "none" | null {
  const i0 = c.idx.get(Math.floor(t / M5) * M5);
  if (i0 === undefined || i0 + Math.round((hours * H1) / M5) >= c.c5.length) return null;
  return firstBarrier(c.c5, i0, upper, lower, hours * H1, "up");
}

// ── The existing BUY/SELL system, reproduced with the real functions ────────────────────────────

export interface LiveOpts { trendExit: boolean; feePct: number; slipPct: number; startMs: number; endMs: number; maxHoldH: number; stopPct: number; takePct: number }
export interface LiveTrade { entryAt: number; exitAt: number; entry: number; exit: number; reason: string; netPct: number; grossPct: number; holdH: number; r: number }

function close(entryFillRaw: number, exitRaw: number, o: LiveOpts, entryAt: number, exitAt: number, reason: string): LiveTrade {
  const ef = entryFillRaw * (1 + o.slipPct / 100), xf = exitRaw * (1 - o.slipPct / 100);
  const ratio = xf / ef;
  // Same arithmetic as the live paper engine: fee on the amount spent plus fee on the value sold.
  const net = (ratio - 1) * 100 - o.feePct - o.feePct * ratio;
  return { entryAt, exitAt, entry: ef, exit: xf, reason, netPct: net, grossPct: (ratio - 1) * 100, holdH: (exitAt - entryAt) / H1, r: net / o.stopPct };
}

/** Runs one position from `t0` until an exit, scanning every 5 minutes with the real `evaluateExit`. */
function manage(c: Ctx, k0: number, t0: number, px0: number, o: LiveOpts): { trade: LiveTrade; k: number } | null {
  let k = k0;
  const position = { entryPrice: px0, quantity: 1, amountUsdt: 1000, openedAt: t0, stopLossPct: o.stopPct, takeProfitPct: o.takePct, trendExitEnabled: o.trendExit };
  for (let t = t0 + M5; t <= o.endMs; t += M5) {
    while (k + 1 < c.hours.length && c.hours[k + 1].ct <= t) k++;
    const px = priceAt(c, t);
    if (px === null) continue;
    const d = evaluateExit({ position, currentPrice: px, h1: c.hours[k].snap });
    if (d.exit && d.reason) return { trade: close(px0, px, o, t0, t, d.reason), k };
    if (t - t0 >= o.maxHoldH * H1) return { trade: close(px0, px, o, t0, t, "TIME"), k };
  }
  return null; // still open at the end of the data: not counted
}

/** The existing system: BUY on a fresh closed-candle signal (armed, within the entry window), exits as the live monitor decides them. */
export function simulateLive(c: Ctx, o: LiveOpts): LiveTrade[] {
  const out: LiveTrade[] = [];
  let armed = true, k = 0;
  const hs = c.hours;
  if (!hs.length) return out;
  let t = hs[0].ct;
  while (t <= o.endMs) {
    while (k + 1 < hs.length && hs[k + 1].ct <= t) k++;
    const ev = hs[k];
    if (ev.buy.status === "NO_SIGNAL") armed = true;
    const px = priceAt(c, t);
    if (px !== null && ev.buy.status === "SIGNAL" && armed && t - ev.ct <= c.settings.entryWindowMinutes * 60_000 && t >= o.startMs) {
      const r = manage(c, k, t, px, o);
      if (!r) break;
      out.push(r.trade);
      armed = false; // re-armed only after a NO_SIGNAL evaluation, as in the live monitor
      t = r.trade.exitAt + M5; // no entry on the scan that closed the position
      k = r.k;
      continue;
    }
    t += M5;
  }
  return out;
}

/** Entries at the same kind of moment (just after an hourly close) chosen at random, managed by the identical exit logic. */
export function randomEntries(c: Ctx, o: LiveOpts, count: number, rand: () => number): LiveTrade[] {
  const cand = c.hours.map((h, k) => ({ h, k })).filter(({ h }) => h.ct >= o.startMs && h.ct <= o.endMs - (o.maxHoldH + 2) * H1);
  const out: LiveTrade[] = [];
  for (let i = 0; i < count && cand.length; i++) {
    const { h, k } = cand[Math.floor(rand() * cand.length)];
    const px = priceAt(c, h.ct);
    if (px === null) continue;
    const r = manage(c, k, h.ct, px, o);
    if (r) out.push(r.trade);
  }
  return out;
}
