import type { Candle } from "@/lib/types";
import { M5 } from "@/lib/setups-backtest";
import { gunzipSync } from "node:zlib";

export const BINANCE = "https://data-api.binance.vision";
export const BYBIT = "https://api.bybit.com";
export type Source = "binance" | "bybit" | "bybit-trades";

export async function getJson(url: string): Promise<unknown> {
  let last = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      last = String(e);
      if (/HTTP 4(51|03|04)/.test(last)) break;
      await new Promise((s) => setTimeout(s, 1500 * (attempt + 1)));
    }
  }
  throw new Error(`${url.split("?")[0]}: ${last}`);
}

const row = (k: Array<string | number>, turnoverIdx: number): Candle => ({ start: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]), turnover: Number(k[turnoverIdx]) });

/** Klines of any interval. `binanceInterval` like 5m/1h/4h, `bybitInterval` like 5/60/240; `stepMs` is the candle length. */
export async function fetchKlines(source: Source, symbol: string, binanceInterval: string, bybitInterval: string, stepMs: number, fromMs: number, toMs: number): Promise<Candle[]> {
  const res: Candle[] = [];
  if (source === "binance") {
    let cursor = fromMs;
    while (cursor < toMs) {
      const body = (await getJson(`${BINANCE}/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&startTime=${cursor}&limit=1000`)) as Array<Array<string | number>>;
      if (!Array.isArray(body) || body.length === 0) break;
      for (const k of body) res.push(row(k, 7));
      cursor = Number(body[body.length - 1][0]) + stepMs;
      if (body.length < 1000) break;
    }
  } else {
    for (let cursor = fromMs; cursor < toMs; cursor += 1000 * stepMs) {
      const end = Math.min(toMs - 1, cursor + 1000 * stepMs - 1);
      const body = (await getJson(`${BYBIT}/v5/market/kline?category=spot&symbol=${symbol}&interval=${bybitInterval}&start=${cursor}&end=${end}&limit=1000`)) as { retCode?: number; result?: { list?: string[][] } };
      if (body.retCode !== 0) throw new Error(`${symbol}: Bybit retCode ${body.retCode}`);
      for (const k of body.result?.list ?? []) res.push(row(k, 6));
    }
  }
  res.sort((a, b) => a.start - b.start);
  const seen = new Set<number>();
  return res.filter((c) => c.start < toMs && !seen.has(c.start) && (seen.add(c.start), true) && [c.open, c.high, c.low, c.close].every((x) => Number.isFinite(x) && x > 0));
}

export const fetch5m = (s: Source, symbol: string, from: number, to: number): Promise<Candle[]> =>
  s === "bybit-trades" ? fetchBybitTrades5m(symbol, from, to) : fetchKlines(s, symbol, "5m", "5", M5, from, to);

const DAYMS = 86_400_000;
const links = (html: string): string[] => [...html.matchAll(/href="([^"?#]+)"/g)].map((m) => m[1]).filter((x) => !x.startsWith("/") && !x.startsWith("http"));

async function download(url: string): Promise<Buffer | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (attempt === 3) throw new Error(`${url}: ${String(e)}`);
      await new Promise((s) => setTimeout(s, 2000 * (attempt + 1)));
    }
  }
  return null;
}

/** Adds every trade of one Bybit spot trade file (header: id,timestamp,price,volume,side,rpi) into 5-minute buckets. */
export function addTrades(text: string, into: Map<number, { c: Candle; ft: number; lt: number }>, fromMs: number, toMs: number): void {
  let pos = text.indexOf("\n") + 1;
  const n = text.length;
  while (pos < n) {
    let end = text.indexOf("\n", pos);
    if (end < 0) end = n;
    const c1 = text.indexOf(",", pos), c2 = text.indexOf(",", c1 + 1), c3 = text.indexOf(",", c2 + 1), c4 = text.indexOf(",", c3 + 1);
    if (c1 > 0 && c4 > 0 && c4 < end) {
      let t = Number(text.slice(c1 + 1, c2));
      if (t < 1e12) t *= 1000;
      const p = Number(text.slice(c2 + 1, c3)), v = Number(text.slice(c3 + 1, c4));
      if (t >= fromMs && t < toMs && p > 0 && v >= 0) {
        const k = Math.floor(t / M5) * M5;
        const b = into.get(k);
        if (!b) into.set(k, { c: { start: k, open: p, high: p, low: p, close: p, volume: v, turnover: p * v }, ft: t, lt: t });
        else {
          if (p > b.c.high) b.c.high = p;
          if (p < b.c.low) b.c.low = p;
          if (t < b.ft) { b.ft = t; b.c.open = p; }
          if (t >= b.lt) { b.lt = t; b.c.close = p; }
          b.c.volume += v; b.c.turnover += p * v;
        }
      }
    }
    pos = end + 1;
  }
}

