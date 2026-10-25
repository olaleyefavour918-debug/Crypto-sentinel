import type { Candle } from "@/lib/types";

export const H1 = 3600_000;
export const H4 = 4 * H1;
/** A fixed "now" used across tests: 2026-10-18 15:05:00 UTC (5 min after the 15:00 hourly close). */
export const NOW = Date.UTC(2026, 9, 18, 15, 5, 0);

export function makeCandles(n: number, endBoundary: number, interval: number, f: (i: number) => number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const start = endBoundary - (n - i) * interval;
    const c = f(i);
    const o = i === 0 ? c : f(i - 1);
    out.push({ start, open: o, high: Math.max(o, c) + 20, low: Math.min(o, c) - 20, close: c, volume: 10, turnover: 1000 });
  }
  return out;
}

const floorTo = (t: number, i: number) => Math.floor(t / i) * i;

/** Uptrend + oscillation that ends in a state satisfying every BUY condition (RSI ≈ 55, MACD hist > 0, EMA20 > EMA50). */
export function signalMarket(now = NOW) {
  const h1 = makeCandles(220, floorTo(now, H1), H1, (i) => 60000 + 8 * i + 200 * Math.sin((i + 9) / 2.2));
  const h4 = makeCandles(220, floorTo(now, H4), H4, (i) => 55000 + 32 * i + 500 * Math.sin((i + 9) / 2.5));
  return { h1, h4 };
}

/** Same data but a downtrend, so no BUY condition can pass. */
export function downMarket(now = NOW) {
  const h1 = makeCandles(220, floorTo(now, H1), H1, (i) => 70000 - 10 * i);
  const h4 = makeCandles(220, floorTo(now, H4), H4, (i) => 70000 - 40 * i);
  return { h1, h4 };
}

/** Multiplies every price in a candle series (so one fixture can stand in for ETH, SOL, XRP …). Indicators are scale-invariant. */
export function scaled(candles: Candle[], k: number): Candle[] {
  return candles.map((c) => ({ ...c, open: c.open * k, high: c.high * k, low: c.low * k, close: c.close * k }));
}

export interface MockSymbol {
  h1: Candle[];
  h4: Candle[];
  lastPrice: number;
  price24hPcnt?: number;
}

/** A mutable fake exchange: change `now`, prices or candles between monitor runs to simulate time passing. */
export interface MockExchange {
  now: number;
  symbols: Record<string, MockSymbol>;
  /** symbols that /instruments-info reports as listed. Defaults to every key of `symbols`. */
  listed?: Record<string, { status: string }>;
}

export interface BybitMockOptions {
  failKlines?: number | "always"; // number of initial kline failures (HTTP 500) or always
  failKlinesFor?: string[]; // symbols whose klines always fail (isolation tests)
  failTickers?: boolean;
  httpStatus?: number;
  badBody?: unknown;
  includeOpenCandle?: boolean;
  tickerTimeOffsetMs?: number;
  log?: string[];
}

const row = (c: Candle) => [String(c.start), String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume), String(c.turnover)];

