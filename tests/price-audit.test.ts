import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { delayedNotice, DELAYED_ALERT_MS } from "@/lib/email";
import { buildPriceRef, parseRef, priceDiff, signalAgeMinutes, validityState } from "@/lib/priceaudit";
import { fmtLocal } from "@/lib/time";
import type { Ticker24h } from "@/lib/types";
import { makeHarness, type Harness } from "./helpers/harness";

const tk = (o: Partial<Ticker24h> = {}): Ticker24h => ({ symbol: "SOLUSDT", lastPrice: 150.25, change24hPct: 1, high24h: 160, low24h: 140, volume24h: 1, turnover24h: 1, serverTime: 1_700_000_000_000, indexPrice: 150.2, bid: 150.24, ask: 150.26, ...o });

describe("price reference", () => {
  it("a live ticker becomes a ticker_last reference with index, bid/ask and Bybit's own timestamp", () => {
    const r = buildPriceRef({ ticker: tk(), fallbackPrice: 99, fallbackSource: "last_closed_candle", scanAt: 1_700_000_001_000 })!;
    assert.equal(r.source, "ticker_last");
    assert.equal(r.last, 150.25);
    assert.equal(r.indexPrice, 150.2);
    assert.equal(r.exchangeTime, 1_700_000_000_000);
  });
  it("without a ticker the fallback is recorded as such, never passed off as a live price", () => {
    const r = buildPriceRef({ ticker: null, fallbackPrice: 99, fallbackSource: "forming_candle", scanAt: 5 })!;
    assert.equal(r.source, "forming_candle");
    assert.equal(r.exchangeTime, null);
    assert.equal(buildPriceRef({ ticker: null, fallbackPrice: null, fallbackSource: "last_closed_candle", scanAt: 5 }), null);
  });
  it("round-trips through JSON and rejects malformed stored values", () => {
    const r = buildPriceRef({ ticker: tk(), fallbackPrice: null, fallbackSource: "last_closed_candle", scanAt: 7 })!;
    assert.deepEqual(parseRef(JSON.stringify(r)), r);
    assert.deepEqual(parseRef(r), r);
    for (const bad of [null, undefined, "x", "{}", { last: -1, scanAt: 1, source: "ticker_last" }, { last: 1, scanAt: 1, source: "binance" }]) assert.equal(parseRef(bad), null);
  });
  it("difference and age are computed against the untouched reference", () => {
    const d = priceDiff(100, 101.5)!;
    assert.ok(Math.abs(d.abs - 1.5) < 1e-9 && Math.abs(d.pct - 1.5) < 1e-9);
    assert.equal(priceDiff(null, 5), null);
    assert.equal(signalAgeMinutes(0, 5 * 60_000 + 59_000), 5);
    assert.equal(signalAgeMinutes(10, 0), 0);
  });
});

describe("validity states", () => {
  const base = { signalCandleStart: 0, expireReason: null as string | null };
  const H = 3_600_000, VALID = 2 * H;
  it("valid inside the window, expired after it", () => {
    assert.equal(validityState({ ...base, status: "CONFIRMED", lastScanAt: H + 1000 }, H + 5000, VALID).kind, "valid");
    assert.equal(validityState({ ...base, status: "CONFIRMED", lastScanAt: 4 * H }, 4 * H, VALID).kind, "expired");
  });
  it("expired for the window vs invalidated for any other reason", () => {
    assert.equal(validityState({ ...base, status: "EXPIRED", expireReason: "the validity window ended" }, 0, VALID).kind, "expired");
    assert.equal(validityState({ ...base, status: "EXPIRED", expireReason: "the conditions are no longer present" }, 0, VALID).kind, "invalidated");
  });
  it("a setup not re-checked for over 15 minutes is STALE, never valid", () => {
    const s = validityState({ ...base, status: "CONFIRMED", lastScanAt: H + 1000 }, H + 1000 + 16 * 60_000, VALID);
    assert.equal(s.kind, "stale");
    assert.match(s.text, /STALE/);
    assert.equal(validityState({ ...base, status: "POTENTIAL", lastScanAt: H }, H + 16 * 60_000, VALID).kind, "stale");
    assert.equal(validityState({ ...base, status: "POTENTIAL", lastScanAt: H }, H + 14 * 60_000, VALID).kind, "unconfirmed");
  });
});