/**
 * Real Bybit SPOT history from public.bybit.com (daily trade files), turned into 5-minute candles: open = first trade, close = last trade,
 * high/low = extremes, volume = base quantity. A 5-minute bucket with no trades at all is filled flat from the previous close (volume 0)
 * when the silence is at most 30 minutes; longer silences are left as gaps.
 */
export async function fetchBybitTrades5m(symbol: string, fromMs: number, toMs: number, concurrency = 6): Promise<Candle[]> {
  const listing = await fetch(`https://public.bybit.com/spot/${symbol}/`);
  if (!listing.ok) throw new Error(`public.bybit.com listing for ${symbol}: HTTP ${listing.status}`);
  const names = new Set(links(await listing.text()));
  const into = new Map<number, { c: Candle; ft: number; lt: number }>();
  const tasks: Array<{ name: string }> = [];
  const months = new Set<string>();
  for (let d = Math.floor(fromMs / DAYMS) * DAYMS; d < toMs; d += DAYMS) {
    const day = new Date(d).toISOString().slice(0, 10);
    const daily = `${symbol}_${day}.csv.gz`, monthly = `${symbol}-${day.slice(0, 7)}.csv.gz`;
    if (names.has(daily)) tasks.push({ name: daily });
    else if (names.has(monthly) && !months.has(monthly)) { months.add(monthly); tasks.push({ name: monthly }); }
  }
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const t = tasks[next++];
      const buf = await download(`https://public.bybit.com/spot/${symbol}/${t.name}`);
      if (!buf) continue;
      addTrades(gunzipSync(buf).toString("utf8"), into, fromMs, toMs);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const keys = [...into.keys()].sort((a, b) => a - b);
  const out: Candle[] = [];
  for (const k of keys) {
    const prev = out[out.length - 1];
    if (prev) for (let t = prev.start + M5, filled = 0; t < k && filled < 6; t += M5, filled++) out.push({ start: t, open: prev.close, high: prev.close, low: prev.close, close: prev.close, volume: 0, turnover: 0 });
    out.push((into.get(k) as { c: Candle }).c);
  }
  return out.sort((a, b) => a.start - b.start);
}

export async function probe(url: string): Promise<string> {
  try {
    const r = await fetch(url, { method: "GET" });
    const text = (await r.text()).slice(0, 160).replace(/\s+/g, " ");
    return `HTTP ${r.status} · ${text}`;
  } catch (e) { const cause = (e as { cause?: { code?: string; message?: string } }).cause; return `unreachable: ${String(e)} ${cause?.code ?? ""} ${cause?.message ?? ""}`; }
}

/** Random-walk 5m candles for checking that the code runs. Says nothing about real markets. */
export function synthetic(seed: number, fromMs: number, toMs: number, rngFn: () => number): Candle[] {
  void seed;
  const r = rngFn;
  const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  const res: Candle[] = [];
  let price = 100, drift = 0, left = 0;
  for (let t = fromMs; t < toMs; t += M5) {
    if (left-- <= 0) { drift = (r() - 0.5) * 0.0012; left = 200 + Math.floor(r() * 1500); }
    const open = price, close = open * (1 + drift + gauss() * 0.0018);
    const high = Math.max(open, close) * (1 + Math.abs(gauss()) * 0.0009), low = Math.min(open, close) * (1 - Math.abs(gauss()) * 0.0009);
    const volume = 100 * (0.5 + r()) * (1 + (Math.abs(close - open) / open) * 400);
    res.push({ start: t, open, high, low, close, volume, turnover: volume * close });
    price = close;
  }
  return res;
}
