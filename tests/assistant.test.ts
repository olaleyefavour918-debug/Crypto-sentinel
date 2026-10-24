import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { answerQuestion, SIGNAL_GUIDE, type AssistantContext } from "@/lib/assistant";
import { analyzeDirection, computeStats } from "@/lib/directional";
import type { DirectionRow } from "@/lib/directional-run";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import type { Asset } from "@/lib/store";
import { H1, H4, floor4h, hourly, toFourHour } from "./helpers/market";

const END = floor4h(Date.UTC(2026, 9, 20, 12));
const long = hourly(2400, END, { drift: 0.0006, seed: 3, cycle: 30, vol: 0.007 });
const h4all = toFourHour(long);
const assess = (i: number) => analyzeDirection({ h1: long.slice(0, i + 1), h4: h4all.filter((c) => c.start + H4 <= long[i].start + H1), now: long[i].start + H1 + 60_000, settings: DEFAULT_SETTINGS });
let longIdx = -1, neutralIdx = -1;
for (let i = 1500; i < long.length && (longIdx < 0 || neutralIdx < 0); i++) {
  const d = assess(i).direction;
  if (d === "LONG" && longIdx < 0) longIdx = i;
  if (d === "NEUTRAL" && neutralIdx < 0 && assess(i).dataOk) neutralIdx = i;
}

const asset = (base: string): Asset => ({ symbol: `${base}USDT`, base, enabled: true, signalArmed: true, addedAt: 0, lastCheckedAt: 1_000, lastOkAt: 1_000, lastError: null, lastPrice: 100, lastEvalStatus: "NO_SIGNAL" });
const row = (symbol: string, i: number): DirectionRow => { const a = assess(i); return { symbol, direction: a.direction, candleStart: a.candleStart as number, evaluatedAt: 2_000, price: a.price, assessment: a }; };
const ctx = (over: Partial<AssistantContext> = {}): AssistantContext => ({
  now: 5_000, settings: DEFAULT_SETTINGS, assets: ["BTC", "ETH", "SOL"].map(asset),
  directional: [row("BTCUSDT", longIdx), row("ETHUSDT", neutralIdx)],
  signals: [], stats: computeStats([]), evaluations: [], positions: [], trades: [], ...over,
});

