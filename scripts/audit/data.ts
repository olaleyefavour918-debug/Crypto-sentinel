import type { Candle } from "@/lib/types";
import { M5 } from "@/lib/setups-backtest";

export const BINANCE = "https://data-api.binance.vision";
export const BYBIT = "https://api.bybit.com";
export type Source = "binance" | "bybit";

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

export const fetch5m = (s: Source, symbol: string, from: number, to: number) => fetchKlines(s, symbol, "5m", "5", M5, from, to);

export async function probe(url: string): Promise<string> {
  try {
    const r = await fetch(url, { method: "GET" });
    const text = (await r.text()).slice(0, 160).replace(/\s+/g, " ");
    return `HTTP ${r.status} · ${text}`;
  } catch (e) { return `unreachable: ${String(e)}`; }
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