describe("delayed alerts are never presented as fresh", () => {
  it("no notice within 15 minutes; a clear DELAYED notice with the generation time after", () => {
    assert.equal(delayedNotice(0, DELAYED_ALERT_MS), null);
    const n = delayedNotice(Date.UTC(2026, 10, 3, 9, 0, 0), Date.UTC(2026, 10, 3, 9, 40, 0))!;
    assert.equal(n.subjectPrefix, "[DELAYED] ");
    assert.match(n.text, /2026-11-03 09:00:00 UTC/);
    assert.match(n.text, /40 minutes/);
    assert.match(n.text, /not a current signal/);
  });
  it("local time is shown with a zone name while UTC stays the baseline", () => {
    assert.match(fmtLocal(Date.UTC(2026, 10, 3, 9, 0, 0), "Africa/Lagos"), /10:00:00/);
    assert.equal(fmtLocal(null), "—");
  });
});

describe("Bybit is the only market-data source", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(p) ? [p] : []; });
  it("no live-engine source references Binance endpoints or data", () => {
    for (const f of walk("src")) {
      if (f.endsWith("assistant.ts")) continue; // chat alias map only ("binance: BNB")
      assert.doesNotMatch(readFileSync(f, "utf8"), /binance\.com|api\.binance|data-api\.binance|binance.*klines/i, f);
    }
  });
  it("the Bybit client requests only spot kline/tickers on its own hosts, with native 60 and 240 intervals", () => {
    const src = readFileSync("src/lib/bybit.ts", "utf8");
    assert.match(src, /api\.bybit\.com/);
    assert.match(src, /category=\$\{CATEGORY\}/);
    assert.match(readFileSync("src/lib/types.ts", "utf8"), /"60"/);
    assert.match(readFileSync("src/lib/types.ts", "utf8"), /"240"/);
  });
});

describe("trade audit trail in the database", () => {
  let h: Harness;
  before(async () => { h = await makeHarness(); });
  after(async () => { await h.cleanup(); });
  it("every simulated BUY stores the Bybit price reference and the email shows it with the signal time", async () => {
    await h.run();
    const rows = await h.q<{ ref: { source: string; last: number } | null; price: string }>("select ref, price from paper_trades where event_type = 'BUY'");
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.equal(r.ref?.source, "ticker_last");
      assert.ok(Math.abs(Number(r.ref!.last) - Number(r.price)) < 1e-6, "reference equals the traded price, not a later one");
    }
    assert.ok(h.calls.length > 0);
    for (const c of h.calls) assert.match(String(c.body.text), /Signal generated|generated/i);
  });
});

import { fmtWat, clockWatUtc } from "@/lib/time";
import { fmtPrice } from "@/lib/format";
import { tradePushPayload } from "@/lib/webpush";
describe("Nigeria time and tiny prices in alerts", () => {
  it("WAT is UTC+1 and the push shows both clocks", () => {
    const t = Date.UTC(2026, 10, 4, 8, 21, 23);
    assert.equal(fmtWat(t), "2026-11-04 09:21:23 WAT");
    assert.equal(clockWatUtc(t), "09:21:23 WAT (08:21:23 UTC)");
    const p = tradePushPayload({ symbol: "PEPEUSDT", type: "SELL", price: 0.000005123, netPnl: -0.1, at: t });
    assert.match(p.body, /09:21:23 WAT \(08:21:23 UTC\)/);
    assert.match(p.body, /0\.000005123/);
  });
  it("small prices keep their significant digits; normal prices are unchanged", () => {
    assert.equal(fmtPrice(0.000005123), "0.000005123");
    assert.equal(fmtPrice(0.6175923), "0.617592");
    assert.equal(fmtPrice(61759.237), "61,759.24");
  });
});
