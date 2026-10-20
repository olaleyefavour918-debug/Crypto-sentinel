import type { Candle } from "./types";

/**
 * Technical indicators. All functions are pure, return an array the same length as the input,
 * and emit `null` until enough data exists for a valid value. They never emit NaN.
 */

export type Series = Array<number | null>;

/** Exponential moving average, seeded with the simple average of the first `period` values. */
export function ema(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (!Number.isInteger(period) || period < 1 || values.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Relative Strength Index using Wilder's smoothing (the standard, TradingView-compatible variant). */
export function rsi(closes: number[], period = 14): Series {
  const out: Series = new Array(closes.length).fill(null);
  if (!Number.isInteger(period) || period < 1 || closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = rsiValue(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = rsiValue(avgGain, avgLoss);
  }
  return out;
}

function rsiValue(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdResult {
  macd: Series;
  signal: Series;
  hist: Series;
}

/** MACD line = EMA(fast) − EMA(slow); signal = EMA(signalPeriod) of the MACD line; hist = macd − signal. */
export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const n = closes.length;
  const macdLine: Series = new Array(n).fill(null);
  const signal: Series = new Array(n).fill(null);
  const hist: Series = new Array(n).fill(null);
  if (fast >= slow) return { macd: macdLine, signal, hist };
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const firstIdx = slow - 1;
  for (let i = firstIdx; i < n; i++) {
    const a = f[i];
    const b = s[i];
    if (a !== null && b !== null) macdLine[i] = a - b;
  }
  const compact: number[] = [];
  for (let i = firstIdx; i < n; i++) compact.push(macdLine[i] as number);
  const sigCompact = ema(compact, signalPeriod);
  for (let j = 0; j < sigCompact.length; j++) {
    const v = sigCompact[j];
    if (v !== null) {
      const i = firstIdx + j;
      signal[i] = v;
      hist[i] = (macdLine[i] as number) - v;
    }
  }
  return { macd: macdLine, signal, hist };
}

/** Average True Range using Wilder's smoothing; first TR is high − low. */
export function atr(candles: Candle[], period = 14): Series {
  const n = candles.length;
  const out: Series = new Array(n).fill(null);
  if (!Number.isInteger(period) || period < 1 || n < period) return out;
  const tr: number[] = new Array(n);
  tr[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const pc = candles[i - 1].close;
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  }
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < n; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}
