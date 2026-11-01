import { DEFAULT_SETTINGS } from "@/lib/settings";
import { M5, aggregate, replay } from "@/lib/setups-backtest";
import type { Candle } from "@/lib/types";
import { DAY, H1, H4, buildCtx, priceAt, simulateLive, type Ctx, type LiveOpts } from "./ctx";
import { fetchKlines, probe, type Source } from "./data";
import { fx, mean, median, pct, table } from "./stats";
import { hoursOf, type Period } from "./sec-trend";

const dayStr = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function qualitySection(ctxs: Ctx[], P: Period, btc5: Candle[] | null, raw: Map<string, Candle[]>): string[] {
  const L: string[] = [];
  L.push("### 5a. The 60/40 split");
  const span = P.endMs - P.startMs;
  L.push(`Replay window ${dayStr(P.startMs)} → ${dayStr(P.endMs)} (${fx(span / DAY, 0)} days). Split time = start + 60% of the window = ${new Date(P.splitMs).toISOString()}; in-sample = ${fx((P.splitMs - P.startMs) / DAY, 0)} days, out-of-sample = ${fx((P.endMs - P.splitMs) / DAY, 0)} days. The split is by calendar time (not by trade count) and trades are assigned by SIGNAL time.`);
  const o: LiveOpts = { trendExit: true, feePct: 0.1, slipPct: 0, startMs: P.startMs, endMs: P.endMs, maxHoldH: 14 * 24, stopPct: 2, takePct: 4 };
  const trades = ctxs.flatMap((c) => simulateLive(c, o));
  const straddle = trades.filter((t) => t.entryAt < P.splitMs && t.exitAt >= P.splitMs).length;
  L.push(`Trades entered before the split that were still open after it: ${straddle} of ${trades.length} (their outcome is decided partly by out-of-sample prices but they are counted in-sample; the effect is small and conservative for the OOS claim).`);
  L.push("The replay starts with an empty state at the window start, after a 40-day warm-up for indicators, so no signal can come from the warm-up period. No parameter was fitted on either segment.");
  L.push("");

  L.push("### 5b. Look-ahead test on REAL data");
  const cut = P.startMs + Math.floor((P.endMs - P.startMs) * 0.5 / DAY) * DAY;
  const key = (s: { strategy: string; kind: string; at: number; price: number }) => `${s.strategy}|${s.kind}|${s.at}|${s.price.toFixed(8)}`;
  let identical = 0, compared = 0;
  for (const c of ctxs.slice(0, 3)) {
    const full = replay(c.symbol, c.c5, btc5, { startMs: cut - 14 * DAY, endMs: P.endMs });
    const part = replay(c.symbol, c.c5.filter((x) => x.start + M5 <= cut), btc5 ? btc5.filter((x) => x.start + M5 <= cut) : null, { startMs: cut - 14 * DAY, endMs: cut });
    const a = part.sigs.map(key), b = full.sigs.filter((s) => s.at <= cut).map(key);
    compared += a.length;
    if (JSON.stringify(a) === JSON.stringify(b)) identical += a.length;
    else L.push(`MISMATCH for ${c.symbol}: ${a.length} signals with truncated data vs ${b.length} with all data.`);
  }
  L.push(`Replaying with all data vs with data cut at ${dayStr(cut)}: ${identical} of ${compared} signals identical (${compared ? pct(identical, compared, 0) : "n/a"}). ${identical === compared && compared > 0 ? "No look-ahead found in signal detection." : compared === 0 ? "No signals in that window, so this test says nothing." : "LOOK-AHEAD OR NON-DETERMINISM FOUND."}`);
  L.push("What the test does not cover: the opportunity ('false negative') and exit-warning outcome measures look forward on purpose; they are labelled hindsight yardsticks and are not signals.");
  L.push("");

  L.push("### 5c. Costs: back-test vs live system");
  L.push("- Live paper engine (src/lib/paper.ts): fee 0.1% on the amount spent and 0.1% on the value sold; NO slippage; entry at the ticker price at the moment of the scan; stop/target tested only against the price seen at each 5-minute scan (an intra-scan spike is invisible), exiting at that scan price.");
  L.push("- First back-test (src/lib/setups-backtest.ts): fee 0.1% + slippage 0.05% each side (0.3% round trip vs 0.2%), 5-minute delay, stop/target tested against every 5-minute high/low, a candle touching both counts as the stop, target fills also pay slippage (conservative), fixed 24h maximum hold, no trend-break exit.");
  L.push("- The two are different models of the same system. Neither is 'wrong', but the first back-test was NOT a replica of the live app. Section 1e re-runs the live system with its real functions.");
  L.push("");

  L.push("### 5d. Market regime in the two segments (buy-and-hold, no costs)");
  const rows = ctxs.map((c) => {
    const a = priceAt(c, P.startMs), b = priceAt(c, P.splitMs), z = priceAt(c, P.endMs - M5);
    return [c.symbol.replace("USDT", ""), a && b ? fx((b / a - 1) * 100, 1) + "%" : "n/a", b && z ? fx((z / b - 1) * 100, 1) + "%" : "n/a"];
  });
  L.push(...table(["coin", "in-sample move", "out-of-sample move"], rows));
  const isMv = rows.map((r) => parseFloat(String(r[1]))).filter((x) => Number.isFinite(x)), oosMv = rows.map((r) => parseFloat(String(r[2]))).filter((x) => Number.isFinite(x));
  L.push(`Average coin: in-sample ${fx(mean(isMv), 1)}%, out-of-sample ${fx(mean(oosMv), 1)}%. A long-only strategy scored on a falling segment is partly measuring the market, which is why section 1e compares against random entries inside the same segment rather than against zero.`);
  L.push("");

  L.push("### 5e. Data gaps");
  const gapRows = ctxs.map((c) => {
    const first = c.c5[0]?.start ?? 0, last = c.c5[c.c5.length - 1]?.start ?? 0;
    const expected = Math.round((last - first) / M5) + 1;
    return [c.symbol.replace("USDT", ""), c.c5.length, expected - c.c5.length, c.hours.filter((h) => h.buy.status === "DATA_INVALID").length];
  });
  L.push(...table(["coin", "5m candles", "missing 5m candles", "hourly evaluations rejected for data reasons"], gapRows));
  L.push("");
  L.push("### 5f. Statistical independence");
  const counts = ctxs.map((c) => { const m = new Map<number, number>(); for (const h of hoursOf(c, P)) if (h.buy.status === "SIGNAL") m.set(h.day, (m.get(h.day) ?? 0) + 1); return m; });
  const allDays = new Set(counts.flatMap((m) => [...m.keys()]));
  let shared = 0; for (const d of allDays) if (counts.filter((m) => m.has(d)).length >= 3) shared++;
  L.push(`Days with Trend BUY conditions true on at least one coin: ${allDays.size}; on 3 or more coins on the same day: ${shared}. Signals on different coins on the same day are driven by the same market move, so the ${trades.length} simulated trades are fewer than ${trades.length} independent observations. All confidence intervals in this report resample whole days for that reason; the first back-test resampled individual trades, which made its intervals too narrow.`);
  return L;
}

