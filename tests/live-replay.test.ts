import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCtx, simulateLive, type LiveOpts, type LiveTrade } from "@/lib/live-replay";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { M5, rng } from "@/lib/setups-backtest";
import type { Candle } from "@/lib/types";

const DAY = 86_400_000, H1 = 3_600_000;
/** Drifting random-walk 5m candles; only a code-path fixture (it says nothing about real markets). */
function walk(seed: number, from: number, to: number): Candle[] {
  const r = rng(seed);
  const g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  const out: Candle[] = [];
  let p = 100, drift = 0, left = 0;
  for (let t = from; t < to; t += M5) {
    if (left-- <= 0) { drift = (r() - 0.5) * 0.0012; left = 200 + Math.floor(r() * 1500); }
    const o = p, c = o * (1 + drift + g() * 0.0018);
    out.push({ start: t, open: o, high: Math.max(o, c) * (1 + Math.abs(g()) * 0.0009), low: Math.min(o, c) * (1 - Math.abs(g()) * 0.0009), close: c, volume: 100 * (0.5 + r()) * (1 + (Math.abs(c - o) / o) * 400), turnover: 0 });
    p = c;
  }
  return out;
}

describe("faithful live replay (src/lib/live-replay.ts)", () => {
  const end = 1_790_000_000_000 - (1_790_000_000_000 % DAY), start = end - 120 * DAY;
  const base: LiveOpts = { trendExit: true, feePct: 0.1, slipPct: 0, startMs: start, endMs: end, maxHoldH: 14 * 24, stopPct: 2, takePct: 4 };
  const ctxs = new Map<number, ReturnType<typeof buildCtx>>();
  const ctxOf = (seed: number) => { let c = ctxs.get(seed); if (!c) { c = buildCtx("TESTUSDT", walk(seed, start - 43 * DAY, end), null, start - 3 * DAY, end, DEFAULT_SETTINGS); ctxs.set(seed, c); } return c; };
  const run = (seed: number, o: Partial<LiveOpts> = {}): LiveTrade[] => simulateLive(ctxOf(seed), { ...base, ...o });
  const seeds = [1, 2, 3, 4, 5, 6];

  it("behaves like the live monitor: one position at a time, entries only just after an hourly close, known exit reasons", () => {
    let total = 0;
    for (const s of seeds) {
      const t = run(s);
      total += t.length;
      for (let i = 0; i < t.length; i++) {
        assert.ok(t[i].exitAt > t[i].entryAt, "exit after entry");
        if (i > 0) assert.ok(t[i].entryAt > t[i - 1].exitAt, "no overlapping positions and no re-entry on the closing scan");
        assert.ok(t[i].entryAt % H1 <= DEFAULT_SETTINGS.entryWindowMinutes * 60_000, "entry within the entry window after the hourly close");
        assert.match(t[i].reason, /^(STOP_LOSS|TAKE_PROFIT|TREND_CHANGE|TIME)$/);
      }
    }
    assert.ok(total >= 1, "fixture produced at least one trade so the checks above are not vacuous");
  });

  it("charges the paper engine's costs: 0.1% fee on the amount spent and on the value sold", () => {
    for (const s of seeds) for (const x of run(s)) {
      const ratio = x.exit / x.entry;
      assert.ok(Math.abs(x.netPct - ((ratio - 1) * 100 - 0.1 - 0.1 * ratio)) < 1e-9, "net P/L arithmetic");
    }
  });

  it("slippage changes only the fills, never which trades happen, and always lowers net P/L", () => {
    for (const s of seeds) {
      const a = run(s), b = run(s, { slipPct: 0.05 });
      assert.deepEqual(b.map((x) => x.entryAt), a.map((x) => x.entryAt));
      b.forEach((x, i) => assert.ok(x.netPct < a[i].netPct));
    }
  });

  it("switching the trend-break exit off removes TREND_CHANGE exits", () => {
    for (const s of seeds) assert.equal(run(s, { trendExit: false }).filter((x) => x.reason === "TREND_CHANGE").length, 0);
  });
});
