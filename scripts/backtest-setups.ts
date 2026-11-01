/**
 * Back-test runner for the setup strategies.
 *   npx tsx --tsconfig tests/tsconfig.json scripts/backtest-setups.ts --days 180 --out backtest-out
 *   npx tsx --tsconfig tests/tsconfig.json scripts/backtest-setups.ts --synthetic --days 60     (code check only, NOT evidence)
 * Real mode downloads public 5-minute klines (no API key, no account, read-only).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { buildReport, formatReport, M5, replay, rng, type CoinData } from "@/lib/setups-backtest";
import type { Candle } from "@/lib/types";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const flag = (k: string) => process.argv.includes(`--${k}`);
const days = Number(arg("days", "180"));
const warmDays = 40;
const out = arg("out", "backtest-out");
const symbols = arg("symbols", "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,BNBUSDT,DOGEUSDT,ADAUSDT,LINKUSDT").split(",");
const BINANCE = "https://data-api.binance.vision";
const BYBIT = "https://api.bybit.com";
const sourceArg = arg("source", "auto"); // binance | bybit | auto (Binance first, then Bybit)
let sourceUsed = "";

async function getJson(url: string): Promise<unknown> {
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      last = String(e);
      if (/HTTP 4(51|03)/.test(last)) break; // blocked for legal/regional reasons: retrying will not help
      await new Promise((s) => setTimeout(s, 1500 * (attempt + 1)));
    }
  }
  throw new Error(`${url.split("?")[0]}: ${last}`);
}

async function fetchBinance(symbol: string, fromMs: number, toMs: number): Promise<Candle[]> {
  const res: Candle[] = [];
  let cursor = fromMs;
  while (cursor < toMs) {
    const body = (await getJson(`${BINANCE}/api/v3/klines?symbol=${symbol}&interval=5m&startTime=${cursor}&limit=1000`)) as unknown[][];
    if (!Array.isArray(body) || body.length === 0) break;
    for (const k of body) res.push({ start: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]), turnover: Number(k[7]) });
    cursor = Number(body[body.length - 1][0]) + M5;
    if (body.length < 1000) break;
  }
  return res;
}

async function fetchBybit(symbol: string, fromMs: number, toMs: number): Promise<Candle[]> {
  const res: Candle[] = [];
  for (let cursor = fromMs; cursor < toMs; cursor += 1000 * M5) {
    const end = Math.min(toMs - 1, cursor + 1000 * M5 - 1);
    const body = (await getJson(`${BYBIT}/v5/market/kline?category=spot&symbol=${symbol}&interval=5&start=${cursor}&end=${end}&limit=1000`)) as { retCode?: number; result?: { list?: string[][] } };
    if (body.retCode !== 0) throw new Error(`${symbol}: Bybit retCode ${body.retCode}`);
    for (const k of body.result?.list ?? []) res.push({ start: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]), turnover: Number(k[6]) });
  }
  return res.sort((a, b) => a.start - b.start);
}

async function fetchKlines(symbol: string, fromMs: number, toMs: number): Promise<Candle[]> {
  let raw: Candle[];
  if (!sourceUsed) {
    // Decide the source once, with a small probe, and then use it for every coin.
    const order = sourceArg === "bybit" ? ["bybit"] : sourceArg === "binance" ? ["binance"] : ["binance", "bybit"];
    const errors: string[] = [];
    for (const name of order) {
      try {
        const probe = name === "binance" ? await fetchBinance(symbol, fromMs, fromMs + 50 * M5) : await fetchBybit(symbol, fromMs, fromMs + 50 * M5);
        if (probe.length > 0) { sourceUsed = name; break; }
        errors.push(`${name}: empty response`);
      } catch (e) { errors.push(`${name}: ${String(e)}`); }
    }
    if (!sourceUsed) throw new Error(`No market-data source could be reached from this machine, so no back-test was run. Tried: ${errors.join(" | ")}`);
    console.log(`Using source: ${sourceUsed}`);
  }
  raw = sourceUsed === "binance" ? await fetchBinance(symbol, fromMs, toMs) : await fetchBybit(symbol, fromMs, toMs);
  const seen = new Set<number>();
  return raw.filter((c) => c.start < toMs && !seen.has(c.start) && (seen.add(c.start), true) && [c.open, c.high, c.low, c.close].every((x) => Number.isFinite(x) && x > 0));
}

/** Random-walk candles with drifting regimes. ONLY for checking that the code runs; it says nothing about real markets. */
function synthetic(seed: number, fromMs: number, toMs: number): Candle[] {
  const r = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  const res: Candle[] = [];
  let price = 100, drift = 0, left = 0;
  for (let t = fromMs; t < toMs; t += M5) {
    if (left-- <= 0) { drift = (r() - 0.5) * 0.0012; left = 200 + Math.floor(r() * 1500); }
    const open = price;
    const close = open * (1 + drift + gauss() * 0.0018);
    const high = Math.max(open, close) * (1 + Math.abs(gauss()) * 0.0009);
    const low = Math.min(open, close) * (1 - Math.abs(gauss()) * 0.0009);
    const volume = 100 * (0.5 + r()) * (1 + Math.abs(close - open) / open * 400);
    res.push({ start: t, open, high, low, close, volume, turnover: volume * close });
    price = close;
  }
  return res;
}

async function main() {
  const endMs = Math.floor(Date.now() / (24 * 3600_000)) * 24 * 3600_000; // up to 00:00 UTC today
  const startMs = endMs - days * 24 * 3600_000;
  const fetchFrom = startMs - warmDays * 24 * 3600_000;
  const syn = flag("synthetic");
  console.log(`Period: ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()} (+${warmDays} days warm-up)`);

  const data = new Map<string, Candle[]>();
  for (const [i, s] of symbols.entries()) {
    data.set(s, syn ? synthetic(1000 + i, fetchFrom, endMs) : await fetchKlines(s, fetchFrom, endMs));
    console.log(`${s}: ${data.get(s)?.length} candles`);
  }
  const source = syn ? "SYNTHETIC RANDOM DATA — this checks the code only and is NOT evidence about any strategy"
    : sourceUsed === "bybit" ? "Bybit public spot 5-minute klines (api.bybit.com)" : "Binance public spot 5-minute klines (data-api.binance.vision), used as a proxy for Bybit spot";
  console.log(`Source: ${source}`);
  const btc = data.get("BTCUSDT") ?? null;
  const coins: CoinData[] = [];
  for (const s of symbols) {
    const c5 = data.get(s) as Candle[];
    if (c5.length < 5000) { console.log(`${s}: too little data, skipped`); continue; }
    const t0 = Date.now();
    const on = replay(s, c5, btc, { startMs, endMs, h4Conflict: true });
    const off = replay(s, c5, btc, { startMs, endMs, h4Conflict: false, strategies: ["BOUNCE"] });
    console.log(`${s}: replayed ${on.scans} scans in ${((Date.now() - t0) / 1000).toFixed(0)}s · signals ${on.sigs.length}`);
    coins.push({ symbol: s, c5, on, off });
  }
  const report = buildReport(coins, { startMs, endMs });
  const text = formatReport(report, source);
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/report.md`, text);
  writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 1));
  console.log("\n" + text);
}

main().catch((e) => { console.error(String(e)); process.exit(1); });
