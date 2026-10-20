import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BybitError, assertSymbol, fetchInstrument, fetchKlines, fetchTicker, fetchTickers, parseKlineResponse, parseTickerResponse, sanitizeError } from "@/lib/bybit";
import { H1, NOW, bybitFetch, defaultExchange } from "./helpers/fixtures";

const fast = { sleep: async () => undefined, baseUrls: ["https://api.bybit.com", "https://api.bytick.com"], random: () => 0 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("kline parsing & validation", () => {
  const good = (t: number) => [String(t), "100", "110", "90", "105", "5", "500"];
  it("sorts ascending (Bybit sends newest first) and de-duplicates", () => {
    const out = parseKlineResponse({ retCode: 0, result: { list: [good(3000), good(2000), good(2000), good(1000)] } });
    assert.deepEqual(out.map((c) => c.start), [1000, 2000, 3000]);
    assert.equal(out[0].close, 105);
  });
  it("rejects empty, malformed, non-numeric and inconsistent rows", () => {
    const bad = (list: unknown) => assert.throws(() => parseKlineResponse({ retCode: 0, result: { list } }), BybitError);
    bad([]);
    bad(undefined);
    bad([["1", "100"]]);
    bad([["1", "x", "110", "90", "105", "5", "500"]]);
    bad([["1", "100", "90", "110", "105", "5", "500"]]); // high < low
    bad([["1", "100", "110", "90", "200", "5", "500"]]); // close above high
    bad([["1", "-1", "110", "90", "105", "5", "500"]]);
    bad([["1", "100", "110", "90", "105", "-5", "500"]]);
  });
  it("parses a ticker and converts the 24h change to a percentage", () => {
    const t = parseTickerResponse({ time: 1700000000000, result: { list: [{ symbol: "BTCUSDT", lastPrice: "60000", price24hPcnt: "0.0125", highPrice24h: "61000", lowPrice24h: "59000", volume24h: "100", turnover24h: "6000000" }] } });
    assert.equal(t.lastPrice, 60000);
    assert.ok(Math.abs(t.change24hPct - 1.25) < 1e-9);
    assert.throws(() => parseTickerResponse({ time: 1, result: { list: [{ symbol: "X", lastPrice: "abc" }] } }), BybitError);
    assert.throws(() => parseTickerResponse({ time: 1, result: { list: [] } }), BybitError);
  });
});

describe("symbol safety", () => {
  it("accepts USDT spot pairs only", () => {
    for (const s of ["BTCUSDT", "ETHUSDT", "1INCHUSDT"]) assert.equal(assertSymbol(s), s);
    for (const s of ["BTC", "btcusdt", "BTCUSDT&category=linear", "BTC/USDT", "../x", "", "USDT", "BTCUSDC"]) assert.throws(() => assertSymbol(s), BybitError, s);
  });
  it("a malicious symbol never reaches the network", async () => {
    let called = 0;
    const fetchFn = (async () => { called++; return json({}); }) as typeof fetch;
    await assert.rejects(fetchKlines("BTCUSDT&limit=1;DROP", "60", 100, { ...fast, fetchFn }), BybitError);
    assert.equal(called, 0);
  });
});

describe("HTTP behaviour: retries, backoff, outages", () => {
  const ex = defaultExchange();
  it("fetches klines for the requested symbol and interval", async () => {
    const log: string[] = [];
    const out = await fetchKlines("ETHUSDT", "240", 200, { ...fast, fetchFn: bybitFetch(ex, { log }) });
    assert.ok(out.length >= 220);
    assert.match(log[0], /symbol=ETHUSDT/);
    assert.match(log[0], /interval=240/);
    assert.match(log[0], /category=spot/);
  });
  it("retries transient 5xx errors and then succeeds", async () => {
    const out = await fetchKlines("BTCUSDT", "60", 200, { ...fast, fetchFn: bybitFetch(ex, { failKlines: 2 }) });
    assert.ok(out.length > 0);
  });
  it("gives up after the maximum attempts and reports the kind", async () => {
    const log: string[] = [];
    await assert.rejects(fetchKlines("BTCUSDT", "60", 200, { ...fast, fetchFn: bybitFetch(ex, { failKlines: "always", log }) }), (e: unknown) => e instanceof BybitError && e.kind === "http");
    assert.equal(log.length, 3);
  });
  it("alternates base URLs between attempts", async () => {
    const hosts: string[] = [];
    const fetchFn = (async (u: RequestInfo | URL) => { hosts.push(new URL(String(u)).host); return json({}, 500); }) as typeof fetch;
    await assert.rejects(fetchKlines("BTCUSDT", "60", 100, { ...fast, fetchFn }));
    assert.deepEqual(hosts, ["api.bybit.com", "api.bytick.com", "api.bybit.com"]);
  });
  it("sleeps with exponential backoff between attempts", async () => {
    const waits: number[] = [];
    await assert.rejects(fetchKlines("BTCUSDT", "60", 100, { ...fast, sleep: async (ms) => void waits.push(ms), fetchFn: bybitFetch(ex, { failKlines: "always" }) }));
    assert.deepEqual(waits, [300, 600]);
  });
  it("explains a 403 geo-block", async () => {
    await assert.rejects(fetchTicker("BTCUSDT", { ...fast, fetchFn: bybitFetch(ex, { httpStatus: 403 }) }), (e: unknown) => e instanceof BybitError && e.kind === "blocked" && /region|BYBIT_BASE_URL/i.test(e.message));
  });
  it("treats HTTP 429 and retCode 10006 as rate limiting (retried)", async () => {
    await assert.rejects(fetchTicker("BTCUSDT", { ...fast, fetchFn: bybitFetch(ex, { httpStatus: 429 }) }), (e: unknown) => e instanceof BybitError && e.kind === "rate_limit");
    await assert.rejects(fetchTicker("BTCUSDT", { ...fast, fetchFn: bybitFetch(ex, { badBody: { retCode: 10006, retMsg: "Too many visits" } }) }), (e: unknown) => e instanceof BybitError && e.kind === "rate_limit");
  });
  it("does not retry a definitive 4xx or a non-zero retCode", async () => {
    const log: string[] = [];
    await assert.rejects(fetchTicker("BTCUSDT", { ...fast, fetchFn: bybitFetch(ex, { httpStatus: 404, log }) }), (e: unknown) => e instanceof BybitError && e.kind === "http");
    assert.equal(log.length, 1);
    await assert.rejects(fetchKlines("NOPEUSDT", "60", 100, { ...fast, fetchFn: bybitFetch(ex) }), (e: unknown) => e instanceof BybitError && e.kind === "invalid");
  });
  it("maps timeouts and network failures", async () => {
    const timeout = (async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; }) as typeof fetch;
    const net = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    await assert.rejects(fetchTicker("BTCUSDT", { ...fast, fetchFn: timeout }), (e: unknown) => e instanceof BybitError && e.kind === "timeout");
    await assert.rejects(fetchTicker("BTCUSDT", { ...fast, fetchFn: net }), (e: unknown) => e instanceof BybitError && e.kind === "network");
  });
  it("rejects non-JSON and non-object bodies", async () => {
    const html = (async () => new Response("<html>blocked</html>", { status: 200 })) as typeof fetch;
    await assert.rejects(fetchTicker("BTCUSDT", { ...fast, fetchFn: html }), (e: unknown) => e instanceof BybitError && e.kind === "invalid");
  });
});

