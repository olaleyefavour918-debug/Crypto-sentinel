import type { Candle, Interval, Ticker24h } from "./types";

/**
 * Bybit PUBLIC market-data client. No API keys are used or accepted anywhere in this project.
 * Endpoints: GET /v5/market/kline and GET /v5/market/tickers (category=spot, symbol=BTCUSDT).
 */

export type BybitErrorKind = "timeout" | "network" | "rate_limit" | "blocked" | "http" | "invalid";

export class BybitError extends Error {
  kind: BybitErrorKind;
  status?: number;
  retryable: boolean;
  constructor(kind: BybitErrorKind, message: string, opts: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "BybitError";
    this.kind = kind;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
  }
}

export interface BybitDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Base URLs tried in order. Defaults to BYBIT_BASE_URL (if set), then api.bybit.com, then api.bytick.com. */
  baseUrls?: string[];
  timeoutMs?: number;
  maxAttempts?: number;
  random?: () => number;
}

const CATEGORY = "spot";

export const SYMBOL_RE = /^[A-Z0-9]{2,12}USDT$/;

export function assertSymbol(symbol: string): string {
  if (!SYMBOL_RE.test(symbol)) throw new BybitError("invalid", `Unsupported symbol "${symbol.slice(0, 20)}". Expected a USDT spot pair such as BTCUSDT.`);
  return symbol;
}

export function defaultBaseUrls(): string[] {
  const urls: string[] = [];
  const env = typeof process !== "undefined" ? process.env.BYBIT_BASE_URL : undefined;
  if (env && /^https:\/\/[a-z0-9.-]+$/i.test(env.trim().replace(/\/+$/, ""))) urls.push(env.trim().replace(/\/+$/, ""));
  for (const u of ["https://api.bybit.com", "https://api.bytick.com"]) if (!urls.includes(u)) urls.push(u);
  return urls;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function getJson(path: string, deps: BybitDeps): Promise<unknown> {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const rnd = deps.random ?? Math.random;
  const bases = deps.baseUrls ?? defaultBaseUrls();
  const timeoutMs = deps.timeoutMs ?? 8000;
  const maxAttempts = deps.maxAttempts ?? 3;
  let lastErr: BybitError | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const base = bases[attempt % bases.length];
    try {
      const res = await fetchFn(`${base}${path}`, {
        method: "GET",
        headers: { accept: "application/json", "user-agent": "btc-sentinel/1.0 (+paper-trading; public-data-only)" },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 403) {
        throw new BybitError(
          "blocked",
          "Bybit returned HTTP 403. The API is geo-restricted for some server regions (e.g. the United States). Use a non-restricted Vercel region or set BYBIT_BASE_URL.",
          { status: 403, retryable: true },
        );
      }
      if (res.status === 429) {
        throw new BybitError("rate_limit", "Bybit rate limit reached (HTTP 429).", { status: 429, retryable: true });
      }
      if (res.status >= 500) {
        throw new BybitError("http", `Bybit server error (HTTP ${res.status}).`, { status: res.status, retryable: true });
      }
      if (!res.ok) {
        throw new BybitError("http", `Unexpected HTTP ${res.status} from Bybit.`, { status: res.status, retryable: false });
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new BybitError("invalid", "Bybit returned a response that is not valid JSON.", { retryable: true });
      }
      if (typeof body !== "object" || body === null) throw new BybitError("invalid", "Bybit response was not an object.", { retryable: true });
      const retCode = (body as { retCode?: unknown }).retCode;
      if (retCode === 10006 || retCode === 10018) {
        throw new BybitError("rate_limit", "Bybit rate limit reached (retCode " + String(retCode) + ").", { retryable: true });
      }
      if (retCode !== 0) {
        throw new BybitError("invalid", `Bybit returned retCode ${String(retCode)}.`, { retryable: false });
      }
      return body;
    } catch (e) {
      const err = toBybitError(e);
      lastErr = err;
      if (!err.retryable || attempt === maxAttempts - 1) break;
      const retryAfter = err.kind === "rate_limit" ? 1500 : 0;
      const backoff = 300 * 2 ** attempt + Math.floor(rnd() * 200) + retryAfter;
      await sleep(Math.min(backoff, 5000));
    }
  }
  throw lastErr ?? new BybitError("network", "Unknown Bybit error.");
}

function toBybitError(e: unknown): BybitError {
  if (e instanceof BybitError) return e;
  const name = (e as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return new BybitError("timeout", "Request to Bybit timed out.", { retryable: true });
  }
  return new BybitError("network", "Network error contacting Bybit.", { retryable: true });
}

const num = (v: unknown): number => {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return n;
};

/** Parses & validates a kline response. Exported for tests. Returns candles sorted ascending (oldest first). */
export function parseKlineResponse(body: unknown): Candle[] {
  const list = (body as { result?: { list?: unknown } })?.result?.list;
  if (!Array.isArray(list) || list.length === 0) throw new BybitError("invalid", "Kline response contained no candles.");
  const out: Candle[] = [];
  const seen = new Set<number>();
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 7) throw new BybitError("invalid", "Malformed kline row.");
    const [t, o, h, l, c, v, to] = row.map(num);
    const values = [t, o, h, l, c, v, to];
    if (values.some((x) => !Number.isFinite(x))) throw new BybitError("invalid", "Non-numeric value in kline row.");
    if (o <= 0 || h <= 0 || l <= 0 || c <= 0 || v < 0 || h < l || h < Math.max(o, c) - 1e-9 || l > Math.min(o, c) + 1e-9) {
      throw new BybitError("invalid", "Kline row failed sanity checks (OHLC inconsistent).");
    }
    if (seen.has(t)) continue;
    seen.add(t);
    out.push({ start: t, open: o, high: h, low: l, close: c, volume: v, turnover: to });
  }
  return out.sort((a, b) => a.start - b.start);
}

