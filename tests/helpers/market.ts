import type { Candle } from "@/lib/types";

export const H1 = 3_600_000;
export const H4 = 4 * H1;

/** Deterministic pseudo-random numbers (mulberry32) so tests are reproducible. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Realistic-looking hourly candles: open = previous close, random-walk close with optional drift and an
 * occasional regime of pullbacks, wicks, and noisy volume. `end` must be an hour boundary (end of the last candle).
 */
export function hourly(n: number, end: number, o: { base?: number; drift?: number; vol?: number; seed?: number; cycle?: number } = {}): Candle[] {
  const { base = 100, drift = 0, vol = 0.006, seed = 1, cycle = 0 } = o;
  const r = rng(seed);
  const out: Candle[] = [];
  let prev = base;
  for (let i = 0; i < n; i++) {
    const noise = (r() + r() + r() - 1.5) * 2; // roughly N(0,1)-ish, bounded
    const wave = cycle ? Math.sin((i / cycle) * 2 * Math.PI) * vol * 0.8 : 0;
    const close = prev * (1 + drift + wave + vol * noise);
    const hi = Math.max(prev, close) * (1 + vol * 0.5 * r());
    const lo = Math.min(prev, close) * (1 - vol * 0.5 * r());
    out.push({ start: end - (n - i) * H1, open: prev, high: hi, low: lo, close, volume: 80 + 60 * r(), turnover: 0 });
    prev = close;
  }
  return out;
}

/** Aggregates hourly candles into 4h candles aligned to 4h boundaries (only complete groups). */
export function toFourHour(h1: Candle[]): Candle[] {
  const groups = new Map<number, Candle[]>();
  for (const c of h1) {
    const k = Math.floor(c.start / H4) * H4;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(c);
  }
  const out: Candle[] = [];
  for (const [start, cs] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (cs.length !== 4) continue;
    out.push({ start, open: cs[0].open, high: Math.max(...cs.map((c) => c.high)), low: Math.min(...cs.map((c) => c.low)), close: cs[3].close, volume: cs.reduce((a, c) => a + c.volume, 0), turnover: 0 });
  }
  return out;
}

export const floorHour = (t: number) => Math.floor(t / H1) * H1;
export const floor4h = (t: number) => Math.floor(t / H4) * H4;
