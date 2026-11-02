import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareCandles } from "../scripts/verify-bybit-native";
import type { Candle } from "@/lib/types";

const H = 3_600_000;
const mk = (i: number, close: number, vol = 100): Candle => ({ start: i * H, open: close - 1, high: close + 2, low: close - 2, close, volume: vol, turnover: 0 });

describe("native-vs-independent candle comparison logic", () => {
  const ind = [100, 101, 102, 103].map((p, i) => mk(i, p));
  it("identical candles: nothing differs", () => {
    const d = compareCandles(ind.map((c) => ({ ...c })), ind);
    assert.equal(d.compared, 4);
    assert.equal(d.mismatches.length, 0);
    assert.equal(d.volumeRatioMedian, 1);
  });
  it("detects a price mismatch, a missing independent candle, a duplicate and wrong ordering", () => {
    const native = [mk(0, 100), mk(1, 101.5), mk(1, 101), mk(2, 102), mk(5, 110)];
    const d = compareCandles(native, ind);
    assert.ok(d.mismatches.some((m) => m.start === H && m.field === "close"), "1.5% close mismatch found");
    assert.deepEqual(d.onlyNative, [5 * H]);
    assert.deepEqual(d.onlyIndependent, [3 * H]);
    assert.equal(d.duplicatesNative, 1);
    assert.equal(compareCandles([mk(2, 102), mk(1, 101)], ind).unsortedNative, true);
  });
  it("reports volume ratio so a different-exchange series is visible", () => {
    const d = compareCandles(ind.map((c) => ({ ...c, volume: 50 })), ind);
    assert.equal(d.volumeRatioMedian, 0.5);
  });
});