export function bybitFetch(ex: MockExchange, opts: BybitMockOptions = {}): typeof fetch {
  let klineFailures = 0;
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    opts.log?.push(url.pathname + url.search);
    const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (opts.httpStatus) return respond({}, opts.httpStatus);
    if (opts.badBody !== undefined) return respond(opts.badBody);
    const symbol = url.searchParams.get("symbol");
    if (url.pathname === "/v5/market/kline") {
      if (opts.failKlines === "always" || (typeof opts.failKlines === "number" && klineFailures < opts.failKlines)) {
        klineFailures++;
        return respond({ retCode: 10016, retMsg: "server busy" }, 500);
      }
      if (symbol && opts.failKlinesFor?.includes(symbol)) return respond({ retCode: 10001, retMsg: "params error" }, 200);
      const m = symbol ? ex.symbols[symbol] : undefined;
      if (!m) return respond({ retCode: 10001, retMsg: "Invalid symbol" });
      const interval = url.searchParams.get("interval");
      const src = interval === "240" ? m.h4 : m.h1;
      const step = interval === "240" ? H4 : H1;
      const list = [...src].reverse().map(row);
      if (opts.includeOpenCandle !== false) {
        const last = src[src.length - 1];
        const forming: Candle = { ...last, start: floorTo(ex.now, step), open: last.close, close: last.close * 1.0001, high: last.close * 1.0005, low: last.close * 0.9995 };
        list.unshift(row(forming));
      }
      return respond({ retCode: 0, retMsg: "OK", result: { category: "spot", symbol, list }, time: ex.now });
    }
    if (url.pathname === "/v5/market/tickers") {
      if (opts.failTickers) return respond({}, 500);
      const names = symbol ? [symbol] : Object.keys(ex.symbols);
      const list = names.filter((n) => ex.symbols[n]).map((n) => {
        const t = ex.symbols[n];
        return { symbol: n, lastPrice: String(t.lastPrice), price24hPcnt: String(t.price24hPcnt ?? 0.0123), highPrice24h: String(t.lastPrice * 1.02), lowPrice24h: String(t.lastPrice * 0.98), volume24h: "1234.5", turnover24h: "76000000" };
      });
      // A real "all tickers" response contains many symbols we do not monitor.
      if (!symbol) list.push({ symbol: "ZZZUSDT", lastPrice: "1", price24hPcnt: "0", highPrice24h: "1", lowPrice24h: "1", volume24h: "1", turnover24h: "1" });
      return respond({ retCode: 0, retMsg: "OK", result: { category: "spot", list }, time: ex.now + (opts.tickerTimeOffsetMs ?? 0) });
    }
    if (url.pathname === "/v5/market/instruments-info") {
      const listed = ex.listed ?? Object.fromEntries(Object.keys(ex.symbols).map((k) => [k, { status: "Trading" }]));
      const hit = symbol ? listed[symbol] : undefined;
      const list = hit && symbol ? [{ symbol, baseCoin: symbol.replace(/USDT$/, ""), quoteCoin: "USDT", status: hit.status }] : [];
      return respond({ retCode: 0, retMsg: "OK", result: { category: "spot", list }, time: ex.now });
    }
    return respond({}, 404);
  }) as typeof fetch;
}

/** The default five coins, each with a BUY-signal fixture scaled to a realistic price level. */
export function defaultExchange(now = NOW, kind: "signal" | "down" = "signal"): MockExchange {
  const base = kind === "signal" ? signalMarket(now) : downMarket(now);
  const levels: Record<string, number> = { BTCUSDT: 1, ETHUSDT: 0.05, SOLUSDT: 0.0028, XRPUSDT: 0.00001, BNBUSDT: 0.0105 };
  const symbols: Record<string, MockSymbol> = {};
  for (const [sym, k] of Object.entries(levels)) {
    const h1 = scaled(base.h1, k);
    symbols[sym] = { h1, h4: scaled(base.h4, k), lastPrice: h1[h1.length - 1].close };
  }
  return { now, symbols };
}

export interface EmailCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Mock of the Resend/Brevo REST endpoints. `responses` are consumed in order; the last one repeats. */
type EmailReply = { status: number; body: unknown } | "throw" | "timeout" | ((call: EmailCall, n: number) => { status: number; body: unknown });

export function emailFetch(responses: EmailReply[], calls: EmailCall[] = []): typeof fetch {
  let i = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url: String(input), headers, body: JSON.parse(String(init?.body ?? "{}")) });
    const idx = i++;
    const raw = responses[Math.min(idx, responses.length - 1)];
    const r = typeof raw === "function" ? raw(calls[calls.length - 1], idx) : raw;
    if (r === "throw") throw new TypeError("fetch failed");
    if (r === "timeout") {
      const e = new Error("timed out");
      e.name = "TimeoutError";
      throw e;
    }
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

export const RESEND_ENV = { RESEND_API_KEY: "re_test_key_1234567890abcdef", ADMIN_PASSWORD: "correct horse battery staple", CRON_SECRET: "0123456789abcdef0123456789abcdef" };
