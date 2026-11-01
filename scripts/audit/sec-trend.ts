import { computeSeries, evaluateBuy } from "@/lib/rules";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { rng } from "@/lib/setups-backtest";
import type { Candle } from "@/lib/types";
import { H1, H4, DAY, fwd, randomEntries, simulateLive, type Ctx, type HourRec, type LiveOpts, type LiveTrade } from "./ctx";
import { DayAcc, dayBoot, fmtBoot, fx, mean, median, pct, phi, quantile, table } from "./stats";

export interface Period { startMs: number; endMs: number; splitMs: number }
const IDS = ["h1_ema_trend", "h4_ema_trend", "h1_rsi_range", "h1_macd_hist", "h1_volume", "h1_trend_rising", "h1_not_extended", "h1_not_late", "h4_momentum", "h4_not_exhausted"];
const CORE = IDS.slice(0, 4);
const HOR = [1, 4, 12, 24, 48];

export const live = (h: HourRec) => h.buy.status !== "DATA_INVALID";
export function hoursOf(c: Ctx, P: Period): HourRec[] { return c.hours.filter((h) => h.ct >= P.startMs && h.ct <= P.endMs); }

function tradeStats(t: LiveTrade[]) {
  const n = t.length;
  if (!n) return "n=0";
  const w = t.filter((x) => x.netPct > 0), l = t.filter((x) => x.netPct <= 0);
  const gw = w.reduce((a, x) => a + x.netPct, 0), gl = Math.abs(l.reduce((a, x) => a + x.netPct, 0));
  const reasons: Record<string, number> = {};
  for (const x of t) reasons[x.reason] = (reasons[x.reason] ?? 0) + 1;
  return `n=${n} · win ${pct(w.length, n, 0)} · mean net ${fx(mean(t.map((x) => x.netPct)))}% (gross ${fx(mean(t.map((x) => x.grossPct)))}%) · mean ${fx(mean(t.map((x) => x.r)))}R · PF ${gl > 0 ? fx(gw / gl) : "n/a"} · mean hold ${fx(mean(t.map((x) => x.holdH)), 1)}h · exits ${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(", ")}`;
}

