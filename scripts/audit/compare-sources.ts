/** Read-only: compares REAL Bybit spot candles (built from Bybit's own trade files) with Binance candles, for every coin, and shows whether the signals differ. */
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { M5 } from "@/lib/setups-backtest";
import type { Candle } from "@/lib/types";
import { DAY, buildCtx, simulateLive, type LiveOpts, type LiveTrade } from "./ctx";
import { fetch5m } from "./data";
import { fx, mean, median, pct, quantile, table } from "./stats";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const days = Number(arg("days", "150"));
const symbols = arg("symbols", "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,BNBUSDT,DOGEUSDT,ADAUSDT,LINKUSDT").split(",");

const stat = (t: LiveTrade[]) => (t.length ? `n=${t.length}, win ${pct(t.filter((x) => x.netPct > 0).length, t.length, 0)}, mean net ${fx(mean(t.map((x) => x.netPct)))}%` : "n=0");

async function main() {
  const end = Math.floor(Date.now() / DAY) * DAY, start = end - days * DAY, from = start - 43 * DAY;
  const P = { startMs: start, endMs: end, splitMs: start + 0.6 * (end - start) };
  const bin = new Map<string, Candle[]>(), byb = new Map<string, Candle[]>();
  for (const s of symbols) { bin.set(s, await fetch5m("binance", s, from, end)); byb.set(s, await fetch5m("bybit-trades", s, from, end)); console.error(`${s}: binance ${bin.get(s)?.length}, bybit ${byb.get(s)?.length}`); }
  const L: string[] = ["# Binance vs real Bybit spot data (read-only)", `Window ${new Date(start).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)}, 5-minute candles, ${symbols.length} coins. Bybit candles are built from Bybit's own public trade files (a 5-minute bucket with no trades is filled flat for at most 30 minutes).`, ""];

  L.push("## 1. Candle by candle (every 5-minute candle in the window)");
  const rows: Array<Array<string | number>> = [];
  for (const s of symbols) {
    const A = new Map((bin.get(s) as Candle[]).map((c) => [c.start, c])), B = byb.get(s) as Candle[];
    const dO: number[] = [], dH: number[] = [], dL: number[] = [], dC: number[] = [], vr: number[] = [], rb: number[] = [], ra: number[] = [];
    let matched = 0, zeroVol = 0, prevA: Candle | undefined, prevB: Candle | undefined;
    for (const b of B) {
      if (b.volume === 0) zeroVol++;
      const a = A.get(b.start);
      if (!a) { prevA = undefined; prevB = undefined; continue; }
      matched++;
      dO.push(Math.abs(a.open / b.open - 1) * 100); dH.push(Math.abs(a.high / b.high - 1) * 100); dL.push(Math.abs(a.low / b.low - 1) * 100); dC.push(Math.abs(a.close / b.close - 1) * 100);
      if (a.volume > 0 && b.volume > 0) vr.push(b.volume / a.volume);
      if (prevA && prevB) { ra.push(a.close / prevA.close - 1); rb.push(b.close / prevB.close - 1); }
      prevA = a; prevB = b;
    }
    const corr = (() => { const ma = mean(ra) ?? 0, mb = mean(rb) ?? 0; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < ra.length; i++) { sab += (ra[i] - ma) * (rb[i] - mb); saa += (ra[i] - ma) ** 2; sbb += (rb[i] - mb) ** 2; } return sab / Math.sqrt(saa * sbb); })();
    const binN = (bin.get(s) as Candle[]).length;
    rows.push([s.replace("USDT", ""), `${binN}/${B.length}`, matched, zeroVol, fx(median(dC), 4) + "%", fx(quantile(dC, 0.99), 3) + "%", fx(Math.max(...dC), 2) + "%", fx(quantile(dH, 0.99), 3) + "%", fx(quantile(dL, 0.99), 3) + "%", fx(median(vr), 2), fx(corr, 4)]);
  }
  L.push(...table(["coin", "candles Binance/Bybit", "matching", "Bybit flat-filled (no trades)", "median |close diff|", "99th pct close", "max close", "99th pct high", "99th pct low", "median volume ratio Bybit/Binance", "5m return correlation"], rows));
  L.push("");

  L.push("## 2. Hour by hour: do the signals differ? (same 200-candle windows, same rules, closed candles)");
  const r2: Array<Array<string | number>> = [], r3: Array<Array<string | number>> = [];
  const tradesA: LiveTrade[] = [], tradesB: LiveTrade[] = [];
  const btcA = bin.get("BTCUSDT") ?? null, btcB = byb.get("BTCUSDT") ?? null;
  const o: LiveOpts = { trendExit: true, feePct: 0.1, slipPct: 0, startMs: start, endMs: end, maxHoldH: 14 * 24, stopPct: 2, takePct: 4 };
  let tot = { n: 0, same: 0, both: 0, onlyA: 0, onlyB: 0 };
  for (const s of symbols) {
    const a = buildCtx(s, bin.get(s) as Candle[], s === "BTCUSDT" ? null : btcA, start - 3 * DAY, end, DEFAULT_SETTINGS);
    const b = buildCtx(s, byb.get(s) as Candle[], s === "BTCUSDT" ? null : btcB, start - 3 * DAY, end, DEFAULT_SETTINGS);
    const mb = new Map(b.hours.map((h) => [h.ct, h]));
    const cmp = (f: (h: (typeof a.hours)[number]) => boolean) => { let n = 0, same = 0, both = 0, oa = 0, ob = 0; for (const h of a.hours) { const x = mb.get(h.ct); if (!x) continue; n++; const p = f(h), q = f(x); if (p === q) same++; if (p && q) both++; else if (p) oa++; else if (q) ob++; } return { n, same, both, oa, ob }; };
    const buy = cmp((h) => h.buy.status === "SIGNAL"), bn = cmp((h) => h.bounce.full), bp = cmp((h) => h.bounce.potential), ex = cmp((h) => h.exitW.full);
    tot = { n: tot.n + buy.n, same: tot.same + buy.same, both: tot.both + buy.both, onlyA: tot.onlyA + buy.oa, onlyB: tot.onlyB + buy.ob };
    const sa = simulateLive(a, o), sb = simulateLive(b, o);
    tradesA.push(...sa); tradesB.push(...sb);
    r2.push([s.replace("USDT", ""), buy.n, pct(buy.same, buy.n, 2), buy.both, buy.oa, buy.ob, `${bn.both}/${bn.oa}/${bn.ob}`, `${bp.both}/${bp.oa}/${bp.ob}`, `${ex.both}/${ex.oa}/${ex.ob}`, pct(ex.same, ex.n, 1)]);
    r3.push([s.replace("USDT", ""), stat(sa), stat(sb)]);
  }
  L.push("Cells written a/b/c = on both / only on Binance / only on Bybit.");
  L.push(...table(["coin", "hours compared", "same BUY decision", "BUY on both", "BUY only Binance", "BUY only Bybit", "bounce confirmed a/b/c", "bounce potential a/b/c", "exit warning confirmed a/b/c", "exit warning same decision"], r2));
  L.push(`All coins: BUY decisions identical in ${pct(tot.same, tot.n, 2)} of ${tot.n} hours; on both ${tot.both}, only Binance ${tot.onlyA}, only Bybit ${tot.onlyB}.`);
  L.push("");
  L.push("## 3. The existing BUY/SELL system run on each source (fees only, trend-break exit ON)");
  L.push(...table(["coin", "Binance candles", "Bybit candles"], r3));
  const seg = (t: LiveTrade[], a: number, b: number) => t.filter((x) => x.entryAt >= a && x.entryAt < b);
  L.push(`All coins, all: Binance ${stat(tradesA)} | Bybit ${stat(tradesB)}`);
  L.push(`All coins, in-sample: Binance ${stat(seg(tradesA, P.startMs, P.splitMs))} | Bybit ${stat(seg(tradesB, P.startMs, P.splitMs))}`);
  L.push(`All coins, out-of-sample: Binance ${stat(seg(tradesA, P.splitMs, P.endMs + 1))} | Bybit ${stat(seg(tradesB, P.splitMs, P.endMs + 1))}`);
  console.log(L.join("\n"));
}
main().catch((e) => { console.error(String(e && (e as Error).stack ? (e as Error).stack : e)); process.exit(1); });
