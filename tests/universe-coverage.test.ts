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