export function trendSection(ctxs: Ctx[], P: Period): string[] {
  const L: string[] = [];
  const all = ctxs.flatMap((c) => hoursOf(c, P).map((h) => ({ c, h })));
  const valid = all.filter(({ h }) => live(h));
  L.push(`Hourly closed-candle evaluations: ${all.length} (${valid.length} usable, ${all.length - valid.length} rejected for data reasons such as gaps).`);
  const sig = valid.filter(({ h }) => h.buy.status === "SIGNAL");
  const edges = valid.filter(({ c, h }) => { if (h.buy.status !== "SIGNAL") return false; const prev = c.hours.find((x) => x.p === h.p - 1); return !prev || prev.buy.status !== "SIGNAL"; });
  L.push(`Hours where all 10 conditions pass: ${sig.length} (${pct(sig.length, valid.length, 2)} of hours). Fresh signals (the first hour of each run, which is what the live system acts on): ${edges.length}.`);
  L.push("");

  // 1. Redundancy
  L.push("### 1a. Condition pass rates, sole blockers and overlap");
  const rows = IDS.map((id) => {
    const pass = valid.filter(({ h }) => h.pass[id]).length;
    const others = valid.filter(({ h }) => IDS.every((o) => o === id || h.pass[o]));
    const sole = others.filter(({ h }) => !h.pass[id]).length;
    const core = valid.filter(({ h }) => CORE.every((o) => h.pass[o]));
    return [id, pct(pass, valid.length), pct(core.filter(({ h }) => h.pass[id]).length, core.length), others.length, sole, others.length ? pct(sole, others.length) : "n/a"];
  });
  L.push(...table(["condition", "passes (all hours)", "passes given the 4 core pass", "hours where the other 9 pass", "of those, blocked ONLY by this", "share"], rows));
  const core4 = valid.filter(({ h }) => CORE.every((id) => h.pass[id])).length;
  L.push(`The 4 core conditions alone pass in ${core4} hours; adding the 6 quality gates leaves ${sig.length} (${pct(sig.length, core4, 0)}).`);
  L.push("");
  L.push("Correlation (phi, -1..1) between conditions across all usable hours. Values near 1 mean two conditions say nearly the same thing:");
  const bits = IDS.map((id) => valid.map(({ h }) => !!h.pass[id]));
  L.push(...table(["", ...IDS.map((_, i) => `c${i + 1}`)], IDS.map((id, i) => [`c${i + 1} ${id}`, ...IDS.map((_, j) => fx(phi(bits[i], bits[j]), 2))])));
  L.push("");

  // 2. Edge: do signal hours earn more than other hours (gross, no costs)?
  L.push("### 1b. Does the signal select better moments? Gross forward return (no fees), entry at the candle close");
  const groups: Array<[string, (h: HourRec) => boolean]> = [
    ["ALL usable hours", () => true],
    ["1h and 4h EMA uptrend only (2 conditions)", (h) => !!h.pass.h1_ema_trend && !!h.pass.h4_ema_trend],
    ["4 core conditions", (h) => CORE.every((id) => h.pass[id])],
    ["all 10 conditions (every hour)", (h) => h.buy.status === "SIGNAL"],
  ];
  const acc: Record<string, Record<number, DayAcc>> = {};
  for (const [name] of groups) { acc[name] = {}; for (const hz of HOR) acc[name][hz] = new DayAcc(); }
  const edgeAcc: Record<number, DayAcc> = {}; for (const hz of HOR) edgeAcc[hz] = new DayAcc();
  const edgeSet = new Set(edges.map(({ c, h }) => `${c.symbol}:${h.p}`));
  for (const { c, h } of valid) {
    for (const hz of HOR) {
      if (h.ct + hz * H1 > P.endMs) continue;
      const f = fwd(c, h.ct, hz);
      if (f === null) continue;
      for (const [name, fn] of groups) if (fn(h)) acc[name][hz].add(h.day, f * 100);
      if (edgeSet.has(`${c.symbol}:${h.p}`)) edgeAcc[hz].add(h.day, f * 100);
    }
  }
  const allAcc = acc["ALL usable hours"];
  const lines: Array<Array<string | number>> = [];
  for (const [name] of groups) lines.push([name, acc[name][24].n, ...HOR.map((hz) => fx(acc[name][hz].mean, 3) + "%")]);
  lines.push(["FRESH signals only (what the system acts on)", edgeAcc[24].n, ...HOR.map((hz) => fx(edgeAcc[hz].mean, 3) + "%")]);
  L.push(...table(["group", "n (24h)", ...HOR.map((h) => `+${h}h mean`)], lines));
  L.push("");
  L.push("Difference against ALL usable hours, with a 95% interval that resamples whole days (hours and coins inside a day move together, so plain per-hour intervals would be far too narrow):");
  for (const hz of [4, 24, 48]) {
    L.push(`- fresh signals vs all hours, +${hz}h: ${fmtBoot(dayBoot(edgeAcc[hz], allAcc[hz]), 3, "%")}`);
    L.push(`- 1h+4h uptrend vs all hours, +${hz}h: ${fmtBoot(dayBoot(acc["1h and 4h EMA uptrend only (2 conditions)"][hz], allAcc[hz]), 3, "%")}`);
  }
  L.push("");

  // 3. Lateness
  L.push("### 1c. Are signals late? State of the market at a fresh signal vs all hours (medians; q25–q75 for signals)");
  const F = (sel: (x: NonNullable<HourRec["feat"]>) => number | null) => {
    const a = valid.map(({ h }) => (h.feat ? sel(h.feat) : null)).filter((x): x is number => x !== null);
    const t = valid.filter(({ h }) => h.pass.h1_ema_trend && h.pass.h4_ema_trend).map(({ h }) => (h.feat ? sel(h.feat) : null)).filter((x): x is number => x !== null);
    const s = edges.map(({ h }) => (h.feat ? sel(h.feat) : null)).filter((x): x is number => x !== null);
    return [fx(median(a)), fx(median(t)), `${fx(median(s))} (${fx(quantile(s, 0.25))}–${fx(quantile(s, 0.75))})`];
  };
  L.push(...table(["feature", "all hours", "in 1h+4h uptrend", "fresh signals"], [
    ["hours since the 1h EMA20 crossed above EMA50", ...F((x) => x.age1h)],
    ["4h bars since the 4h EMA cross", ...F((x) => x.age4h)],
    ["stretch above EMA20 (ATRs)", ...F((x) => x.stretchAtr)],
    ["rise above the 24h low (ATRs)", ...F((x) => x.riseAtr)],
    ["return over the last 6h (%)", ...F((x) => (x.ret6 === null ? null : x.ret6 * 100))],
    ["return over the last 24h (%)", ...F((x) => (x.ret24 === null ? null : x.ret24 * 100))],
    ["1h RSI", ...F((x) => x.rsi)],
    ["volume vs 20-candle average", ...F((x) => x.volRatio)],
  ]));
  const old = edges.filter(({ h }) => h.feat && h.feat.age1h > 24).length;
  L.push(`Fresh signals where the 1h trend was already more than 24 hours old: ${old} of ${edges.length} (${pct(old, edges.length, 0)}).`);
  L.push("Exploratory only (nothing here is a tuning input): forward 24h gross return of fresh signals by trend age and by prior 24h move.");
  const bucket = (name: string, f: (x: NonNullable<HourRec["feat"]>) => number | null, cuts: number[], labels: string[]) => {
    const out: Array<Array<string | number>> = [];
    for (let i = 0; i < labels.length; i++) {
      const a = new DayAcc();
      for (const { c, h } of edges) {
        if (!h.feat || h.ct + 24 * H1 > P.endMs) continue;
        const v = f(h.feat); if (v === null) continue;
        const k = cuts.findIndex((x) => v < x); const b = k < 0 ? cuts.length : k;
        if (b !== i) continue;
        const r = fwd(c, h.ct, 24); if (r !== null) a.add(h.day, r * 100);
      }
      out.push([labels[i], a.n, fx(a.mean, 3) + "%"]);
    }
    L.push(`${name}:`);
    L.push(...table(["bucket", "n", "mean +24h gross"], out));
  };
  bucket("by hours since the 1h EMA cross", (x) => x.age1h, [6, 24, 72], ["0–5h", "6–23h", "24–71h", "72h+"]);
  bucket("by return over the previous 24h", (x) => (x.ret24 === null ? null : x.ret24 * 100), [0, 2, 5], ["below 0%", "0–2%", "2–5%", "5%+"]);
  L.push("");

  // 4. Arithmetic of the 2% / 4% rule with costs
  L.push("### 1d. Arithmetic of the existing 2% stop / 4% target with costs");
  const stop = 2, take = 4;
  for (const [label, c] of [["fees only, as the live paper engine charges (0.1% each side)", 0.2], ["fees + 0.05% slippage per side, as the back-test charged", 0.1 * 2 + 0.05 * 2]] as Array<[string, number]>) {
    const be = (stop + c) / (stop + take);
    L.push(`- ${label}: round trip about ${fx(c, 2)}% = ${fx(c / stop, 2)}R. A driftless random walk wins ${fx((stop / (stop + take)) * 100, 1)}% of the time; break-even needs ${fx(be * 100, 1)}%.`);
  }
  const atrPct = ctxs.map((c) => `${c.symbol.replace("USDT", "")} ${fx(median(c.hours.map((h) => (h.feat?.atr && h.feat.close ? (h.feat.atr / h.feat.close) * 100 : NaN)).filter((x) => Number.isFinite(x)) as number[]), 2)}%`);
  L.push(`- Median 1h ATR as % of price: ${atrPct.join(", ")}. A 2% stop is ${fx(2 / (median(ctxs.flatMap((c) => c.hours.map((h) => (h.feat?.atr && h.feat.close ? (h.feat.atr / h.feat.close) * 100 : NaN)).filter((x) => Number.isFinite(x)) as number[])) ?? 1), 1)} ATRs on the median coin.`);
  L.push("");

  // 5. Faithful simulation of the existing system
  L.push("### 1e. The existing BUY/SELL system reproduced with the real functions (evaluateBuy, evaluateExit, arming, 30-minute entry window, 200-candle windows)");
  const base: LiveOpts = { trendExit: true, feePct: 0.1, slipPct: 0, startMs: P.startMs, endMs: P.endMs, maxHoldH: 14 * 24, stopPct: 2, takePct: 4 };
  const variants: Array<[string, LiveOpts]> = [
    ["A. LIVE as deployed (trend-break exit ON, fees only)", base],
    ["B. as A plus 0.05% slippage per side (the back-test's cost model)", { ...base, slipPct: 0.05 }],
    ["C. trend-break exit OFF (only 2% stop / 4% target)", { ...base, trendExit: false }],
    ["D. as C plus 0.05% slippage per side", { ...base, trendExit: false, slipPct: 0.05 }],
  ];
  for (const [name, o] of variants) {
    const rand = rng(2024); // same random entries for every variant, so the variants are comparable
    const trades = ctxs.map((c) => ({ c, t: simulateLive(c, o) }));
    const flat = trades.flatMap(({ t }) => t);
    L.push(`**${name}**`);
    L.push(`- all:           ${tradeStats(flat)}`);
    const seg = (a: number, b: number) => flat.filter((t) => t.entryAt >= a && t.entryAt < b);
    L.push(`- in-sample:     ${tradeStats(seg(P.startMs, P.splitMs))}`);
    L.push(`- out-of-sample: ${tradeStats(seg(P.splitMs, P.endMs + 1))}`);
    const stratAcc = new DayAcc(), baseAcc = new DayAcc(), stratOos = new DayAcc(), baseOos = new DayAcc();
    for (const { c, t } of trades) {
      for (const x of t) { stratAcc.add(Math.floor(x.entryAt / DAY), x.netPct); if (x.entryAt >= P.splitMs) stratOos.add(Math.floor(x.entryAt / DAY), x.netPct); }
      for (let d = 0; d < 20; d++) {
        for (const x of randomEntries(c, o, t.length, rand)) { baseAcc.add(Math.floor(x.entryAt / DAY), x.netPct); if (x.entryAt >= P.splitMs) baseOos.add(Math.floor(x.entryAt / DAY), x.netPct); }
      }
    }
    L.push(`- random entries, same exit logic, same costs: mean net ${fx(baseAcc.mean)}% (OOS ${fx(baseOos.mean)}%)`);
    L.push(`- strategy minus random, all: ${fmtBoot(dayBoot(stratAcc, baseAcc), 3, "%")}`);
    L.push(`- strategy minus random, OOS: ${fmtBoot(dayBoot(stratOos, baseOos), 3, "%")}`);
    L.push(`- strategy mean net with a day-resampled interval: ${fmtBoot(dayBoot(stratAcc), 3, "%")}`);
    L.push("");
  }

  // 6. Window sensitivity: live uses 200 candles, the first back-test used 400 / 150.
  L.push("### 1f. Window sensitivity (live fetches 200 candles per timeframe; the first back-test fed 400 1h / 150 4h)");
  let agree = 0, tot = 0, flipsToSignal = 0, flipsFromSignal = 0;
  for (const c of ctxs) {
    for (const h of hoursOf(c, P)) {
      if (h.p % 3 !== 0 || !live(h)) continue;
      let n4 = 0; while (n4 < c.h4.length && c.h4[n4].start + H4 <= h.ct) n4++;
      const alt = evaluateBuy({ h1: c.h1.slice(Math.max(0, h.p + 1 - 400), h.p + 1), h4: c.h4.slice(Math.max(0, n4 - 150), n4), now: h.ct, settings: c.settings });
      if (alt.status === "DATA_INVALID") continue;
      tot++;
      if (alt.status === h.buy.status) agree++; else if (alt.status === "SIGNAL") flipsToSignal++; else flipsFromSignal++;
    }
  }
  L.push(`Sampled ${tot} hours: same decision in ${pct(agree, tot, 2)}; ${flipsToSignal} became a signal with the longer window, ${flipsFromSignal} stopped being one.`);
  L.push("");

  // 7. Indicators against an independently written implementation
  L.push("### 1g. Indicator cross-check against separately written formulas");
  L.push(indicatorCheck(ctxs));
  return L;
}

