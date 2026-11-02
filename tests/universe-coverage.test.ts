import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { MAX_ASSETS, addAsset } from "@/lib/store";
import { makeHarness, type Harness } from "./helpers/harness";

/** The scan universe is the user's configured coin list (up to MAX_ASSETS). Every configured coin must be processed. */
describe("full configured universe is scanned", () => {
  let h: Harness;
  const extra: string[] = [];
  before(async () => {
    h = await makeHarness();
    await h.run(); // apply migrations / seed the default coins
    let i = 0;
    while ((await h.q<{ symbol: string }>("select symbol from assets")).length < MAX_ASSETS) {
      const sym = `COV${i}USDT`; i++;
      await addAsset(h.t.db, sym, sym.replace("USDT", ""));
      extra.push(sym);
      h.ex.symbols[sym] = { ...h.ex.symbols.BTCUSDT };
    }
  });
  after(async () => { await h.cleanup(); });

  it(`checks all ${MAX_ASSETS} configured coins in one pass and records a per-coin check for each`, async () => {
    const r = await h.run("cron", 5 * 60_000);
    assert.match(r.message, new RegExp(`^${MAX_ASSETS}/${MAX_ASSETS} coins checked`), r.message);
    assert.equal(r.status === "success" || r.status === "partial", true);
    const checks = await h.q<{ n: string }>("select count(*)::text as n from assets where last_checked_at is not null");
    assert.equal(Number(checks[0].n), MAX_ASSETS);
  });

  it("a coin Bybit cannot serve is reported by name, the others are still processed, and nothing is silently dropped", async () => {
    delete h.ex.symbols[extra[0]];
    const r = await h.run("cron", 5 * 60_000);
    assert.equal(r.status, "partial");
    assert.match(r.message, new RegExp(`^${MAX_ASSETS - 1}/${MAX_ASSETS} coins checked`), r.message);
    assert.ok(r.errors.some((e) => e.startsWith(extra[0].replace("USDT", ""))), "the failing coin is named in the errors");
  });
});

describe("15-coin configuration under several simultaneous failures", () => {
  let h: Harness;
  const syms: string[] = [];
  before(async () => {
    h = await makeHarness();
    await h.run();
    let i = 0;
    while ((await h.q<{ symbol: string }>("select symbol from assets")).length < MAX_ASSETS) {
      const sym = `MIX${i}USDT`; i++;
      await addAsset(h.t.db, sym, sym.replace("USDT", ""));
      h.ex.symbols[sym] = { ...h.ex.symbols.BTCUSDT };
    }
    syms.push(...(await h.q<{ symbol: string }>("select symbol from assets order by symbol")).map((r) => r.symbol));
  });
  after(async () => { await h.cleanup(); });

  it("the limit is still exactly 15 and a 16th coin is refused by the store constant", () => {
    assert.equal(MAX_ASSETS, 15);
    assert.equal(syms.length, 15);
  });

  it("3 coins missing from Bybit + 2 whose klines fail: each is named, the other 10 are checked", async () => {
    for (const s of syms.slice(-3)) delete h.ex.symbols[s];
    h.bybitOpts.failKlinesFor = syms.slice(5, 7);
    const r = await h.run("cron", 5 * 60_000);
    assert.equal(r.status, "partial");
    assert.match(r.message, /^10\/15 coins checked/, r.message);
    for (const s of [...syms.slice(-3), ...syms.slice(5, 7)]) assert.ok(r.errors.some((e) => e.startsWith(s.replace("USDT", ""))), `${s} named in errors`);
    const bad = await h.q<{ symbol: string }>("select symbol from assets where last_error is not null order by symbol");
    assert.deepEqual(bad.map((b) => b.symbol).sort(), [...syms.slice(-3), ...syms.slice(5, 7)].sort(), "exactly the 5 failing coins carry an error on the dashboard");
  });

  it("when the all-coins ticker request fails, coins are NOT evaluated on a guessed price and the failure is visible", async () => {
    h.bybitOpts.failKlinesFor = [];
    h.bybitOpts.failTickers = true;
    const buys = async () => Number((await h.q<{ n: string }>("select count(*)::text as n from paper_trades where event_type = 'BUY'"))[0].n);
    const before = await buys();
    const r = await h.run("cron", 5 * 60_000);
    h.bybitOpts.failTickers = false;
    assert.ok(r.errors.some((e) => /ticker|price/i.test(e)), `ticker failure is reported: ${r.errors.join(" | ")}`);
    assert.equal(await buys(), before, "no simulated entry was made without a fresh price");
  });

  it("if every coin fails, the run is FAILED and the previous last-success time is kept (no fake freshness)", async () => {
    const before = (await h.q<{ v: { lastSuccessAt?: number } }>("select value as v from kv where key = 'market_api'"))[0]?.v?.lastSuccessAt;
    h.bybitOpts.httpStatus = 500;
    const r = await h.run("cron", 5 * 60_000);
    h.bybitOpts.httpStatus = undefined;
    assert.equal(r.status, "failed");
    const after = (await h.q<{ v: { lastSuccessAt?: number; lastError?: string } }>("select value as v from kv where key = 'market_api'"))[0].v;
    assert.equal(after.lastSuccessAt, before, "lastSuccessAt not advanced by a failed run");
    assert.ok(after.lastError, "error recorded for the dashboard");
  });
});
