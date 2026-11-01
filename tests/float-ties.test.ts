import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { geq, leq, REL_TOL } from "@/lib/floatcmp";
import { buildZones, findPivots, MAX_CONSTRUCTED_WIDTH_ATR, STRUCTURE } from "@/lib/structure";
import { evaluateBounce, evaluateExitWarning } from "@/lib/setups";
import type { Candle } from "@/lib/types";
import { bounceScenario, exitScenario, toInput, type Scenario } from "./helpers/setupmarket";

const scaleC = (c: Candle, f: number): Candle => ({ ...c, open: c.open * f, high: c.high * f, low: c.low * f, close: c.close * f });
const scaleSc = (s: Scenario, f: number): Scenario => ({ ...s, h1Closed: s.h1Closed.map((c) => scaleC(c, f)), h4Closed: s.h4Closed.map((c) => scaleC(c, f)), forming: s.forming ? scaleC(s.forming, f) : null });
const passed = (e: { conditions: Array<{ id: string; passed: boolean }> }) => e.conditions.filter((c) => c.passed).map((c) => c.id).join(",");
const SCALES = [1, 1000, 0.001, 1e-5, 12345.678];

describe("float-safe comparison helpers", () => {
  it("keep exact semantics for real differences and absorb only floating-point noise", () => {
    assert.equal(geq(2, 2, 100), true);
    assert.equal(geq(1.99, 2, 100), false);
    assert.equal(geq(2 - 4e-16, 2, 1), true, "noise below the tolerance is a tie");
    assert.equal(leq(2 + 4e-16, 2, 1), true);
    assert.equal(leq(2.0001, 2, 1), false);
    assert.ok(REL_TOL < 1e-8, "tolerance must stay far below one exchange tick (>=1e-8 of price)");
  });
});

describe("price-scale invariance of the setup engine (same chart shape at x1, x1000, x0.001, ...)", () => {
  for (const [name, mk] of [["exit warning scenario", () => exitScenario()], ["exit warning without a star", () => exitScenario({ noStar: true })]] as const) {
    it(`${name}: the same conditions pass at every price scale`, () => {
      const base = mk();
      const ref = passed(evaluateExitWarning(toInput(base)));
      for (const f of SCALES) assert.equal(passed(evaluateExitWarning(toInput(scaleSc(base, f)))), ref, `scale ${f}`);
    });
  }
  it("bounce scenario: the same conditions pass at every price scale", () => {
    const base = bounceScenario();
    const ref = passed(evaluateBounce(toInput(base)));
    for (const f of SCALES) assert.equal(passed(evaluateBounce(toInput(scaleSc(base, f)))), ref, `scale ${f}`);
  });
});

describe("exact decimal ties in candle shape are decided the same way at every price scale", () => {
  // A shooting star whose upper wick is EXACTLY twice its body and whose close sits EXACTLY at the 40% line.
  // Built from decimal numbers, then scaled; before the fix the verdict depended on rounding noise at each scale.
  it("wick == 2 x body counts as a shooting star at every scale and body size", () => {
    for (const f of [1, 1000, 0.001, 1e-5, 0.0123, 777.77]) {
      for (const b of [0.3, 0.45, 0.5, 0.7, 1.0]) {
        const base = exitScenario({ noStar: true });
        const h1 = base.h1Closed.map((c) => scaleC(c, f));
        const L = h1[h1.length - 1], pc = h1[h1.length - 2];
        const open = pc.close, body = b * f;
        h1[h1.length - 1] = { ...L, open, close: open - body, high: open + 2 * body, low: open - body - 2 * body };
        const e = evaluateExitWarning(toInput({ ...base, h1Closed: h1, h4Closed: base.h4Closed.map((c) => scaleC(c, f)) }));
        const e4 = e.conditions.find((c) => c.id === "e4_reversal");
        assert.match(String(e4?.detail), /shooting-star/, `scale ${f}, body ${b}: ${e4?.detail}`);
      }
    }
  });
});

describe("zone width guard (structure)", () => {
  it("the 1.5-ATR width limit is dormant by construction: clustering + padding can never exceed it", () => {
    assert.equal(MAX_CONSTRUCTED_WIDTH_ATR, STRUCTURE.clusterAtr + 2 * STRUCTURE.padAtr);
    assert.ok(MAX_CONSTRUCTED_WIDTH_ATR <= STRUCTURE.maxWidthAtr, "if this fails the guard has become live: re-verify its intended behaviour");
    let seed = 7;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let t = 0; t < 300; t++) {
      const atr = 0.5 + rnd() * 5;
      const pivots = Array.from({ length: 1 + Math.floor(rnd() * 30) }, (_, i) => ({ index: i, start: i, price: 100 + rnd() * 40 }));
      for (const z of buildZones(pivots, atr)) assert.ok((z.high - z.low) / atr <= MAX_CONSTRUCTED_WIDTH_ATR + 1e-9, "zone width");
    }
  });
  it("findPivots is unaffected (sanity)", () => {
    assert.deepEqual(findPivots([], 3, 10), { highs: [], lows: [] });
  });
});
