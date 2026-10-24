import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { analyzeDirection } from "@/lib/directional";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { H1, H4, floor4h, hourly, toFourHour } from "./helpers/market";
import { makeHarness, type Harness } from "./helpers/harness";

/**
 * End to end through the real monitor: BUY/SELL keeps working exactly as before while LONG/SHORT analysis runs beside it.
 */
describe("monitor: BUY/SELL and LONG/SHORT side by side", () => {
  let h: Harness;
  const long = hourly(2400, floor4h(Date.UTC(2026, 9, 20, 12)), { drift: 0.0006, seed: 3, cycle: 30, vol: 0.007 });
  const h4all = toFourHour(long);
  let idx = -1;
  const subjects = () => h.calls.map((c) => String(c.body.subject));

  before(async () => {
    h = await makeHarness();
    for (let i = 1500; i < long.length; i++) {
      const a = analyzeDirection({ h1: long.slice(0, i + 1), h4: h4all.filter((c) => c.start + H4 <= long[i].start + H1), now: long[i].start + H1 + 60_000, settings: DEFAULT_SETTINGS });
      if (a.direction === "LONG") { idx = i; break; }
    }
    assert.ok(idx > 0);
    const now = long[idx].start + H1 + 60_000;
    // The existing five fixture coins keep their BUY-friendly market, re-timed to this moment; ETH gets the realistic series.
    h.setMarket(now, "signal", false);
    h.ex.symbols.ETHUSDT.h1 = long.slice(idx - 219, idx + 1);
    h.ex.symbols.ETHUSDT.h4 = h4all.filter((c) => c.start + H4 <= long[idx].start + H1).slice(-220);
    h.ex.symbols.ETHUSDT.lastPrice = long[idx].close;
    h.ex.now = now;
  });
  after(async () => { await h.cleanup(); });

  it("one run: the BUY/SELL system still opens its paper positions and emails, AND a LONG analysis alert is raised for ETH", async () => {
    const r = await h.run();
    assert.notEqual(r.status, "failed");
    const trades = await h.q<{ symbol: string; event_type: string }>("select symbol, event_type from paper_trades order by id");
    assert.ok(trades.filter((t) => t.event_type === "BUY").length >= 4, "BUY signals for the fixture coins still fire");
    const buyMails = subjects().filter((s) => /BUY signal/.test(s));
    assert.ok(buyMails.length >= 4);
    const longMails = subjects().filter((s) => /LONG analysis · ETH\/USDT/.test(s));
    assert.equal(longMails.length, 1, "exactly one LONG analysis email for ETH");
    const sig = await h.q<{ symbol: string; direction: string; status: string }>("select symbol, direction, status from directional_signals");
    assert.deepEqual(sig.map((s) => [s.symbol, s.direction, s.status]), [["ETHUSDT", "LONG", "open"]]);
    assert.ok(r.actions.some((a) => /ETH: LONG analysis signal/.test(a)));
    assert.equal((await h.q("select 1 from direction_state")).length, 5, "every coin has a stored assessment");
  });

  it("LONG/SHORT never creates paper trades, and running again sends nothing new", async () => {
    const mails = h.calls.length;
    const trades = (await h.q("select 1 from paper_trades")).length;
    await h.run("cron", 120_000);
    await h.run("cron", 120_000);
    assert.equal(h.calls.length, mails, "no duplicate emails");
    assert.equal((await h.q("select 1 from paper_trades")).length, trades);
    assert.equal((await h.q("select 1 from directional_signals")).length, 1);
    assert.equal((await h.q("select 1 from paper_positions where symbol = 'ETHUSDT' and status = 'open'")).length <= 1, true);
  });

  it("turning the analysis off in settings stops new signals but leaves BUY/SELL untouched", async () => {
    await h.setSettings({ directionalEnabled: false });
    await h.q("delete from direction_state");
    const before = (await h.q("select 1 from directional_signals")).length;
    await h.run("cron", 120_000);
    assert.equal((await h.q("select 1 from directional_signals")).length, before);
    await h.setSettings({ directionalEnabled: true });
  });

  it("a failure inside the LONG/SHORT code can never stop BUY/SELL (the run still completes)", async () => {
    await h.q("alter table direction_state rename to direction_state_broken");
    try {
      const r = await h.run("cron", 120_000);
      assert.notEqual(r.status, "failed");
      assert.ok(r.actions.some((a) => /LONG\/SHORT analysis could not run/.test(a)));
    } finally {
      await h.q("alter table direction_state_broken rename to direction_state");
    }
  });
});
