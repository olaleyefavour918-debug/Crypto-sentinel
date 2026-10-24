import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GET as cronGet } from "@/app/api/cron/monitor/route";
import { GET as stateGet } from "@/app/api/state/route";
import type { AppState } from "@/components/api";
import AssistantPanel from "@/components/AssistantPanel";
import Coins from "@/components/Coins";
import DirectionalPanel from "@/components/DirectionalPanel";
import PerformancePanel from "@/components/PerformancePanel";
import Dashboard from "@/components/Dashboard";
import EmailPanel from "@/components/EmailPanel";
import Health from "@/components/Health";
import Login from "@/components/Login";
import { Portfolio, TradeHistory } from "@/components/Portfolio";
import SettingsPanel from "@/components/SettingsPanel";
import Signal from "@/components/Signal";
import { SESSION_COOKIE, signSession } from "@/lib/auth";
import { setDb } from "@/lib/db";
import { bybitFetch, NOW } from "./helpers/fixtures";
import { makeHarness, type Harness } from "./helpers/harness";

/**
 * Renders every dashboard component to HTML using the REAL /api/state payload produced by a real monitor run
 * (real Postgres, mocked exchange + email). This proves the API↔UI contract and the wording, but it is a
 * server-side render: it does not execute in a browser (no layout, no charts, no click handling).
 */
const ENV = { ADMIN_PASSWORD: "correct horse battery staple", CRON_SECRET: "0123456789abcdef0123456789abcdef", RESEND_API_KEY: "re_test_key_1234567890abcdef" };
let h: Harness;
let state: AppState;
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");

before(async () => {
  for (const k of [...Object.keys(ENV), "BREVO_API_KEY", "EMAIL_FROM", "RESEND_WEBHOOK_SECRET", "DATABASE_URL", "POSTGRES_URL"]) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, ENV);
  // The test injects its own database; a placeholder makes the config report "database configured" like a real deploy.
  process.env.DATABASE_URL = "postgres://placeholder.invalid/unused";
  mock.timers.enable({ apis: ["Date"], now: NOW });
  h = await makeHarness();
  setDb(h.t.db);
  const emailFn = h.deps().email!.fetchFn!;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    return u.host === "api.resend.com" ? emailFn(input, init) : bybitFetch(h.ex, h.bybitOpts)(input, init);
  }) as typeof fetch;
  const hdr = { "x-forwarded-host": "sentinel.example.com", "x-forwarded-for": "10.9.9.9" };
  await cronGet(new Request("https://sentinel.example.com/api/cron/monitor", { headers: { ...hdr, authorization: `Bearer ${ENV.CRON_SECRET}` } }));
  const r = await stateGet(new Request("https://sentinel.example.com/api/state", { headers: { ...hdr, cookie: `${SESSION_COOKIE}=${encodeURIComponent(signSession(process.env))}` } }));
  state = (await r.json()) as AppState;
});
after(async () => {
  globalThis.fetch = realFetch;
  mock.timers.reset();
  setDb(null);
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await h.cleanup();
});

const noop = () => undefined;

