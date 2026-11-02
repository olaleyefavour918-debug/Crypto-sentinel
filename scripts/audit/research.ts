/**
 * PRE-REGISTERED signal-improvement research (read-only; changes nothing in the app).
 *
 * Written and committed BEFORE the first run so the candidates and the decision rule cannot be tuned afterwards.
 *
 * DATA: real Bybit spot trades -> 5m candles (public.bybit.com), 8 coins. Two periods:
 *   FRESH  = the ~550 days BEFORE the most recent 150 days. Never examined before: this is the decisive test.
 *   RECENT = the most recent 150 days (4 Jun -> 1 Nov 2026). The weaknesses below were noticed here, so it can only
 *            confirm or contradict, never prove.
 *
 * CANDIDATES (each is ONLY a stricter filter on the existing Trend BUY; nothing is loosened, no new BUY rule):
 *   V1 "not a brand-new trend": 1H EMA20>EMA50 for at least 24 hours already.
 *      Why: in RECENT, signals in the first 23h of a trend had NEGATIVE 24h returns (-0.4%, -0.7%), later ones positive.
 *   V2 "not after a falling day": 24h return >= 0.
 *      Why: in RECENT, signals after a negative 24h had negative forward returns (-0.7%, n=31).
 *   V3 = V1 and V2.
 *   BASE = the current system. All use the faithful live replay (real evaluateBuy/evaluateExit, arming, 30-minute
 *   entry window, trend-break exit, 0.1% fee per side). A gated-out hour counts as "no signal" (the strict rule lapsed).
 *
 * DECISION RULE (fixed in advance). A candidate is ADOPTED only if ALL hold:
 *   (a) FRESH: mean net per trade of candidate minus BASE is > 0 with a day-resampled 95% interval whose lower bound > 0;
 *   (b) RECENT: the same difference has the same sign (point estimate > 0);
 *   (c) FRESH candidate trades >= 60.
 *   Three candidates are tested, so a single lucky interval is expected about once in seven tries by chance alone;
 *   anything weaker than the rule above is reported as NOT validated.
 *
 * EXIT WARNING (report only, nothing is adopted from this): the e4 "closed below the prior low" branch is true for any
 * ordinary down candle. ALT = confirmed warning that is NOT supported only by that branch.
 *   Reported: P(1.5 ATR fall before 1.5 ATR rise within 24h) for BASE confirmed, ALT confirmed and ALL hours.
 * SUPPORT-BOUNCE (report only): signal counts over the longer history.
 */
import { DEFAULT_SETTINGS } from "@/lib/settings";
import type { Candle } from "@/lib/types";
import { DAY, H1, barrier, buildCtx, priceAt, simulateLive, type Ctx, type HourRec, type LiveOpts, type LiveTrade } from "./ctx";
import { fetch5m } from "./data";
import { DayAcc, dayBoot, fmtBoot, fx, mean, pct, table } from "./stats";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const totalDays = Number(arg("days", "700"));
const recentDays = Number(arg("recent", "150"));
const symbols = arg("symbols", "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,BNBUSDT,DOGEUSDT,ADAUSDT,LINKUSDT").split(",");

const VARIANTS: Array<[string, (h: HourRec) => boolean]> = [
  ["BASE", () => true],
  ["V1 trend >= 24h old", (h) => !!h.feat && h.feat.age1h >= 24],
  ["V2 24h return >= 0", (h) => !!h.feat && h.feat.ret24 !== null && h.feat.ret24 >= 0],
  ["V3 = V1 and V2", (h) => !!h.feat && h.feat.age1h >= 24 && h.feat.ret24 !== null && h.feat.ret24 >= 0],
];

const gated = (c: Ctx, ok: (h: HourRec) => boolean): Ctx => ({ ...c, hours: c.hours.map((h) => (h.buy.status === "SIGNAL" && !ok(h) ? { ...h, buy: { ...h.buy, status: "NO_SIGNAL" as const } } : h)) });
const acc = (t: LiveTrade[]) => { const a = new DayAcc(); for (const x of t) a.add(Math.floor(x.entryAt / DAY), x.netPct); return a; };
const line = (t: LiveTrade[]) => (t.length ? `n=${t.length}, win ${pct(t.filter((x) => x.netPct > 0).length, t.length, 0)}, mean net ${fmtBoot(dayBoot(acc(t)), 2, "%")}` : "n=0");

