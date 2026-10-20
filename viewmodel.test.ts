import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Account, Asset, Position, TradeEvent } from "@/lib/store";
import { buildMarkers, evalBadge, monitorBadge, notificationLabel, portfolioView, PRICE_MAX_AGE_MS, setupChecklist } from "@/lib/viewmodel";
import { H1, H4, NOW } from "./helpers/fixtures";

const acct: Account = { startingBalance: 65.5, availableBalance: 55.5 };
const pos = (o: Partial<Position> = {}): Position => ({
  id: 1, symbol: "BTCUSDT", status: "open", entryCandleStart: NOW - H1, openedAt: NOW, entryPrice: 100, amountUsdt: 10, quantity: 0.1, feeRatePct: 0.1,
  stopLossPct: 2, takeProfitPct: 4, trendExitEnabled: false, entryReason: "x", entryIndicators: {}, closedAt: null, exitPrice: null, exitReason: null,
  grossPnl: null, entryFee: null, exitFee: null, netPnl: null, ...o,
});
const asset = (o: Partial<Asset> = {}): Asset => ({ symbol: "BTCUSDT", base: "BTC", enabled: true, signalArmed: true, addedAt: NOW, lastCheckedAt: NOW, lastOkAt: NOW, lastError: null, lastPrice: 104, lastEvalStatus: "SIGNAL", ...o });
const trade = (o: Partial<TradeEvent>): TradeEvent => ({ id: 1, symbol: "BTCUSDT", positionId: 1, type: "BUY", occurredAt: NOW, price: 100, amountUsdt: 10, quantity: 0.1, reason: "", grossPnl: null, entryFee: null, exitFee: null, netPnl: null, notificationStatus: null, notificationError: null, ...o });

describe("notification wording is honest", () => {
  it("'accepted' is never presented as 'delivered'", () => {
    const a = notificationLabel("accepted");
    assert.equal(a.tone, "warn");
    assert.ok(!/delivered/i.test(a.label));
    assert.match(a.explain, /NOT proof/);
    assert.match(notificationLabel("delivered").label, /confirmed/i);
  });
  it("covers every status the database can hold", () => {
    for (const s of ["queued", "sending", "accepted", "delivered", "bounced", "failed", "skipped"]) assert.ok(notificationLabel(s).label.length > 0);
    assert.equal(notificationLabel("failed").tone, "bad");
    assert.equal(notificationLabel("bounced").tone, "bad");
  });
});

describe("status badges never overstate", () => {
  it("only an actually-running monitor is green", () => {
    assert.equal(monitorBadge("active").tone, "good");
    for (const s of ["never_run", "slow", "failing", "stopped"] as const) assert.notEqual(monitorBadge(s).tone, "good");
    assert.equal(monitorBadge("stopped").tone, "bad");
    assert.equal(monitorBadge("never_run").label, "Not started");
  });
  it("evaluation badges", () => {
    assert.equal(evalBadge("SIGNAL").label, "BUY conditions met");
    assert.equal(evalBadge("DATA_INVALID").tone, "warn");
    assert.equal(evalBadge(null).label, "Not evaluated yet");
  });
});

describe("chart markers", () => {
  const times1h = [NOW - 3 * H1, NOW - 2 * H1, NOW - H1, NOW].map((t) => Math.floor(t / 1000 / 3600) * 3600);
  it("places a simulated event on the candle it happened in, per timeframe, for the right coin only", () => {
    const t = [
      trade({ occurredAt: NOW - 2 * H1 + 17 * 60_000, type: "BUY" }),
      trade({ id: 2, occurredAt: NOW - H1 + 5 * 60_000, type: "SELL" }),
      trade({ id: 3, symbol: "ETHUSDT", occurredAt: NOW - H1 }),
      trade({ id: 4, occurredAt: NOW - 40 * H1 }),
    ];
    const m = buildMarkers(t, "BTCUSDT", times1h, 3600);
    assert.deepEqual(m.map((x) => [x.kind, x.time]), [["BUY", times1h[1]], ["SELL", times1h[2]]]);
    const times4h = [Math.floor((NOW - H4) / 1000 / 14400) * 14400, Math.floor(NOW / 1000 / 14400) * 14400];
    assert.equal(buildMarkers([trade({ occurredAt: NOW })], "BTCUSDT", times4h, 14400)[0].time, times4h[1]);
  });
  it("returns nothing when there are no candles", () => assert.deepEqual(buildMarkers([trade({})], "BTCUSDT", [], 3600), []));
});