describe("dashboard components render the real API state", () => {
  it("coins panel: the five default coins, with pause / remove / add controls and accessible names", () => {
    const html = renderToStaticMarkup(<Coins assets={state.assets} evaluations={state.evaluations} positions={state.positions} selected="BTCUSDT" now={state.now} onSelect={noop} onChanged={noop} />);
    const t = text(html);
    for (const c of ["BTC", "ETH", "SOL", "XRP", "BNB"]) assert.ok(t.includes(`${c} /USDT`) || t.includes(`${c}/USDT`), `${c} card`);
    assert.equal((html.match(/Position open/g) ?? []).length, 5);
    for (const c of ["BTC", "ETH", "SOL", "XRP", "BNB"]) { assert.ok(html.includes(`aria-label="Pause ${c}"`)); assert.ok(html.includes(`aria-label="Remove ${c}"`)); }
    assert.ok(html.includes('for="add-coin"') && html.includes('id="add-coin"'), "input has an associated label");
    assert.ok(html.includes('aria-pressed="true"'), "selected coin is exposed to assistive tech");
    assert.match(t, /Add coin/);
    assert.match(t, /Up to 15 coins/);
  });

  it("coins panel: empty state, paused state and error text are escaped (no HTML injection)", () => {
    const empty = text(renderToStaticMarkup(<Coins assets={[]} evaluations={[]} positions={[]} selected={null} now={NOW} onSelect={noop} onChanged={noop} />));
    assert.match(empty, /No coins selected/);
    const evil = { ...state.assets[0], enabled: false, lastError: '<img src=x onerror=alert(1)>' };
    const html = renderToStaticMarkup(<Coins assets={[evil]} evaluations={[]} positions={[]} selected={null} now={NOW} onSelect={noop} onChanged={noop} />);
    assert.ok(!html.includes("<img"), "raw markup from the server must never reach the DOM");
    assert.match(html, /Paused/);
    assert.match(html, /Resume/);
  });

  it("signal monitor: passed conditions, indicators, timestamp and the educational disclaimer", () => {
    const ev = state.evaluations.find((e) => e.symbol === "ETHUSDT");
    const t = text(renderToStaticMarkup(<Signal symbol="ETHUSDT" evaluation={ev} lastSignal={state.lastSignals.find((s) => s.symbol === "ETHUSDT")} settings={state.settings} />));
    assert.match(t, /ETH\/USDT/);
    assert.match(t, /BUY conditions met/);
    for (const label of ["EMA20 above EMA50", "RSI14 between 50 and 65", "MACD(12,26,9) histogram positive", "Enough completed candles", "not stale"]) assert.ok(t.includes(label), label);
    assert.match(t, /Indicators used/);
    assert.match(t, /Evaluated 2026-10-18 15:05:00 UTC/);
    assert.match(t, /not advice and not a prediction/);
    assert.match(t, /never places real orders/);
  });

  it("signal monitor: data problems are shown as 'not evaluated', not as a pass or a fail", () => {
    const bad = { ...state.evaluations[0], status: "DATA_INVALID", summary: "No signal possible: market data is missing, incomplete or stale.", indicators: {}, conditions: [{ id: "data_fresh", label: "Market data is current (not stale)", passed: false, evaluated: true, detail: "stale" }, { id: "h1_rsi_range", label: "1h RSI", passed: false, evaluated: false, detail: "Not evaluated" }] };
    const html = renderToStaticMarkup(<Signal symbol="BTCUSDT" evaluation={bad} lastSignal={undefined} settings={state.settings} />);
    assert.match(html, /Data not usable/);
    assert.match(html, /aria-label="not evaluated"/);
    assert.match(text(html), /not shown because the data failed quality checks/);
    assert.match(text(renderToStaticMarkup(<Signal symbol="BTCUSDT" evaluation={undefined} lastSignal={undefined} settings={state.settings} />)), /has not been evaluated yet/);
  });

  it("portfolio: balances, five open simulated positions, fee assumption and the hypothetical-results note", () => {
    const t = text(renderToStaticMarkup(<Portfolio account={state.account} positions={state.positions} assets={state.assets} stats={state.stats} now={state.now} feeRatePct={state.settings.feeRatePct} />));
    assert.match(t, /Starting balance 65\.50 USDT/);
    assert.match(t, /Available 15\.50 USDT/);
    assert.match(t, /In open positions 50\.00 USDT 5 open/);
    assert.match(t, /Simulated · no real funds/);
    assert.match(t, /assumed 0\.1% fee per side/);
    assert.match(t, /not actual exchange fills/);
    assert.ok(!t.includes("stale or missing"), "fresh prices: no stale warning");
    for (const c of ["BTC", "ETH", "SOL", "XRP", "BNB"]) assert.ok(t.includes(` ${c} opened 2026-10-18 15:05 UTC`), `${c} position row`);
  });

  it("portfolio: empty state says monitoring continues", () => {
    const t = text(renderToStaticMarkup(<Portfolio account={state.account} positions={[]} assets={state.assets} stats={{ closedCount: 0, netTotal: 0, wins: 0, bySymbol: [] }} now={state.now} feeRatePct={0.1} />));
    assert.match(t, /No open positions\. The monitor keeps watching/);
  });

  it("trade history: events, price, and the email status wording", () => {
    const html = renderToStaticMarkup(<TradeHistory trades={state.trades} />);
    assert.equal((html.match(/Paper BUY/g) ?? []).length, 5);
    assert.match(text(html), /Accepted by provider/);
    assert.ok(!/Delivered \(confirmed\)/.test(html), "nothing is shown as delivered without provider confirmation");
    assert.match(text(renderToStaticMarkup(<TradeHistory trades={[]} />)), /No simulated trades yet/);
  });

  it("email panel: recipient, honest delivery wording, and a clear message when the provider is missing", () => {
    const ok = text(renderToStaticMarkup(<EmailPanel email={state.email} notifications={state.notifications} onChanged={noop} />));
    assert.match(ok, /olaleyevictor206@gmail\.com/);
    assert.match(ok, /Provider connected · resend/);
    assert.match(ok, /Send test email/);
    assert.match(ok, /you will see “accepted by provider”, not “delivered”/);
    assert.match(ok, /\[Crypto Sentinel\] BUY signal/);
    const missing = renderToStaticMarkup(<EmailPanel email={{ ...state.email, configured: false, provider: null, issue: "No email provider key is set (RESEND_API_KEY or BREVO_API_KEY)." }} notifications={[]} onChanged={noop} />);
    assert.match(text(missing), /Emails cannot be sent yet/);
    assert.match(missing, /<button[^>]*disabled[^>]*>[^<]*Send test email/);
    assert.match(text(missing), /No emails yet/);
  });

  it("settings: every control has a label and values come from the saved settings", () => {
    const html = renderToStaticMarkup(<SettingsPanel settings={state.settings} onSaved={noop} />);
    const t = text(html);
    for (const l of ["Position amount (USDT)", "Downside exit (%)", "Upside exit (%)", "Fee per side (%)", "EMA fast", "RSI minimum", "MACD signal", "ATR period", "Email recipient", "Email me when BUY conditions are met", "Email me when SELL conditions are met"]) assert.ok(t.includes(l), l);
    assert.ok(html.includes('value="olaleyevictor206@gmail.com"'));
    assert.ok(html.includes('value="10"'));
    assert.match(html, /<button[^>]*disabled[^>]*>Save settings/, "Save is disabled until something changes");
    const inputs = (html.match(/<input/g) ?? []).length;
    const labels = (html.match(/<label/g) ?? []).length;
    assert.ok(labels >= inputs, "every input sits inside a <label>");
  });

  it("system health: active monitor, runs table, no open setup steps", () => {
    const t = text(renderToStaticMarkup(<Health state={state} />));
    assert.match(t, /Monitor running/);
    assert.match(t, /Recent monitor runs/);
    assert.match(t, /Connected/);
    assert.ok(!/setup steps? still open/.test(t));
    assert.match(t, /Vercel Hobby.*once per day/);
    assert.match(t, /Authorization: Bearer <CRON_SECRET>/);
  });

  it("system health: a stopped monitor and missing setup are reported plainly", () => {
    const broken = { ...state, monitor: { ...state.monitor, state: "stopped" as const, message: "No monitor run for 45 min." }, config: { ...state.config, cronSecret: false, emailConfigured: false, emailIssue: "No email provider key is set." }, marketApi: { lastError: "timeout: Request to Bybit timed out.", lastSuccessAt: null } };
    const t = text(renderToStaticMarkup(<Health state={broken} />));
    assert.match(t, /Monitor stopped/);
    assert.match(t, /3 setup steps still open/);
    assert.match(t, /Scheduler secret set/);
    assert.match(t, /Email provider connected/);
    assert.match(t, /Request to Bybit timed out/);
    assert.match(t, /no successful fetch yet/);
  });

  it("login and dashboard shells render (the dashboard starts in a loading state, never with invented data)", () => {
    const login = renderToStaticMarkup(<Login onDone={noop} />);
    assert.match(login, /type="password"/);
    assert.match(login, /autoComplete="current-password"/);
    const shell = renderToStaticMarkup(<Dashboard />);
    assert.match(shell, /animate-pulse/);
    assert.ok(!/BTC|\d{2},\d{3}/.test(text(shell)), "no prices before real data has loaded");
  });

  it("LONG/SHORT panel: explains the signal types, shows every coin, honest neutral reasons, costs and limitations", () => {
    const d = state.directional!;
    assert.ok(d, "the real /api/state payload carries the LONG/SHORT summary");
    const t = text(renderToStaticMarkup(<DirectionalPanel assessments={d.assessments} signals={d.signals} assets={state.assets} now={state.now} enabled />));
    assert.match(t, /LONG \/ SHORT analysis/);
    assert.match(t, /What do BUY \/ SELL and LONG \/ SHORT \/ NEUTRAL mean\? \(they are different systems\)/);
    assert.match(t, /A SELL means “exit what I hold”, it is not a short/);
    assert.match(t, /A BUY is not automatically a futures LONG, and a SELL is not automatically a SHORT/);
    assert.match(t, /Analysis, not advice/);
    for (const c of ["BTC", "ETH", "SOL", "XRP", "BNB"]) assert.match(t, new RegExp(`${c}\\s*/USDT`));
    assert.match(t, /Costs & limitations/);
    assert.match(t, /Based on Bybit SPOT candles/);
    assert.match(t, /NEUTRAL|LONG|SHORT/);
  });

  it("LONG/SHORT panel: no assessment yet, switched-off and data-problem states are explicit, never invented", () => {
    const empty = text(renderToStaticMarkup(<DirectionalPanel assessments={[]} signals={[]} assets={state.assets} now={state.now} enabled={false} />));
    assert.match(empty, /Not evaluated yet/);
    assert.match(empty, /No assessment stored yet/);
    assert.match(empty, /switched off in Settings/);
    assert.match(empty, /No LONG or SHORT signal has been raised yet/);
    const bad = state.directional!.assessments.map((r) => ({ ...r, assessment: { ...r.assessment, dataOk: false, dataIssue: "1h data is stale" } }));
    assert.match(text(renderToStaticMarkup(<DirectionalPanel assessments={bad} signals={[]} assets={state.assets} now={state.now} enabled />)), /Not assessed: 1h data is stale/);
  });

  it("performance panel: no resolved signals → no invented numbers, with caveats and back-test disclosure", () => {
    const d = state.directional!;
    const t = text(renderToStaticMarkup(<PerformancePanel stats={d.stats} counts={d.counts} assets={state.assets} />));
    assert.match(t, /LONG \/ SHORT performance & risk/);
    assert.match(t, /Resolved signals 0/);
    assert.match(t, /the simulated fill is the next candle’s open/);
    assert.match(t, /Only 0 resolved signal\(s\): too few/);
    assert.match(t, /Historical back-test \(walk-forward\)/);
    assert.match(t, /no look-ahead/);
    assert.match(t, /Run back-test/);
  });

  it("assistant panel: states it is rule-based, offers suggestions and labels its input", () => {
    const t = text(renderToStaticMarkup(<AssistantPanel selected="ETHUSDT" />));
    assert.match(t, /Assistant \(built-in, rule-based\)/);
    assert.match(t, /no AI service, no guessing/);
    assert.match(t, /What is the difference between BUY and LONG\?/);
    assert.match(renderToStaticMarkup(<AssistantPanel selected={null} />), /aria-label="Ask the assistant"/);
  });

  it("settings: the new LONG/SHORT controls are present and labelled", () => {
    const t = renderToStaticMarkup(<SettingsPanel settings={state.settings} onSaved={() => undefined} />);
    assert.match(text(t), /Run LONG \/ SHORT \/ NEUTRAL analysis/);
    assert.match(text(t), /Email me when a LONG or SHORT setup appears/);
    assert.match(text(t), /Assumed slippage per side/);
    assert.match(text(t), /Minimum reward\/risk/);
  });
});
