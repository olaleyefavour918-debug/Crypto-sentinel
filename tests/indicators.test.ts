import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { atr, ema, macd, rsi } from "@/lib/indicators";
import type { Candle } from "@/lib/types";

const close = (a: number | null, b: number, tol = 1e-9) => assert.ok(a !== null && Math.abs(a - b) <= tol, `expected ${a} ≈ ${b}`);

describe("EMA", () => {
  it("seeds with the SMA and then smooths (hand-computed)", () => {
    // period 3, k = 0.5: seed (1+2+3)/3 = 2; then 4*.5+2*.5 = 3; 5*.5+3*.5 = 4
    assert.deepEqual(ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  });
  it("returns only nulls when there is not enough data", () => {
    assert.deepEqual(ema([1, 2], 3), [null, null]);
  });
  it("is constant for a constant series", () => {
    const out = ema(new Array(30).fill(7), 10);
    assert.ok(out.slice(9).every((v) => v !== null && Math.abs(v - 7) < 1e-12));
  });
  it("rejects invalid periods without throwing or emitting NaN", () => {
    assert.ok(ema([1, 2, 3], 0).every((v) => v === null));
    assert.ok(ema([1, 2, 3], 2.5).every((v) => v === null));
  });
});

describe("RSI (Wilder)", () => {
  it("matches the classic StockCharts worked example (first value ≈ 70.5)", () => {
    const closes = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.614, 46.282, 46.282];
    const out = rsi(closes, 14);
    assert.equal(out.slice(0, 14).every((v) => v === null), true);
    close(out[14], 70.46, 0.15);
  });
  it("is 100 for a strictly rising series, 0 for a strictly falling one and 50 for a flat one", () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    const down = Array.from({ length: 30 }, (_, i) => 100 - i);
    assert.equal(rsi(up, 14)[29], 100);
    assert.equal(rsi(down, 14)[29], 0);
    assert.equal(rsi(new Array(30).fill(5), 14)[29], 50);
  });
  it("matches an independent reference implementation on pseudo-random data", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const closes = Array.from({ length: 120 }, (_, i) => 100 + i * 0.1 + (rnd() - 0.5) * 4);
    const got = rsi(closes, 14);
    // Reference: recompute from scratch for each index using the recursive definition.
    const ref = (end: number) => {
      let g = 0, l = 0;
      for (let i = 1; i <= 14; i++) { const d = closes[i] - closes[i - 1]; d >= 0 ? (g += d) : (l -= d); }
      g /= 14; l /= 14;
      for (let i = 15; i <= end; i++) { const d = closes[i] - closes[i - 1]; g = (g * 13 + Math.max(d, 0)) / 14; l = (l * 13 + Math.max(-d, 0)) / 14; }
      return l === 0 ? 100 : 100 - 100 / (1 + g / l);
    };
    for (const i of [14, 30, 77, 119]) close(got[i], ref(i), 1e-9);
  });
  it("stays within 0..100", () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + 30 * Math.sin(i / 3));
    for (const v of rsi(closes, 14)) if (v !== null) assert.ok(v >= 0 && v <= 100);
  });
});

describe("MACD", () => {
  const closes = Array.from({ length: 120 }, (_, i) => 100 + i * 0.3 + 5 * Math.sin(i / 4));
  const m = macd(closes, 12, 26, 9);
  it("first values appear at the right indexes", () => {
    assert.equal(m.macd[24], null);
    assert.notEqual(m.macd[25], null);
    assert.equal(m.signal[32], null);
    assert.notEqual(m.signal[33], null);
    assert.notEqual(m.hist[33], null);
  });
  it("macd line equals EMA12 − EMA26 and histogram equals macd − signal", () => {
    const e12 = ema(closes, 12), e26 = ema(closes, 26);
    for (const i of [33, 50, 119]) {
      close(m.macd[i], (e12[i] as number) - (e26[i] as number));
      close(m.hist[i], (m.macd[i] as number) - (m.signal[i] as number));
    }
  });
  it("is exactly zero for a constant series", () => {
    const z = macd(new Array(80).fill(10));
    assert.equal(z.macd[79], 0);
    assert.equal(z.hist[79], 0);
  });
  it("refuses fast >= slow", () => {
    assert.ok(macd(closes, 26, 12, 9).macd.every((v) => v === null));
  });
});

describe("ATR (Wilder)", () => {
  const mk = (h: number, l: number, c: number, i: number): Candle => ({ start: i * 3600000, open: c, high: h, low: l, close: c, volume: 1, turnover: 1 });
  const candles = [mk(10, 8, 9, 0), mk(11, 9, 10, 1), mk(12, 9, 11, 2), mk(13, 11, 12, 3)];
  it("matches a hand computation (period 3)", () => {
    // TR = 2, 2, 3, 2 → ATR[2] = 7/3, ATR[3] = (7/3*2 + 2)/3
    const out = atr(candles, 3);
    assert.equal(out[1], null);
    close(out[2], 7 / 3);
    close(out[3], ((7 / 3) * 2 + 2) / 3);
  });
  it("accounts for gaps via the previous close", () => {
    const gap = [mk(10, 9, 9.5, 0), mk(20, 19, 19.5, 1)]; // TR1 = max(1, |20-9.5|, |19-9.5|) = 10.5
    close(atr(gap, 2)[1], (1 + 10.5) / 2);
  });
});