describe("built-in rule-based assistant", () => {
  it("found a LONG and a NEUTRAL moment to talk about", () => { assert.ok(longIdx > 0 && neutralIdx > 0); });

  it("explains the difference between BUY/SELL and LONG/SHORT and never equates them", () => {
    const a = answerQuestion("What is the difference between BUY and LONG?", ctx());
    assert.equal(a.topic, "guide");
    assert.equal(a.answer, SIGNAL_GUIDE);
    assert.match(a.answer, /NOT a short/);
    assert.match(a.answer, /BUY is not automatically a futures LONG/);
    assert.equal(answerQuestion("explain signal types", ctx()).topic, "guide");
  });

  it("explains a LONG using the stored reasons and levels", () => {
    const a = answerQuestion("why is BTC long?", ctx());
    assert.equal(a.topic, "why_long");
    assert.match(a.answer, /BTC is currently LONG/);
    assert.match(a.answer, /4h trend confirms/);
    assert.match(a.answer, /Reference levels: entry .* stop .* target .* reward\/risk/);
  });

  it("explains NEUTRAL honestly, including what failed, and corrects a wrong premise", () => {
    const n = answerQuestion("why is ETH neutral?", ctx());
    assert.equal(n.topic, "why_neutral");
    assert.match(n.answer, /ETH is NEUTRAL right now/);
    assert.match(n.answer, /No signal is forced/);
    const wrong = answerQuestion("why is ETH long?", ctx());
    assert.match(wrong.answer, /You asked about LONG, but ETH currently is not LONG/);
  });

  it("lists what would invalidate an active setup, and says there is nothing to invalidate when NEUTRAL", () => {
    const a = answerQuestion("what would invalidate BTC?", ctx());
    assert.equal(a.topic, "invalidation");
    assert.match(a.answer, /BTC LONG setup would be invalidated if/);
    assert.match(a.answer, /stop reference/);
    const b = answerQuestion("what would invalidate ETH?", ctx());
    assert.match(b.answer, /no active setup to invalidate/);
  });

  it("gives entry/stop/target only when a setup exists", () => {
    assert.match(answerQuestion("stop loss and take profit for BTC", ctx()).answer, /entry reference .* stop .* target .* reward\/risk/);
    assert.match(answerQuestion("what is the target for ETH", ctx()).answer, /ETH is NEUTRAL, so there are no entry\/stop\/target levels/);
  });

  it("acknowledges missing information instead of inventing it", () => {
    const a = answerQuestion("why is SOL short?", ctx());
    assert.match(a.answer, /no assessment has been stored yet/i);
    assert.ok(a.missing.some((m) => /SOL/.test(m)));
    const none = answerQuestion("how has it performed?", ctx());
    assert.equal(none.topic, "performance");
    assert.match(none.answer, /No LONG\/SHORT signals have been resolved yet/);
    assert.match(none.answer, /I won't estimate results/);
    const empty = answerQuestion("what is the weather in Lagos", ctx());
    assert.equal(empty.topic, "unknown");
    assert.match(empty.answer, /can't answer that from the data I have/);
    assert.match(empty.answer, /not an AI model/);
  });

  it("reports performance with sample-size and cost caveats when results exist", () => {
    const trades = Array.from({ length: 4 }, (_, k) => ({ symbol: "BTCUSDT", direction: "LONG" as const, status: (k % 2 ? "sl" : "tp") as "sl" | "tp", exitAt: k, netPct: k % 2 ? -1 : 2, grossPct: k % 2 ? -0.7 : 2.3, rMultiple: k % 2 ? -0.7 : 1.4, ambiguous: false }));
    const a = answerQuestion("show win rate and drawdown", ctx({ stats: computeStats(trades) }));
    assert.match(a.answer, /4 resolved signal\(s\): 2 winning, 2 not winning \(50% win rate\)/);
    assert.match(a.answer, /Maximum drawdown/);
    assert.match(a.answer, /Only 4 resolved signal/);
    assert.match(a.answer, /fees and slippage/);
  });

  it("explains BUY from the stored conditions, and SELL from the open position or the lack of one", () => {
    const conditions = [{ id: "a", label: "1h EMA fast above slow", passed: true, evaluated: true, detail: "ok" }, { id: "b", label: "1h RSI in range", passed: false, evaluated: true, detail: "RSI 71" }];
    const ev = [{ symbol: "BTCUSDT", evaluatedAt: 4_000, h1CandleStart: 0, status: "NO_SIGNAL", conditions, indicators: {}, summary: "" }];
    const buy = answerQuestion("why no buy for BTC?", ctx({ evaluations: ev }));
    assert.equal(buy.topic, "why_buy");
    assert.match(buy.answer, /✓ 1h EMA fast above slow/);
    assert.match(buy.answer, /✗ 1h RSI in range — RSI 71/);
    assert.match(buy.answer, /Not met: 1h RSI in range/);
    assert.match(answerQuestion("why sell ETH?", ctx()).answer, /nothing to SELL right now/);
  });

  it("explains costs and limitations from the real settings", () => {
    const a = answerQuestion("what about fees and slippage and limitations?", ctx());
    assert.equal(a.topic, "limits");
    assert.match(a.answer, /fees 0\.1% per side and slippage 0\.05% per side/);
    assert.match(a.answer, /SPOT candles/);
  });

  it("never throws on odd input and caps long questions", () => {
    for (const q of ["", "   ", "?", "a".repeat(5000), "<script>alert(1)</script>", "BTCUSDT"]) {
      const a = answerQuestion(q, ctx());
      assert.equal(typeof a.answer, "string");
      assert.ok(a.answer.length > 0);
    }
  });
});
