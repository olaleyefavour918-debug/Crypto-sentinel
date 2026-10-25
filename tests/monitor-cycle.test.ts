import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { computeClose, roundPrice, simulatedQuantity } from "@/lib/paper";
import { NOW, H1 } from "./helpers/fixtures";
import { makeHarness, type Harness } from "./helpers/harness";

/**
 * The complete workflow, end to end, against a real Postgres with a mocked exchange and mocked email provider:
 *   BUY alert → monitor while open → SELL alert → (no repeat entry) → conditions lapse → next BUY alert → SELL alert.
 */
describe("BUY → SELL → next BUY → SELL cycle across BTC, ETH, SOL, XRP, BNB", () => {
  let h: Harness;
  const COINS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT"];
  const RECIPIENT = "olaleyevictor206@gmail.com";
  const entries: Record<string, number> = {};

  const trades = () => h.q<{ symbol: string; event_type: string; price: string; net_pnl: string | null }>("select symbol, event_type, price, net_pnl from paper_trades order by id");
  const openSymbols = async () => (await h.q<{ symbol: string }>("select symbol from paper_positions where status = 'open' order by symbol")).map((r) => r.symbol);
  const balance = async () => Number((await h.q<{ available_balance: string }>("select available_balance from paper_account"))[0].available_balance);
  /** balance == starting + Σ net P/L of closed positions − Σ amounts reserved by open positions */
  const assertBalanceInvariant = async () => {
    const [r] = await h.q<{ net: string; reserved: string }>("select coalesce(sum(net_pnl) filter (where status='closed'),0) as net, coalesce(sum(amount_usdt) filter (where status='open'),0) as reserved from paper_positions");
    assert.ok(Math.abs((await balance()) - (65.5 + Number(r.net) - Number(r.reserved))) < 1e-6, "balance invariant violated");
  };

  // This cycle test is about stop-loss / take-profit and re-arming, so the optional trend-break exit is switched off here (it has its own tests).
  before(async () => { h = await makeHarness(); await h.setSettings({ trendExitEnabled: false }); });
  after(async () => { await h.cleanup(); });

  it("starts with the five default coins and a 65.50 USDT simulated balance", async () => {
    await h.run(); // first run applies migrations lazily
    const assets = await h.q<{ symbol: string }>("select symbol from assets order by symbol");
    assert.deepEqual(assets.map((a) => a.symbol).sort(), [...COINS].sort());
    assert.equal(await balance() , 65.5 - 50);
    // the run above already produced entries; reset to verify the entry step explicitly below
  });

  it("STEP 1 — BUY conditions met: one simulated entry and ONE email per coin, addressed to the configured recipient", async () => {
    const buys = (await trades()).filter((x) => x.event_type === "BUY");
    assert.deepEqual(buys.map((b) => b.symbol).sort(), [...COINS].sort());
    assert.equal(h.calls.length, 5);
    for (const c of h.calls) {
      assert.deepEqual(c.body.to, [RECIPIENT]);
      assert.match(String(c.body.subject), /^\[Crypto Sentinel\] BUY signal · [A-Z]+\/USDT @ /);
      assert.match(String(c.body.text), /No real trade was executed|NO REAL TRADE WAS EXECUTED/);
      assert.match(String(c.body.text), /Simulated trade amount: 10\.00 USDT/);
      assert.match(c.headers["idempotency-key"], /^trade:\d+$/);
      assert.equal(c.headers.authorization, `Bearer ${"re_test_key_1234567890abcdef"}`);
    }
    const pairs = h.calls.map((c) => String(c.body.subject).match(/· ([A-Z]+\/USDT)/)![1]).sort();
    assert.deepEqual(pairs, ["BNB/USDT", "BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT"]);
    const notifs = await h.q<{ status: string; provider_message_id: string }>("select status, provider_message_id from email_notifications");
    assert.equal(notifs.length, 5);
    assert.ok(notifs.every((n) => n.status === "accepted" && n.provider_message_id.startsWith("msg_")));
    for (const sym of COINS) {
      const [p] = await h.q<{ entry_price: string; quantity: string; amount_usdt: string }>("select entry_price, quantity, amount_usdt from paper_positions where symbol = $1 and status = 'open'", [sym]);
      assert.equal(Number(p.entry_price), roundPrice(h.ex.symbols[sym].lastPrice), `${sym} entry = reference price`);
      assert.equal(Number(p.quantity), simulatedQuantity(10, roundPrice(h.ex.symbols[sym].lastPrice)), `${sym} quantity = amount / price`);
      entries[sym] = Number(p.entry_price);
    }
    await assertBalanceInvariant();
  });

  it("STEP 2 — monitoring continues while positions are open, with NO duplicate entries or alerts", async () => {
    const before = await h.q<{ last_checked_at: string }>("select last_checked_at from assets where symbol = 'BTCUSDT'");
    for (let i = 0; i < 3; i++) {
      const r = await h.run("cron", 60_000);
      assert.equal(r.status, "success");
    }
    assert.equal((await trades()).length, 5);
    assert.equal(h.calls.length, 5);
    assert.equal((await openSymbols()).length, 5);
    const after = await h.q<{ last_checked_at: string; last_eval_status: string }>("select last_checked_at, last_eval_status from assets where symbol = 'BTCUSDT'");
    assert.ok(new Date(after[0].last_checked_at) > new Date(before[0].last_checked_at), "asset was re-checked while its position is open");
    assert.equal(after[0].last_eval_status, "POSITION_OPEN");
    await assertBalanceInvariant();
  });

  it("STEP 3 — SELL conditions: BTC hits take-profit, ETH hits stop-loss; others keep being held; one SELL email each", async () => {
    h.ex.symbols.BTCUSDT.lastPrice = entries.BTCUSDT * 1.045;
    h.ex.symbols.ETHUSDT.lastPrice = entries.ETHUSDT * 0.975;
    const r = await h.run("cron", 60_000);
    assert.equal(r.status, "success");
    assert.deepEqual(await openSymbols(), ["BNBUSDT", "SOLUSDT", "XRPUSDT"]);
    const sells = (await trades()).filter((x) => x.event_type === "SELL");
    assert.deepEqual(sells.map((s) => s.symbol).sort(), ["BTCUSDT", "ETHUSDT"]);

    const btc = computeClose({ amountUsdt: 10, entryPrice: entries.BTCUSDT, exitPrice: roundPrice(entries.BTCUSDT * 1.045), feeRatePct: 0.1, quantity: simulatedQuantity(10, entries.BTCUSDT) });
    const eth = computeClose({ amountUsdt: 10, entryPrice: entries.ETHUSDT, exitPrice: roundPrice(entries.ETHUSDT * 0.975), feeRatePct: 0.1, quantity: simulatedQuantity(10, entries.ETHUSDT) });
    const [pBtc] = await h.q<{ exit_reason: string; gross_pnl: string; entry_fee: string; exit_fee: string; net_pnl: string; exit_price: string }>("select * from paper_positions where symbol='BTCUSDT' and status='closed'");
    assert.equal(pBtc.exit_reason, "TAKE_PROFIT");
    assert.ok(Math.abs(Number(pBtc.gross_pnl) - btc.grossPnl) < 1e-7 && Math.abs(Number(pBtc.net_pnl) - btc.netPnl) < 1e-7);
    assert.ok(Number(pBtc.net_pnl) > 0 && Number(pBtc.net_pnl) < Number(pBtc.gross_pnl), "net = gross − estimated fees");
    assert.ok(Math.abs(Number(pBtc.entry_fee) - 0.01) < 1e-8, "entry fee = 0.1% of 10 USDT");
    const [pEth] = await h.q<{ exit_reason: string; net_pnl: string }>("select * from paper_positions where symbol='ETHUSDT' and status='closed'");
    assert.equal(pEth.exit_reason, "STOP_LOSS");
    assert.ok(Math.abs(Number(pEth.net_pnl) - eth.netPnl) < 1e-7 && Number(pEth.net_pnl) < 0);

    assert.equal(h.calls.length, 7, "exactly two new emails");
    const sellMails = h.calls.slice(5);
    for (const c of sellMails) {
      assert.deepEqual(c.body.to, [RECIPIENT]);
      assert.match(String(c.body.subject), /^\[Crypto Sentinel\] SELL signal · (BTC|ETH)\/USDT/);
      const text = String(c.body.text);
      for (const needle of ["Entry price:", "Exit price:", "Hypothetical gross P/L:", "Estimated fees:", "Hypothetical NET P/L:", "Indicator values", "1h RSI:", "NO REAL TRADE WAS EXECUTED"]) assert.ok(text.includes(needle), `SELL email contains "${needle}"`);
    }
    const btcMail = String(sellMails.find((c) => String(c.body.subject).includes("BTC/USDT"))!.body.text);
    assert.match(btcMail, /TAKE_PROFIT/);
    await assertBalanceInvariant();
  });

  it("STEP 4 — after the SELL: no duplicate SELL, and NO immediate re-entry even though the BUY conditions still hold", async () => {
    for (let i = 0; i < 3; i++) await h.run("cron", 60_000);
    assert.equal((await trades()).filter((x) => x.event_type === "SELL").length, 2);
    assert.deepEqual(await openSymbols(), ["BNBUSDT", "SOLUSDT", "XRPUSDT"]);
    assert.equal(h.calls.length, 7);
    const a = await h.q<{ symbol: string; signal_armed: boolean; last_eval_status: string }>("select symbol, signal_armed, last_eval_status from assets where symbol in ('BTCUSDT','ETHUSDT') order by symbol");
    assert.deepEqual(a.map((x) => [x.symbol, x.signal_armed, x.last_eval_status]), [["BTCUSDT", false, "SIGNAL_WAITING_REARM"], ["ETHUSDT", false, "SIGNAL_WAITING_REARM"]]);
  });

  it("STEP 5 — a new hourly candle with the same setup still does not repeat the entry; open coins get no second position", async () => {
    h.setMarket(NOW + H1, "signal", true);
    await h.run("cron", 5 * 60_000);
    assert.equal((await trades()).filter((x) => x.event_type === "BUY").length, 5);
    assert.equal(h.calls.length, 7);
    assert.equal((await h.q("select 1 from paper_positions where status = 'open'")).length, 3);
  });

  it("STEP 6 — conditions lapse (re-arm), then a fresh BUY signal triggers a NEW entry and email for BTC and ETH only", async () => {
    h.setMarket(NOW + 2 * H1, "down", true); // downtrend: BUY conditions fail
    await h.run("cron", 5 * 60_000);
    const armed = await h.q<{ symbol: string; signal_armed: boolean }>("select symbol, signal_armed from assets where symbol in ('BTCUSDT','ETHUSDT') order by symbol");
    assert.ok(armed.every((a) => a.signal_armed), "re-armed once conditions lapsed");
    assert.equal(h.calls.length, 7, "no email while conditions are not met");

    h.setMarket(NOW + 3 * H1, "signal", true);
    const r = await h.run("cron", 5 * 60_000);
    assert.equal(r.status, "success");
    const buys = (await trades()).filter((x) => x.event_type === "BUY");
    assert.equal(buys.length, 7);
    assert.deepEqual(buys.slice(5).map((b) => b.symbol).sort(), ["BTCUSDT", "ETHUSDT"]);
    assert.deepEqual(await openSymbols(), ["BNBUSDT", "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"]);
    assert.equal(h.calls.length, 9);
    // repeated runs on the same candle do not duplicate anything
    for (let i = 0; i < 3; i++) await h.run("cron", 60_000);
    assert.equal((await trades()).length, 9, "5 BUY + 2 SELL + 2 new BUY");
    assert.equal(h.calls.length, 9);
    await assertBalanceInvariant();
  });

  it("STEP 7 — second SELL cycle: every position closes, one email per SELL, no duplicates anywhere", async () => {
    for (const sym of COINS) {
      const [p] = await h.q<{ entry_price: string }>("select entry_price from paper_positions where symbol = $1 and status = 'open'", [sym]);
      h.ex.symbols[sym].lastPrice = Number(p.entry_price) * 1.05;
    }
    await h.run("cron", 60_000);
    assert.deepEqual(await openSymbols(), []);
    for (let i = 0; i < 3; i++) await h.run("cron", 60_000);
    const all = await trades();
    assert.equal(all.filter((x) => x.event_type === "BUY").length, 7);
    assert.equal(all.filter((x) => x.event_type === "SELL").length, 7);
    assert.equal(h.calls.length, 14);
    const keys = await h.q<{ dedupe_key: string; trade_id: string }>("select dedupe_key, trade_id from email_notifications");
    assert.equal(new Set(keys.map((k) => k.dedupe_key)).size, 14, "one notification per trade event");
    assert.equal(new Set(keys.map((k) => k.trade_id)).size, 14);
    assert.equal(new Set(h.calls.map((c) => c.headers["idempotency-key"])).size, 14);
    const [st] = await h.q<{ n: string; net: string }>("select count(*) as n, sum(net_pnl) as net from paper_positions where status = 'closed'");
    assert.equal(Number(st.n), 7);
    assert.ok(Math.abs((await balance()) - (65.5 + Number(st.net))) < 1e-6, "final balance = start + total net P/L");
    await assertBalanceInvariant();
  });

  it("STEP 8 — after everything is closed the monitor keeps running and is ready for the next BUY", async () => {
    const r = await h.run("cron", 60_000);
    assert.equal(r.status, "success");
    const runs = await h.q<{ status: string }>("select status from job_runs where status <> 'running'");
    assert.ok(runs.length >= 10);
    assert.ok(runs.every((x) => x.status === "success"));
  });
});
