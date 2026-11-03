import type { SetupStatus } from "./lifecycle";
import type { Ticker24h } from "./types";

/**
 * Price audit for signals. Every signal keeps TWO things side by side and never merges them:
 *   - the reference price at the moment the signal was generated (immutable snapshot), and
 *   - the latest price seen on the most recent scan (updated every scan).
 * All prices are for the SAME Bybit spot instrument (e.g. SOLUSDT) taken from Bybit's public ticker. Bybit publishes no
 * mark price for spot pairs (mark price exists for derivatives only), so the index price is recorded separately and
 * labelled as such, together with the best bid and ask.
 */
export type RefSource = "ticker_last" | "forming_candle" | "last_closed_candle";

export interface PriceRef {
  /** Where `last` came from. Only "ticker_last" is a live last-traded price. */
  source: RefSource;
  last: number;
  indexPrice: number | null;
  bid: number | null;
  ask: number | null;
  /** Bybit's own response timestamp for the ticker (epoch ms), null when the price did not come from the ticker. */
  exchangeTime: number | null;
  /** Our clock when the scan ran (epoch ms): the exact generation time. */
  scanAt: number;
}

export const SOURCE_LABEL: Record<RefSource, string> = {
  ticker_last: "Bybit spot last traded price",
  forming_candle: "price of the unfinished 1H candle (live ticker unavailable)",
  last_closed_candle: "close of the last finished candle (live ticker unavailable, may be up to an hour old)",
};

export const MARK_PRICE_NOTE = "Bybit does not publish a mark price for spot pairs. The index price below is a separate reference.";

/** Builds the snapshot for one scan. `ticker` must already have passed the freshness check. */
export function buildPriceRef(o: { ticker: Ticker24h | null; fallbackPrice: number | null; fallbackSource: Exclude<RefSource, "ticker_last">; scanAt: number }): PriceRef | null {
  if (o.ticker) {
    return { source: "ticker_last", last: o.ticker.lastPrice, indexPrice: o.ticker.indexPrice ?? null, bid: o.ticker.bid ?? null, ask: o.ticker.ask ?? null, exchangeTime: o.ticker.serverTime, scanAt: o.scanAt };
  }
  if (o.fallbackPrice !== null && Number.isFinite(o.fallbackPrice) && o.fallbackPrice > 0) {
    return { source: o.fallbackSource, last: o.fallbackPrice, indexPrice: null, bid: null, ask: null, exchangeTime: null, scanAt: o.scanAt };
  }
  return null;
}

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Reads a stored snapshot (jsonb). Returns null for anything malformed or missing (old rows have none). */
export function parseRef(v: unknown): PriceRef | null {
  let o = v;
  if (typeof o === "string") { try { o = JSON.parse(o); } catch { return null; } }
  if (typeof o !== "object" || o === null) return null;
  const r = o as Record<string, unknown>;
  const last = numOrNull(r.last), scanAt = numOrNull(r.scanAt);
  if (last === null || scanAt === null || !(last > 0)) return null;
  const source = r.source === "ticker_last" || r.source === "forming_candle" || r.source === "last_closed_candle" ? r.source : null;
  if (!source) return null;
  return { source, last, indexPrice: numOrNull(r.indexPrice), bid: numOrNull(r.bid), ask: numOrNull(r.ask), exchangeTime: numOrNull(r.exchangeTime), scanAt };
}

/** Difference of the latest price against the reference price. Positive = latest is above the reference. */
export function priceDiff(reference: number | null, latest: number | null): { abs: number; pct: number } | null {
  if (reference === null || latest === null || !(reference > 0) || !Number.isFinite(latest)) return null;
  return { abs: latest - reference, pct: ((latest - reference) / reference) * 100 };
}

export function signalAgeMinutes(generatedAt: number | null, now: number): number | null {
  return generatedAt === null ? null : Math.max(0, Math.floor((now - generatedAt) / 60_000));
}

export type ValidityKind = "unconfirmed" | "valid" | "expired" | "invalidated" | "watching" | "stale";
export interface Validity { kind: ValidityKind; text: string }

/**
 * Valid / expired / invalidated, derived from the lifecycle without changing it:
 *  - EXPIRED because its validity window simply ended      -> "expired"
 *  - EXPIRED for any other reason (conditions lapsed, early read did not hold, stop or support broken) -> "invalidated"
 *  - CONFIRMED and still inside its window                  -> "valid"
 *  - POTENTIAL                                              -> "unconfirmed" (never shown as a confirmed signal)
 */
export const VALIDITY_STALE_MS = 15 * 60_000;

export function validityState(s: { status: SetupStatus; signalCandleStart: number | null; expireReason: string | null; lastScanAt?: number | null }, now: number, validMs: number): Validity {
  if (s.status === "EXPIRED") {
    return s.expireReason === "the validity window ended"
      ? { kind: "expired", text: "EXPIRED — its validity window ended" }
      : { kind: "invalidated", text: `INVALIDATED — ${s.expireReason ?? "no longer valid"}` };
  }
  if (s.lastScanAt != null && now - s.lastScanAt > VALIDITY_STALE_MS) {
    return { kind: "stale", text: `STALE — not re-checked for ${Math.round((now - s.lastScanAt) / 60_000)} min; do not treat as current` };
  }
  if (s.status === "WATCH") return { kind: "watching", text: "Watching — not a signal yet" };
  if (s.status === "POTENTIAL") return { kind: "unconfirmed", text: "Unconfirmed until the 1H candle closes" };
  if (s.signalCandleStart === null) return { kind: "valid", text: "Valid" };
  const endsAt = s.signalCandleStart + 3_600_000 + validMs;
  return endsAt - now <= 0 ? { kind: "expired", text: "EXPIRED — its validity window ended" } : { kind: "valid", text: "VALID — still inside its validity window" };
}
