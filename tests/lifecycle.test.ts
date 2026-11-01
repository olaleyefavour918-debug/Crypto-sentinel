import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LIFECYCLE, step, validityText, type Scan, type SetupState } from "@/lib/lifecycle";
import type { SetupEval, StrategyId } from "@/lib/setups";

const H1 = 3_600_000;
const T0 = Date.UTC(2026, 9, 31, 10, 0, 0); // a 1H candle boundary
const ev = (o: Partial<SetupEval> & { candleStart: number }): SetupEval => ({
  strategy: "BOUNCE", dataOk: true, dataIssue: null, conditions: [{ id: "x", label: "x", passed: true, detail: "d", group: "context" }],
  context: false, potential: false, full: false, price: 100, levels: { entry: 100, stop: 98, target: 106, targetBasis: "2R", riskPct: 2, riskReward: 3, netRiskReward: 2.5 },
  reasons: ["r"], variant: null, refs: { zoneLow: 99, zoneHigh: 100.5, atr: 1 }, ...o,
});
const scan = (now: number, closed: SetupEval, preview: SetupEval | null, price = 100): Scan => ({ now, price, closed, preview });
const idle = (cs: number) => ev({ candleStart: cs });
const watch = (cs: number) => ev({ candleStart: cs, context: true });
const pot = (cs: number) => ev({ candleStart: cs, context: true, potential: true });
const full = (cs: number) => ev({ candleStart: cs, context: true, potential: true, full: true });
const S: StrategyId = "BOUNCE";

