import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { buildEarlyEmail, detectEarly, processEarly } from "@/lib/early";
import { ensureSetup } from "@/lib/migrations";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { H1, H4, NOW, downMarket, makeCandles } from "./helpers/fixtures";
import { makeTestDb, type TestDb } from "./helpers/db";

const fl = (t: number, i: number) => Math.floor(t / i) * i;
/** A long slide, then a gentle 6-candle bounce: price reclaims EMA20 with momentum turning up, still early in the move. */
function bounce(now = NOW) {
  const n = 220, turn = n - 6;
  const f = (i: number) => 600 * (i < turn ? 100 - 0.05 * i : 100 - 0.05 * turn + 0.08 * (i - turn + 1));
  const h1 = makeCandles(n, fl(now, H1), H1, f);
  const h4 = makeCandles(n, fl(now, H4), H4, (i) => 600 * (100 - 0.2 * Math.min(i, n - 3) + (i >= n - 3 ? 0.6 * (i - (n - 4)) : 0)));
  return { h1, h4 };
}
const S = DEFAULT_SETTINGS;

describe("early heads-up detection (pure)", () => {
  it("fires on a fresh, still-early turn up, and explains every check", () => {
    const { h1, h4 } = bounce();
    const r = detectEarly({ h1, h4, now: NOW, settings: S });
    assert.equal(r.triggered, true);
    assert.equal(r.checks.length, 7);
    assert.ok(r.checks.every((c) => c.passed));
    assert.equal(r.candleStart, h1[h1.length - 1].start);
  });
  it("stays quiet in a steady downtrend", () => {
    const { h1, h4 } = downMarket();
    assert.equal(detectEarly({ h1, h4, now: NOW, settings: S }).triggered, false);
  });
  it("never fires on stale or missing data", () => {
    const { h1, h4 } = bounce();
    assert.equal(detectEarly({ h1, h4, now: NOW + 5 * H1, settings: S }).triggered, false);
    assert.equal(detectEarly({ h1: h1.slice(-40), h4, now: NOW, settings: S }).triggered, false);
    const gap = h1.filter((_, i) => i !== 200);
    assert.equal(detectEarly({ h1: gap, h4, now: NOW, settings: S }).triggered, false);
  });
  it("the email says plainly that it is early, unconfirmed and opened no trade", () => {
    const { h1, h4 } = bounce();
    const m = buildEarlyEmail({ symbol: "BNBUSDT", result: detectEarly({ h1, h4, now: NOW, settings: S }), evaluatedAt: NOW });
    assert.match(m.subject, /EARLY heads-up \(unconfirmed\)/);
    assert.match(m.text, /UNCONFIRMED/);
    assert.match(m.text, /NOT met yet/);
    assert.match(m.text, /placed no order/);
    assert.match(m.html, /EARLY · UNCONFIRMED/);
  });
});

describe("early heads-up: storage, email, duplicates (database)", () => {
  let t: TestDb;
  before(async () => { t = await makeTestDb(); await ensureSetup(t.db); });
  after(async () => { await t.cleanup(); });
  const { h1, h4 } = bounce();
  const base = { symbol: "BNBUSDT", enabled: true, settings: S, h1Closed: h1, h4Closed: h4, nowMs: NOW, buyHandled: false };
  const count = async (sql: string) => (await t.db.query(sql)).rows.length;

  it("queues exactly one EARLY email and NO paper trade or position", async () => {
    const actions = await processEarly(t.db, base);
    assert.equal(actions.length, 1);
    assert.match(actions[0], /EARLY heads-up \(unconfirmed, no paper trade\)/);
    assert.equal(await count("select 1 from email_notifications where kind = 'EARLY' and status = 'queued'"), 1);
    assert.equal(await count("select 1 from paper_trades"), 0);
    assert.equal(await count("select 1 from paper_positions"), 0);
    assert.equal(await count("select 1 from directional_signals"), 0);
  });
  it("the same candle, or a repeat within the 6h cool-down, sends nothing more", async () => {
    assert.deepEqual(await processEarly(t.db, base), []);
    const later = bounce(NOW + H1);
    assert.deepEqual(await processEarly(t.db, { ...base, h1Closed: later.h1, h4Closed: later.h4, nowMs: NOW + H1 }), []);
    assert.equal(await count("select 1 from email_notifications where kind = 'EARLY'"), 1);
  });
  it("is silent when switched off, when the coin is paused, or when BUY/SELL already handles the coin", async () => {
    await t.db.query("delete from early_alerts"); await t.db.query("delete from email_notifications");
    assert.deepEqual(await processEarly(t.db, { ...base, settings: { ...S, earlyAlertsEnabled: false } }), []);
    assert.deepEqual(await processEarly(t.db, { ...base, enabled: false }), []);
    assert.deepEqual(await processEarly(t.db, { ...base, buyHandled: true }), []);
    assert.equal(await count("select 1 from early_alerts"), 0);
  });
  it("a heads-up that is too old (past the entry window) is not sent", async () => {
    assert.deepEqual(await processEarly(t.db, { ...base, nowMs: NOW + 50 * 60_000 }), []);
  });
});
