import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { balanceAfterClose, balanceAfterOpen, computeClose, entryFee, exitFee, simulatedQuantity, unrealized } from "@/lib/paper";

const near = (a: number, b: number, tol = 1e-8) => assert.ok(Math.abs(a - b) <= tol, `${a} !≈ ${b}`);

describe("paper-trading arithmetic", () => {
  it("quantity = amount / entry price (8 dp)", () => {
    assert.equal(simulatedQuantity(10, 60000), 0.00016667);
    assert.equal(simulatedQuantity(10, 0.5), 20);
    assert.equal(simulatedQuantity(65.5, 100), 0.655);
  });
  it("rejects nonsense inputs", () => {
    for (const [a, p] of [[0, 1], [-5, 1], [10, 0], [10, NaN], [Infinity, 1]]) assert.throws(() => simulatedQuantity(a, p), RangeError);
  });
  it("fees are charged on both sides at the configured rate", () => {
    near(entryFee(10, 0.1), 0.01);
    near(exitFee(0.1, 104, 0.1), 0.0104);
    assert.equal(entryFee(10, 0), 0);
  });
  it("take-profit example: gross, fees and net (hand-computed)", () => {
    const r = computeClose({ amountUsdt: 10, entryPrice: 100, exitPrice: 104, feeRatePct: 0.1 });
    near(r.quantity, 0.1);
    near(r.grossPnl, 0.4);
    near(r.totalFees, 0.0204);
    near(r.netPnl, 0.3796);
    near(r.netPct, 3.796, 1e-4);
  });
  it("stop-loss example: a loss is larger than the price move because of fees", () => {
    const r = computeClose({ amountUsdt: 10, entryPrice: 100, exitPrice: 98, feeRatePct: 0.1 });
    near(r.grossPnl, -0.2);
    near(r.netPnl, -0.2198);
  });
  it("zero-fee case equals gross", () => {
    const r = computeClose({ amountUsdt: 10, entryPrice: 100, exitPrice: 110, feeRatePct: 0 });
    assert.equal(r.netPnl, r.grossPnl);
  });
  it("reuses a stored quantity so the close mirrors the entry exactly", () => {
    const q = simulatedQuantity(10, 61800.5);
    const r = computeClose({ amountUsdt: 10, entryPrice: 61800.5, exitPrice: 64272.52, feeRatePct: 0.1, quantity: q });
    assert.equal(r.quantity, q);
    near(r.grossPnl, q * (64272.52 - 61800.5), 1e-7);
  });
  it("unrealized P/L is the close math at the current price", () => {
    const u = unrealized({ amountUsdt: 10, entryPrice: 100, quantity: 0.1, feeRatePct: 0.1, currentPrice: 102 });
    near(u.grossPnl, 0.2);
    near(u.netPnl, 0.2 - 0.01 - 0.0102);
  });
  it("balance bookkeeping: reserve on open, return amount + net on close", () => {
    const afterOpen = balanceAfterOpen(65.5, 10);
    near(afterOpen, 55.5);
    near(balanceAfterClose(afterOpen, 10, 0.3796), 65.8796);
    near(balanceAfterClose(afterOpen, 10, -0.2198), 65.2802);
  });
  it("cannot open a position larger than the simulated balance", () => {
    assert.throws(() => balanceAfterOpen(5, 10), RangeError);
    assert.doesNotThrow(() => balanceAfterOpen(10, 10));
  });
});