// Independent, deliberately naive implementations (different structure from src/lib/indicators.ts).
function emaNaive(v: number[], n: number): number[] {
  const k = 2 / (n + 1), out: number[] = [];
  let e = v.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = 0; i < v.length; i++) { if (i < n - 1) { out.push(NaN); continue; } if (i === n - 1) { out.push(e); continue; } e = v[i] * k + e * (1 - k); out.push(e); }
  return out;
}
function rsiNaive(v: number[], n: number): number {
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = v[i] - v[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < v.length; i++) { const d = v[i] - v[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function indicatorCheck(ctxs: Ctx[]): string {
  const s = DEFAULT_SETTINGS;
  let worst = { ema: 0, rsi: 0, macd: 0, atr: 0 }, n = 0;
  for (const c of ctxs) {
    for (const h of c.hours.filter((x) => x.p % 40 === 0 && x.feat)) {
      const w: Candle[] = c.h1.slice(Math.max(0, h.p + 1 - 200), h.p + 1);
      const cl = w.map((x) => x.close);
      const ser = computeSeries(w, s);
      const e20 = emaNaive(cl, s.emaFast), e50 = emaNaive(cl, s.emaSlow);
      const m = emaNaive(cl, 12).map((x, i) => x - emaNaive(cl, 26)[i]);
      const mc = m.filter((x) => Number.isFinite(x));
      const sig = emaNaive(mc, 9);
      const hist = mc[mc.length - 1] - sig[sig.length - 1];
      const i = w.length - 1;
      worst.ema = Math.max(worst.ema, Math.abs((ser.emaFast[i] as number) - e20[i]) / cl[i], Math.abs((ser.emaSlow[i] as number) - e50[i]) / cl[i]);
      worst.rsi = Math.max(worst.rsi, Math.abs((ser.rsi[i] as number) - rsiNaive(cl, s.rsiPeriod)));
      worst.macd = Math.max(worst.macd, Math.abs((ser.macdHist[i] as number) - hist) / cl[i]);
      let a = 0;
      const tr = w.map((x, j) => (j === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - w[j - 1].close), Math.abs(x.low - w[j - 1].close))));
      a = tr.slice(0, 14).reduce((p, q) => p + q, 0) / 14;
      for (let j = 14; j < tr.length; j++) a = (a * 13 + tr[j]) / 14;
      worst.atr = Math.max(worst.atr, Math.abs((ser.atr[i] as number) - a) / cl[i]);
      n++;
    }
  }
  return `Compared ${n} points per indicator. Largest differences: EMA ${worst.ema.toExponential(1)} (fraction of price), RSI ${worst.rsi.toExponential(1)} points, MACD histogram ${worst.macd.toExponential(1)}, ATR ${worst.atr.toExponential(1)}. Differences at floating-point level mean the formulas match their textbook definitions (this does not compare against TradingView itself).`;
}
