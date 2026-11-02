/**
 * READ-ONLY verification that the machine running it can fetch GENUINE Bybit native 1H/4H spot candles and that they
 * agree with INDEPENDENT Bybit data (Bybit's own public trade files, public.bybit.com). Binance is never used.
 * Uses the same production fetch + indicator code as the website (src/lib/bybit.ts, src/lib/rules.ts).
 *
 *   npx tsx --tsconfig tests/tsconfig.json scripts/verify-bybit-native.ts --symbols BTCUSDT,ETHUSDT --days 3
 *
 * It must be run from somewhere Bybit's API is reachable (for example your own computer, or the same region as
 * the Vercel deployment). From a blocked region it says so and exits non-zero; it never invents a result.
 * Trade files for "today" are published with a delay, so the independent comparison uses completed past days only.
 */
import { fetchKlines, sanitizeError } from "@/lib/bybit";
import { closedCandles, computeSeries } from "@/lib/rules";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { aggregate } from "@/lib/setups-backtest";
import { INTERVAL_MS, type Candle, type Interval } from "@/lib/types";
import { fetchBybitTrades5m } from "./audit/data";

export interface CandleDiff {
  nativeCount: number;
  independentCount: number;
  compared: number;
  onlyNative: number[];
  onlyIndependent: number[];
  duplicatesNative: number;
  unsortedNative: boolean;
  maxRelDiffPct: { open: number; high: number; low: number; close: number };
  volumeRatioMedian: number | null;
  mismatches: Array<{ start: number; field: string; native: number; independent: number }>;
}

const rel = (a: number, b: number) => (b === 0 ? (a === 0 ? 0 : 100) : (Math.abs(a - b) / Math.abs(b)) * 100);

/** Pure comparison of native candles against independently built candles for the same completed periods. */
export function compareCandles(native: Candle[], independent: Candle[], tolPct = 0.01): CandleDiff {
  const seen = new Set<number>();
  let dups = 0;
  for (const c of native) { if (seen.has(c.start)) dups++; seen.add(c.start); }
  const unsorted = native.some((c, i) => i > 0 && c.start < native[i - 1].start);
  const ind = new Map(independent.map((c) => [c.start, c]));
  const nat = new Map(native.map((c) => [c.start, c]));
  const d: CandleDiff = { nativeCount: native.length, independentCount: independent.length, compared: 0, onlyNative: [], onlyIndependent: [], duplicatesNative: dups, unsortedNative: unsorted, maxRelDiffPct: { open: 0, high: 0, low: 0, close: 0 }, volumeRatioMedian: null, mismatches: [] };
  const ratios: number[] = [];
  for (const c of native) {
    const i = ind.get(c.start);
    if (!i) { d.onlyNative.push(c.start); continue; }
    d.compared++;
    for (const f of ["open", "high", "low", "close"] as const) {
      const r = rel(c[f], i[f]);
      d.maxRelDiffPct[f] = Math.max(d.maxRelDiffPct[f], r);
      if (r > tolPct) d.mismatches.push({ start: c.start, field: f, native: c[f], independent: i[f] });
    }
    if (i.volume > 0) ratios.push(c.volume / i.volume);
  }
  for (const c of independent) if (!nat.has(c.start)) d.onlyIndependent.push(c.start);
  ratios.sort((a, b) => a - b);
  d.volumeRatioMedian = ratios.length ? ratios[Math.floor(ratios.length / 2)] : null;
  return d;
}

const arg = (k: string, dflt: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : dflt; };

async function main() {
  const symbols = arg("symbols", "BTCUSDT,ETHUSDT").split(",");
  const days = Number(arg("days", "3"));
  const now = Date.now();
  const dayEnd = Math.floor(now / 86_400_000) * 86_400_000; // independent data: completed UTC days only
  const out: string[] = [`Bybit native candle verification at ${new Date(now).toISOString()} (source of both sides: Bybit)`];
  let failed = false;
  for (const symbol of symbols) {
    for (const [iv, label] of [["60", "1H"], ["240", "4H"]] as Array<[Interval, string]>) {
      const ms = INTERVAL_MS[iv];
      let native: Candle[];
      try { native = await fetchKlines(symbol, iv, 200); } catch (e) { out.push(`${symbol} ${label}: NATIVE FETCH FAILED — ${sanitizeError(e)}`); failed = true; continue; }
      const closed = closedCandles(native, ms, now);
      const forming = native.filter((c) => c.start + ms > now);
      out.push(`\n${symbol} ${label}: ${native.length} native candles, newest start ${new Date(native[native.length - 1].start).toISOString()}, ${forming.length} forming (excluded from signals: ${closed.length === native.length - forming.length ? "yes" : "NO"})`);
      if (!(closed.length === native.length - forming.length)) failed = true;
      const from = dayEnd - days * 86_400_000;
      let built: Candle[];
      try { built = aggregate(await fetchBybitTrades5m(symbol, from, dayEnd), ms); } catch (e) { out.push(`  independent trade-file data unavailable — ${String(e).slice(0, 160)}`); failed = true; continue; }
      const window = closed.filter((c) => c.start >= from && c.start + ms <= dayEnd);
      const d = compareCandles(window, built);
      out.push(`  compared ${d.compared} of ${window.length} completed native candles (independent: ${built.length}); only-native ${d.onlyNative.length}, duplicates ${d.duplicatesNative}, unsorted ${d.unsortedNative}`);
      out.push(`  max relative difference %: open ${d.maxRelDiffPct.open.toFixed(5)}, high ${d.maxRelDiffPct.high.toFixed(5)}, low ${d.maxRelDiffPct.low.toFixed(5)}, close ${d.maxRelDiffPct.close.toFixed(5)}; median volume ratio native/independent ${d.volumeRatioMedian?.toFixed(4) ?? "n/a"}; price mismatches over 0.01%: ${d.mismatches.length}`);
      if (d.compared === 0 || d.mismatches.length > 0 || d.duplicatesNative > 0 || d.unsortedNative) failed = true;
      // Indicator inputs: same production indicator code on both candle sets over their common completed period.
      const common = window.filter((c) => built.some((b) => b.start === c.start));
      const nb = built.filter((b) => common.some((c) => c.start === b.start));
      if (common.length >= 30) {
        const a = computeSeries(common, DEFAULT_SETTINGS), b = computeSeries(nb, DEFAULT_SETTINGS);
        const last = common.length - 1;
        const pair = (n: string, x: number | null, y: number | null) => `${n} ${x === null ? "n/a" : x.toFixed(4)} vs ${y === null ? "n/a" : y.toFixed(4)}`;
        out.push(`  indicators on the last common candle (native vs independent): ${pair("EMA fast", a.emaFast[last], b.emaFast[last])}; ${pair("RSI", a.rsi[last], b.rsi[last])}; ${pair("MACD hist", a.macdHist[last], b.macdHist[last])}`);
      } else out.push("  indicator comparison skipped: fewer than 30 common candles (use more --days)");
    }
  }
  out.push(failed ? "\nRESULT: NOT VERIFIED (see lines above)" : "\nRESULT: native candles agree with independent Bybit data");
  console.log(out.join("\n"));
  if (failed) process.exit(1);
}

if (process.argv[1] && /scripts[\\/]verify-bybit-native\.ts$/.test(process.argv[1])) main().catch((e) => { console.error(String(e)); process.exit(1); });