describe("all-tickers + instrument lookups", () => {
  it("one request returns only the wanted symbols and flags a missing one", async () => {
    const ex = defaultExchange();
    const log: string[] = [];
    const map = await fetchTickers(["BTCUSDT", "ETHUSDT", "DOGEUSDT"], { ...fast, fetchFn: bybitFetch(ex, { log }) });
    assert.equal(log.length, 1);
    assert.ok(!map.has("ZZZUSDT"));
    assert.equal((map.get("BTCUSDT") as { lastPrice: number }).lastPrice, ex.symbols.BTCUSDT.lastPrice);
    assert.ok(map.get("DOGEUSDT") instanceof BybitError);
  });
  it("one bad ticker entry only invalidates that coin", async () => {
    const body = { retCode: 0, time: NOW, result: { list: [
      { symbol: "BTCUSDT", lastPrice: "60000", price24hPcnt: "0.01", highPrice24h: "61000", lowPrice24h: "59000", volume24h: "1", turnover24h: "1" },
      { symbol: "ETHUSDT", lastPrice: "oops", price24hPcnt: "0.01", highPrice24h: "1", lowPrice24h: "1", volume24h: "1", turnover24h: "1" },
    ] } };
    const map = await fetchTickers(["BTCUSDT", "ETHUSDT"], { ...fast, fetchFn: (async () => json(body)) as typeof fetch });
    assert.ok(!(map.get("BTCUSDT") instanceof BybitError));
    assert.ok(map.get("ETHUSDT") instanceof BybitError);
  });
  it("instrument lookup distinguishes listed / trading / unknown", async () => {
    const ex = defaultExchange();
    ex.listed = { BTCUSDT: { status: "Trading" }, OLDUSDT: { status: "Closed" } };
    const f = bybitFetch(ex);
    assert.equal((await fetchInstrument("BTCUSDT", { ...fast, fetchFn: f }))?.trading, true);
    assert.equal((await fetchInstrument("OLDUSDT", { ...fast, fetchFn: f }))?.trading, false);
    assert.equal(await fetchInstrument("NOPEUSDT", { ...fast, fetchFn: f }), null);
  });
});

describe("error sanitising", () => {
  it("never leaks long tokens", () => {
    assert.ok(!sanitizeError(new Error("failed with key re_abcdefghijklmnopqrstuvwxyz0123456789ABCD")).includes("re_abcdefghijklmnopqrstuvwxyz"));
    assert.equal(sanitizeError("boom"), "Unknown error");
  });
});

void H1;