async function main() {
  const end = Math.floor(Date.now() / DAY) * DAY - DAY; // last COMPLETED day with a published trade file
  const start = end - totalDays * DAY, split = end - recentDays * DAY;
  const from = start - 43 * DAY;
  const c5 = new Map<string, Candle[]>();
  for (const s of symbols) { c5.set(s, await fetch5m("bybit-trades", s, from, end)); console.error(`${s}: ${c5.get(s)?.length} candles`); }
  const L: string[] = ["# Pre-registered signal-improvement research (real Bybit spot data, read-only)", `FRESH ${new Date(start).toISOString().slice(0, 10)} -> ${new Date(split).toISOString().slice(0, 10)} (${((split - start) / DAY).toFixed(0)} days) | RECENT ${new Date(split).toISOString().slice(0, 10)} -> ${new Date(end).toISOString().slice(0, 10)} (${recentDays} days) | ${symbols.length} coins | fees 0.1% per side, no slippage`, ""];
  const o: LiveOpts = { trendExit: true, feePct: 0.1, slipPct: 0, startMs: start, endMs: end, maxHoldH: 14 * 24, stopPct: DEFAULT_SETTINGS.stopLossPct, takePct: DEFAULT_SETTINGS.takeProfitPct };
  const ctxs = symbols.map((s) => buildCtx(s, c5.get(s) as Candle[], s === "BTCUSDT" ? null : (c5.get("BTCUSDT") as Candle[]), start - 3 * DAY, end, DEFAULT_SETTINGS));

  L.push("## 1. Trend BUY candidates (faithful live replay)");
  const res = new Map<string, LiveTrade[]>();
  for (const [name, ok] of VARIANTS) { const t: LiveTrade[] = []; for (const c of ctxs) t.push(...simulateLive(gated(c, ok), o)); res.set(name, t); }
  const inP = (t: LiveTrade[], fresh: boolean) => t.filter((x) => (fresh ? x.entryAt < split : x.entryAt >= split));
  const rows: Array<Array<string | number>> = [];
  for (const [name] of VARIANTS) rows.push([name, line(inP(res.get(name) as LiveTrade[], true)), line(inP(res.get(name) as LiveTrade[], false))]);
  L.push(...table(["variant", "FRESH (decisive)", "RECENT (confirmatory)"], rows), "");
  L.push("Difference in mean net per trade, candidate minus BASE (day-resampled 95% interval):");
  const base = res.get("BASE") as LiveTrade[];
  for (const [name] of VARIANTS.slice(1)) {
    const v = res.get(name) as LiveTrade[];
    const dF = dayBoot(acc(inP(v, true)), acc(inP(base, true))), dR = dayBoot(acc(inP(v, false)), acc(inP(base, false)));
    const nF = inP(v, true).length;
    const adopt = dF.lo !== null && dF.lo > 0 && dR.est !== null && dR.est > 0 && nF >= 60;
    L.push(`- ${name}: FRESH ${fmtBoot(dF, 2, "%")} | RECENT ${fmtBoot(dR, 2, "%")} -> ${adopt ? "PASSES the pre-registered rule" : "NOT validated (rule not met)"}`);
  }
  L.push("");

  L.push("## 2. Exit Warning: does ignoring the 'ordinary down candle' evidence help? (report only)");
  const e4OnlyBelowLow = (h: HourRec) => { const e4 = h.exitW.conditions.find((x) => x.id === "e4_reversal"), e6 = h.exitW.conditions.find((x) => x.id === "e6_false_breakout"); return !!e4?.passed && /prior low/.test(e4.detail) && !e6?.passed; };
  const sets: Array<[string, (h: HourRec) => boolean]> = [["ALL hours", () => true], ["BASE confirmed", (h) => h.exitW.full], ["ALT confirmed (not supported only by the down-candle branch)", (h) => h.exitW.full && !e4OnlyBelowLow(h)]];
  for (const [label, fresh] of [["FRESH", true], ["RECENT", false]] as const) {
    const accs = sets.map(() => new DayAcc());
    for (const c of ctxs) for (const h of c.hours) {
      if (h.ct > end - 25 * H1 || (fresh ? h.ct >= split : h.ct < split) || h.ct < start) continue;
      const px = priceAt(c, h.ct); if (!px || !h.snap.atr) continue;
      const b = barrier(c, h.ct, px + 1.5 * h.snap.atr, px - 1.5 * h.snap.atr, 24); if (b === null) continue;
      sets.forEach(([, f], i) => { if (f(h)) accs[i].add(h.day, b === "down" ? 100 : 0); });
    }
    L.push(`${label}: ` + sets.map(([n], i) => `${n}: ${fx(accs[i].mean, 1)}% fall-first (n=${accs[i].n})`).join(" | "));
    L.push(`  BASE minus ALL: ${fmtBoot(dayBoot(accs[1], accs[0]), 1, " pts")} | ALT minus ALL: ${fmtBoot(dayBoot(accs[2], accs[0]), 1, " pts")}`);
  }
  L.push("");

  L.push("## 3. Support-Bounce sample size over the longer history (report only)");
  let conf = 0, pot = 0, hours = 0;
  for (const c of ctxs) for (const h of c.hours) { hours++; const prev = c.hours.find((x) => x.p === h.p - 1); if (h.bounce.full && !(prev && prev.bounce.full)) conf++; if (h.bounce.potential) pot++; }
  L.push(`Fresh confirmed bounces: ${conf} in ${hours} coin-hours (${fx((conf / hours) * 24 * 100, 3)} per 100 coin-days). Potential hours: ${pot}.`);
  console.log(L.join("\n"));
  void mean;
}
main().catch((e) => { console.error(String((e as Error)?.stack ?? e)); process.exit(1); });