describe("portfolio view", () => {
  it("computes unrealized P/L net of the estimated exit fee from a fresh price", () => {
    const v = portfolioView(acct, [pos()], [asset({ lastPrice: 104 })], 0, NOW);
    const r = v.rows[0];
    // qty 0.1 × (104 − 100) = 0.4 gross; entry fee 0.01 + exit fee 0.1×104×0.1% = 0.0104 → net 0.3796
    assert.ok(Math.abs((r.unrealizedGross ?? 0) - 0.4) < 1e-9);
    assert.ok(Math.abs((r.unrealizedNet ?? 0) - 0.3796) < 1e-9);
    assert.equal(v.reserved, 10);
    assert.ok(Math.abs(v.equity - (55.5 + 10 + 0.3796)) < 1e-9);
    assert.equal(v.stalePrices, false);
  });
  it("hides unrealized P/L when the price is stale or missing instead of guessing", () => {
    const stale = portfolioView(acct, [pos()], [asset({ lastOkAt: NOW - PRICE_MAX_AGE_MS - 1 })], 0, NOW);
    assert.equal(stale.rows[0].unrealizedNet, null);
    assert.equal(stale.stalePrices, true);
    assert.equal(stale.equity, 65.5, "equity falls back to cash + reserved");
    const missing = portfolioView(acct, [pos()], [], 0, NOW);
    assert.equal(missing.rows[0].unrealizedNet, null);
    const noPrice = portfolioView(acct, [pos()], [asset({ lastPrice: null })], 0, NOW);
    assert.equal(noPrice.rows[0].unrealizedNet, null);
  });
  it("sums several coins and carries realized P/L", () => {
    const v = portfolioView({ startingBalance: 65.5, availableBalance: 45.5 }, [pos(), pos({ id: 2, symbol: "ETHUSDT", entryPrice: 50, quantity: 0.2 })], [asset({ lastPrice: 100 }), asset({ symbol: "ETHUSDT", base: "ETH", lastPrice: 49 })], 1.25, NOW);
    assert.equal(v.rows.length, 2);
    assert.equal(v.reserved, 20);
    assert.equal(v.realizedNet, 1.25);
    assert.ok(v.rows[0].unrealizedNet! < 0 && v.rows[0].unrealizedNet! > -0.03, "flat price still shows the two fees as a small loss");
    assert.ok(v.rows[1].unrealizedNet! < 0);
  });
});

describe("setup checklist", () => {
  const cfg = { database: true, adminPassword: true, cronSecret: true, emailConfigured: true, emailIssue: null };
  it("is all done only when everything is configured AND the monitor is actually receiving runs", () => {
    assert.ok(setupChecklist(cfg, "active").every((s) => s.done));
    assert.equal(setupChecklist(cfg, "never_run").find((s) => s.id === "monitor")!.done, false);
    assert.equal(setupChecklist(cfg, "stopped").find((s) => s.id === "monitor")!.done, false);
  });
  it("explains what is missing in plain language", () => {
    const s = setupChecklist({ database: false, adminPassword: false, cronSecret: false, emailConfigured: false, emailIssue: "No email provider key is set." }, null);
    assert.equal(s.filter((x) => !x.done).length, 5);
    assert.match(s.find((x) => x.id === "database")!.detail, /Neon/);
    assert.match(s.find((x) => x.id === "monitor")!.detail, /once a day/);
    assert.match(s.find((x) => x.id === "email")!.detail, /No email provider/);
  });
});
