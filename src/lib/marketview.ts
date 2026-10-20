import { fetchKlines, fetchTicker, sanitizeError, BybitError, type BybitDeps } from "./bybit";
import { candlesToFetch, closedCandles, computeSeries, expectedLastClosedStart, MAX_TICKER_AGE_MS } from "./rules";
import { INTERVAL_MS, type Candle, type Settings, type Ticker24h } from "./types";

export interface ChartPayload {
  /** Candle open times in UTC seconds (what lightweight-charts expects). */
  candles: Array<{ time: number; open: number; high: number; low: number; close: number }>;
  emaFast: Array<{ time: number; value: number }>;
  emaSlow: Array<{ time: number; value: number }>;
  lastClosedAt: number;
  stale: boolean;
}

export type MarketView =
  | {
      ok: true;
      symbol: string;
      source: "live";
      fetchedAt: number;
      ticker: Ticker24h;
      tickerFresh: boolean;
      h1: ChartPayload;
      h4: ChartPayload;
    }
  | { ok: false; error: { kind: string; message: string }; fetchedAt: number };

function toChart(all: Candle[], intervalMs: number, now: number, s: Settings, keep: number): ChartPayload {
  const closed = closedCandles(all, intervalMs, now);
  const series = computeSeries(closed, s);
  const from = Math.max(0, closed.length - keep);
  const sl = closed.slice(from);
  const line = (arr: Array<number | null>) =>
    arr.slice(from).flatMap((v, i) => (v === null ? [] : [{ time: Math.floor(sl[i].start / 1000), value: v }]));
  const last = closed.length ? closed[closed.length - 1].start : 0;
  return {
    candles: sl.map((c) => ({ time: Math.floor(c.start / 1000), open: c.open, high: c.high, low: c.low, close: c.close })),
    emaFast: line(series.emaFast),
    emaSlow: line(series.emaSlow),
    lastClosedAt: last,
    stale: last < expectedLastClosedStart(now, intervalMs),
  };
}

/** Fetches LIVE public data and shapes it for the charts. Never returns invented data: on failure `ok` is false. */
export async function buildMarketView(symbol: string, settings: Settings, deps: { bybit?: BybitDeps; now?: () => number } = {}): Promise<MarketView> {
  const now = (deps.now ?? Date.now)();
  try {
    const limit = Math.max(candlesToFetch(settings), 300);
    const [a, b, t] = await Promise.all([fetchKlines(symbol, "60", limit, deps.bybit), fetchKlines(symbol, "240", limit, deps.bybit), fetchTicker(symbol, deps.bybit)]);
    return {
      ok: true,
      symbol,
      source: "live",
      fetchedAt: now,
      ticker: t,
      tickerFresh: Math.abs(now - t.serverTime) <= MAX_TICKER_AGE_MS,
      h1: toChart(a, INTERVAL_MS["60"], now, settings, 200),
      h4: toChart(b, INTERVAL_MS["240"], now, settings, 150),
    };
  } catch (e) {
    return { ok: false, fetchedAt: now, error: { kind: e instanceof BybitError ? e.kind : "unknown", message: sanitizeError(e) } };
  }
}