export async function dataSection(period: Period, symbols: string[], primary: Source, primaryRaw: Map<string, Candle[]>): Promise<{ lines: string[]; bybitOk: boolean }> {
  const L: string[] = [];
  L.push("### 4a. Which sources can this machine reach?");
  const probes: Array<[string, string]> = [
    ["Binance public data API (klines)", "https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=2"],
    ["Bybit v5 API (spot klines)", "https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=60&limit=2"],
    ["Bybit public data site (daily trade files, spot)", "https://public.bybit.com/spot/BTCUSDT/"],
    ["Bybit public data site (derivatives trade files)", "https://public.bybit.com/trading/BTCUSDT/"],
  ];
  for (const [name, url] of probes) L.push(`- ${name}: ${await probe(url)}`);
  L.push("");
  const from = period.endMs - 45 * DAY, to = period.endMs;
  const syms = symbols.filter((s) => ["BTCUSDT", "ETHUSDT", "SOLUSDT"].includes(s));
  const bin = new Map<string, Candle[]>(), byb = new Map<string, Candle[]>();
  let bybitOk = false, err = "";
  try {
    for (const s of syms) { bin.set(s, await fetchKlines("binance", s, "5m", "5", M5, from, to)); byb.set(s, await fetchKlines("bybit", s, "5m", "5", M5, from, to)); }
    bybitOk = [...byb.values()].every((a) => a.length > 1000);
  } catch (e) { err = String(e); }
  L.push("### 4b. Binance vs Bybit candles (same 45 days, 5-minute)");
  if (!bybitOk) {
    L.push(`Could not compare: ${err || "Bybit returned too little data"}. If Bybit is blocked from this machine the full back-test cannot be re-run here on Bybit data; see the recommendations.`);
    return { lines: L, bybitOk: false };
  }
  const rows: Array<Array<string | number>> = [];
  for (const s of syms) {
    const A = new Map((bin.get(s) as Candle[]).map((c) => [c.start, c])), B = byb.get(s) as Candle[];
    const dC: number[] = [], dH: number[] = [], dL: number[] = [], vr: number[] = [];
    let matched = 0;
    for (const b of B) { const a = A.get(b.start); if (!a) continue; matched++; dC.push(Math.abs(a.close / b.close - 1) * 100); dH.push(Math.abs(a.high / b.high - 1) * 100); dL.push(Math.abs(a.low / b.low - 1) * 100); if (a.volume > 0) vr.push(b.volume / a.volume); }
    const q = (xs: number[], p: number) => { const t = [...xs].sort((x, y) => x - y); return t[Math.min(t.length - 1, Math.floor(p * t.length))]; };
    rows.push([s.replace("USDT", ""), `${B.length}/${(bin.get(s) as Candle[]).length}`, matched, fx(median(dC), 4) + "%", fx(q(dC, 0.99), 3) + "%", fx(q(dH, 0.99), 3) + "%", fx(q(dL, 0.99), 3) + "%", fx(median(vr), 2)]);
  }
  L.push(...table(["coin", "Bybit/Binance candles", "matching times", "median |close diff|", "99th pct close", "99th pct high", "99th pct low", "median volume ratio (Bybit/Binance)"], rows));
  L.push("");
  L.push("### 4c. Would the signals differ?");
  const evalFrom = from + 12 * DAY;
  const r2: Array<Array<string | number>> = [];
  const btcB = bin.get("BTCUSDT") ?? null, btcY = byb.get("BTCUSDT") ?? null;
  for (const s of syms) {
    const a = buildCtx(s, bin.get(s) as Candle[], btcB, evalFrom, to, DEFAULT_SETTINGS), b = buildCtx(s, byb.get(s) as Candle[], btcY, evalFrom, to, DEFAULT_SETTINGS);
    const mb = new Map(b.hours.map((h) => [h.ct, h]));
    let both = 0, onlyA = 0, onlyB = 0, same = 0, n = 0;
    for (const h of a.hours) {
      const o = mb.get(h.ct); if (!o) continue;
      n++;
      const x = h.buy.status === "SIGNAL", y = o.buy.status === "SIGNAL";
      if (x && y) both++; else if (x) onlyA++; else if (y) onlyB++;
      if (x === y) same++;
    }
    r2.push([s.replace("USDT", ""), n, pct(same, n, 1), both, onlyA, onlyB, a.hours.filter((h) => h.bounce.full).length + "/" + b.hours.filter((h) => h.bounce.full).length, a.hours.filter((h) => h.exitW.full).length + "/" + b.hours.filter((h) => h.exitW.full).length]);
  }
  L.push(...table(["coin", "hours compared", "same BUY decision", "BUY on both", "BUY only on Binance", "BUY only on Bybit", "bounce full (Binance/Bybit)", "exit warning full (Binance/Bybit)"], r2));
  L.push("");
  L.push("### 4d. Does aggregating 5-minute candles reproduce the exchange's own 1h/4h candles? (the app reads native candles)");
  for (const src of ["binance", "bybit"] as Source[]) {
    try {
      const five = src === "binance" ? bin.get("BTCUSDT") as Candle[] : byb.get("BTCUSDT") as Candle[];
      for (const [label, ms, bI, yI] of [["1h", H1, "1h", "60"], ["4h", H4, "4h", "240"]] as Array<[string, number, string, string]>) {
        const native = await fetchKlines(src, "BTCUSDT", bI, yI, ms, from, to);
        const agg = new Map(aggregate(five, ms).map((c) => [c.start, c]));
        let m = 0, bad = 0, volBad = 0;
        for (const nc of native) { const a = agg.get(nc.start); if (!a) continue; m++; if (Math.abs(a.open / nc.open - 1) > 1e-9 || Math.abs(a.high / nc.high - 1) > 1e-9 || Math.abs(a.low / nc.low - 1) > 1e-9 || Math.abs(a.close / nc.close - 1) > 1e-9) bad++; if (Math.abs(a.volume / nc.volume - 1) > 1e-6) volBad++; }
        L.push(`- ${src} ${label}: ${native.length} native candles, ${m} comparable, ${bad} with a different open/high/low/close, ${volBad} with different volume.`);
      }
    } catch (e) { L.push(`- ${src}: could not compare (${String(e).slice(0, 120)})`); }
  }
  void primary; void primaryRaw;
  return { lines: L, bybitOk: true };
}