describe("setup lifecycle: WATCH → POTENTIAL → CONFIRMED → EXPIRED", () => {
  it("nothing happens when there is nothing", () => {
    assert.equal(step(null, "BNBUSDT", S, scan(T0 + 20 * 60_000, idle(T0 - H1), idle(T0))).state, null);
  });
  it("conditions developing = WATCH, silent", () => {
    const r = step(null, "BNBUSDT", S, scan(T0 + 20 * 60_000, watch(T0 - H1), null));
    assert.equal(r.state?.status, "WATCH");
    assert.deepEqual(r.notify, []);
  });
  it("an early read needs TWO consecutive scans before POTENTIAL, and then notifies once", () => {
    const t1 = T0 + 20 * 60_000;
    const a = step(null, "BNBUSDT", S, scan(t1, watch(T0 - H1), pot(T0)));
    assert.equal(a.state?.status, "WATCH");
    assert.deepEqual(a.notify, []);
    const b = step(a.state, "BNBUSDT", S, scan(t1 + 5 * 60_000, watch(T0 - H1), pot(T0)));
    assert.equal(b.state?.status, "POTENTIAL");
    assert.deepEqual(b.notify, ["POTENTIAL"]);
    assert.equal(b.state?.signalCandleStart, T0);
    const c = step(b.state, "BNBUSDT", S, scan(t1 + 10 * 60_000, watch(T0 - H1), pot(T0)));
    assert.equal(c.state?.status, "POTENTIAL");
    assert.deepEqual(c.notify, [], "no repeat notification while it stays POTENTIAL");
  });
  it("a POTENTIAL that holds when the candle closes becomes CONFIRMED (and is counted as converted)", () => {
    let st: SetupState | null = null;
    for (const m of [20, 25]) st = step(st, "BNBUSDT", S, scan(T0 + m * 60_000, watch(T0 - H1), pot(T0))).state;
    assert.equal(st?.status, "POTENTIAL");
    const r = step(st, "BNBUSDT", S, scan(T0 + H1 + 2 * 60_000, full(T0), pot(T0 + H1)));
    assert.equal(r.state?.status, "CONFIRMED");
    assert.equal(r.state?.convertedFromPotential, true);
    assert.deepEqual(r.notify, ["CONFIRMED"]);
  });
  it("a POTENTIAL that does NOT hold at the close expires and is counted as a repaint", () => {
    let st: SetupState | null = null;
    for (const m of [20, 25]) st = step(st, "BNBUSDT", S, scan(T0 + m * 60_000, watch(T0 - H1), pot(T0))).state;
    const r = step(st, "BNBUSDT", S, scan(T0 + H1 + 2 * 60_000, watch(T0), null));
    assert.equal(r.state?.status, "EXPIRED");
    assert.match(r.state?.expireReason ?? "", /did not hold when the candle closed/);
    assert.equal(r.state?.repaints, 1);
    assert.deepEqual(r.notify, []);
  });
  it("an early read that fades while the candle is still open drops back to WATCH (or expires)", () => {
    let st: SetupState | null = null;
    for (const m of [20, 25]) st = step(st, "BNBUSDT", S, scan(T0 + m * 60_000, watch(T0 - H1), pot(T0))).state;
    const back = step(st, "BNBUSDT", S, scan(T0 + 30 * 60_000, watch(T0 - H1), watch(T0)));
    assert.equal(back.state?.status, "WATCH");
    assert.equal(back.events[0].kind, "REGRESSED");
    const gone = step(st, "BNBUSDT", S, scan(T0 + 30 * 60_000, idle(T0 - H1), idle(T0)));
    assert.equal(gone.state?.status, "EXPIRED");
  });
  it("only a CLOSED-candle evaluation can confirm: a preview marked full is ignored", () => {
    const r = step(null, "BNBUSDT", S, scan(T0 + 40 * 60_000, idle(T0 - H1), full(T0)));
    assert.notEqual(r.state?.status, "CONFIRMED");
    assert.deepEqual(r.notify.filter((n) => n === "CONFIRMED"), []);
  });
  it("a fresh CONFIRMED is only raised within 30 minutes of the close (stale news is not alerted)", () => {
    const ok = step(null, "BNBUSDT", S, scan(T0 + 10 * 60_000, full(T0 - H1), null));
    assert.equal(ok.state?.status, "CONFIRMED");
    const late = step(null, "BNBUSDT", S, scan(T0 + 45 * 60_000, full(T0 - H1), null));
    assert.notEqual(late.state?.status, "CONFIRMED");
  });
  it("CONFIRMED expires after its 6-candle validity window and the dashboard text says so", () => {
    const c = step(null, "BNBUSDT", S, scan(T0 + 10 * 60_000, full(T0 - H1), null)).state as SetupState;
    assert.match(validityText(c, T0 + 10 * 60_000), /^Current — valid for about/);
    const mid = step(c, "BNBUSDT", S, scan(T0 + 3 * H1, watch(T0 + 2 * H1), null));
    assert.equal(mid.state?.status, "CONFIRMED");
    const end = step(c, "BNBUSDT", S, scan(T0 + 8 * H1, watch(T0 + 7 * H1), null));
    assert.equal(end.state?.status, "EXPIRED");
    assert.equal(end.state?.expireReason, "the validity window ended");
    assert.match(validityText(end.state as SetupState, T0 + 8 * H1), /^EXPIRED/);
  });
  it("a bounce is invalidated by its stop; then the strategy is quiet on that coin for 6 hours and the same candle is never re-signalled", () => {
    const c = step(null, "BNBUSDT", S, scan(T0 + 10 * 60_000, full(T0 - H1), null)).state as SetupState;
    const stopped = step(c, "BNBUSDT", S, scan(T0 + 20 * 60_000, full(T0 - H1), null, 97.5));
    assert.equal(stopped.state?.status, "EXPIRED");
    assert.equal(stopped.state?.expireReason, "stop level reached");
    const again = step(stopped.state, "BNBUSDT", S, scan(T0 + 25 * 60_000, full(T0 - H1), null, 100));
    assert.equal(again.state, null, "cool-down: no new setup is created");
    const later = step(stopped.state, "BNBUSDT", S, scan(T0 + 7 * H1 + 10 * 60_000, full(T0 + 6 * H1), null, 100));
    assert.equal(later.state?.status, "CONFIRMED", "after the cool-down a genuinely new candle can signal");
  });
  it("a target hit is not a failure and has no cool-down", () => {
    const c = step(null, "BNBUSDT", S, scan(T0 + 10 * 60_000, full(T0 - H1), null)).state as SetupState;
    const hit = step(c, "BNBUSDT", S, scan(T0 + 2 * H1, watch(T0 + H1), null, 107));
    assert.equal(hit.state?.expireReason, "target reached");
    const fresh = step(hit.state, "BNBUSDT", S, scan(T0 + 4 * H1 + 5 * 60_000, full(T0 + 3 * H1), null, 100));
    assert.equal(fresh.state?.status, "CONFIRMED");
  });
  it("an exit warning expires when price breaks above its resistance zone", () => {
    const e = { ...full(T0 - H1), strategy: "EXIT_WARNING" as const, variant: "resistance", levels: null, refs: { zoneLow: 109.5, zoneHigh: 110.5, atr: 1 } };
    const c = step(null, "BNBUSDT", "EXIT_WARNING", scan(T0 + 10 * 60_000, e, null, 109)).state as SetupState;
    assert.equal(c.status, "CONFIRMED");
    const r = step(c, "BNBUSDT", "EXIT_WARNING", scan(T0 + 30 * 60_000, { ...e, full: false }, null, 111));
    assert.equal(r.state?.expireReason, "price moved above the resistance zone");
  });
  it("missing or delayed data never creates or confirms anything", () => {
    const bad = { ...full(T0 - H1), dataOk: false, dataIssue: "delayed" };
    assert.equal(step(null, "BNBUSDT", S, scan(T0 + 10 * 60_000, bad, null)).state, null);
  });
  it("hysteresis constant matches the design (two scans, 30-minute confirm window, 6-candle validity)", () => {
    assert.equal(LIFECYCLE.potentialScans, 2);
    assert.equal(LIFECYCLE.confirmWindowMs, 30 * 60_000);
    assert.equal(LIFECYCLE.validMs, 6 * H1);
  });
});