function parseTickerItem(item: Record<string, unknown>, serverTime: number): Ticker24h {
  const last = num(item.lastPrice);
  const pct = num(item.price24hPcnt);
  const high = num(item.highPrice24h);
  const low = num(item.lowPrice24h);
  const vol = num(item.volume24h);
  const turn = num(item.turnover24h);
  if (![serverTime, last, pct, high, low, vol, turn].every(Number.isFinite) || last <= 0 || high <= 0 || low <= 0 || serverTime <= 0) {
    throw new BybitError("invalid", "Ticker response failed validation.");
  }
  return {
    symbol: String(item.symbol),
    lastPrice: last,
    change24hPct: pct * 100,
    high24h: high,
    low24h: low,
    volume24h: vol,
    turnover24h: turn,
    serverTime,
  };
}

/** Parses a single-symbol ticker response. Exported for tests. */
export function parseTickerResponse(body: unknown): Ticker24h {
  const item = (body as { result?: { list?: unknown[] } })?.result?.list?.[0] as Record<string, unknown> | undefined;
  if (!item) throw new BybitError("invalid", "Ticker response contained no data.");
  return parseTickerItem(item, num((body as { time?: unknown }).time));
}

/** Parses an all-spot-tickers response, keeping only the wanted symbols. Invalid entries become errors for that symbol only. */
export function parseTickersResponse(body: unknown, wanted: string[]): Map<string, Ticker24h | BybitError> {
  const list = (body as { result?: { list?: unknown } })?.result?.list;
  if (!Array.isArray(list)) throw new BybitError("invalid", "Tickers response contained no list.");
  const serverTime = num((body as { time?: unknown }).time);
  const want = new Set(wanted);
  const out = new Map<string, Ticker24h | BybitError>();
  for (const item of list as Array<Record<string, unknown>>) {
    const sym = String(item?.symbol);
    if (!want.has(sym)) continue;
    try {
      out.set(sym, parseTickerItem(item, serverTime));
    } catch (e) {
      out.set(sym, e instanceof BybitError ? e : new BybitError("invalid", "Ticker entry failed validation."));
    }
  }
  return out;
}

export async function fetchKlines(symbol: string, interval: Interval, limit: number, deps: BybitDeps = {}): Promise<Candle[]> {
  const lim = Math.max(10, Math.min(1000, Math.floor(limit)));
  const body = await getJson(`/v5/market/kline?category=${CATEGORY}&symbol=${assertSymbol(symbol)}&interval=${interval}&limit=${lim}`, deps);
  return parseKlineResponse(body);
}

export async function fetchTicker(symbol: string, deps: BybitDeps = {}): Promise<Ticker24h> {
  const body = await getJson(`/v5/market/tickers?category=${CATEGORY}&symbol=${assertSymbol(symbol)}`, deps);
  return parseTickerResponse(body);
}

/** One request for every spot ticker (cheaper than one call per coin). Symbols missing from the response map to an error. */
export async function fetchTickers(symbols: string[], deps: BybitDeps = {}): Promise<Map<string, Ticker24h | BybitError>> {
  symbols.forEach(assertSymbol);
  const body = await getJson(`/v5/market/tickers?category=${CATEGORY}`, deps);
  const map = parseTickersResponse(body, symbols);
  for (const s of symbols) if (!map.has(s)) map.set(s, new BybitError("invalid", `${s} was not found in Bybit's spot tickers.`));
  return map;
}

export interface InstrumentInfo {
  symbol: string;
  baseCoin: string;
  quoteCoin: string;
  trading: boolean;
}

/** Checks that a USDT spot pair exists and is currently tradable on Bybit (public endpoint). Returns null if unknown. */
export async function fetchInstrument(symbol: string, deps: BybitDeps = {}): Promise<InstrumentInfo | null> {
  const body = await getJson(`/v5/market/instruments-info?category=${CATEGORY}&symbol=${assertSymbol(symbol)}`, deps);
  const item = (body as { result?: { list?: Array<Record<string, unknown>> } })?.result?.list?.[0];
  if (!item || String(item.symbol) !== symbol) return null;
  return {
    symbol,
    baseCoin: String(item.baseCoin ?? ""),
    quoteCoin: String(item.quoteCoin ?? ""),
    trading: String(item.status) === "Trading",
  };
}

/** Maps any error to a short, safe string for logs / the dashboard (never contains URLs with secrets or stack traces). */
export function sanitizeError(e: unknown): string {
  if (e instanceof BybitError) return `${e.kind}: ${e.message}`.slice(0, 300);
  if (e instanceof Error) return e.message.replace(/[A-Za-z0-9_\-]{32,}/g, "[redacted]").slice(0, 300);
  return "Unknown error";
}
