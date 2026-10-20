"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { baseOf, fmtPct, fmtPrice, fmtUsdt } from "@/lib/format";
import { ageLabel, fmtUtc } from "@/lib/time";
import { buildMarkers, monitorBadge, setupChecklist } from "@/lib/viewmodel";
import { api, errorMessage, type AppState, type MarketView } from "./api";
import Chart from "./Chart";
import Coins from "./Coins";
import EmailPanel from "./EmailPanel";
import Health from "./Health";
import Login from "./Login";
import { Portfolio, TradeHistory } from "./Portfolio";
import SettingsPanel from "./SettingsPanel";
import Signal from "./Signal";
import { Btn, Card, Notice, Pill, Skeleton, Stat } from "./ui";

type Gate = "loading" | "login" | "setup" | "error" | "ready";
const STATE_POLL_MS = 30_000;
const SEL_KEY = "cs.selected";

export default function Dashboard() {
  const [gate, setGate] = useState<Gate>("loading");
  const [state, setState] = useState<AppState | null>(null);
  const [gateInfo, setGateInfo] = useState<{ message: string; config?: AppState["config"] } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [market, setMarket] = useState<MarketView | null>(null);
  const [marketLoading, setMarketLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const r = await api<AppState & { error?: string; message?: string; config?: AppState["config"] }>("/api/state");
    if (r.ok) {
      setState(r.data);
      setGate("ready");
      return;
    }
    if (r.status === 401) return setGate("login");
    if (r.data?.error === "setup_required") {
      setGateInfo({ message: errorMessage(r.data), config: r.data.config });
      return setGate("setup");
    }
    setGateInfo({ message: errorMessage(r.data, "The server could not be reached."), config: r.data?.config });
    setGate("error");
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => { if (document.visibilityState === "visible") void load(); }, STATE_POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  // Remember the selected coin (best effort) and fall back to the first coin if it disappears.
  useEffect(() => {
    if (!state) return;
    const symbols = state.assets.map((a) => a.symbol);
    if (selected && symbols.includes(selected)) return;
    let saved: string | null = null;
    try { saved = localStorage.getItem(SEL_KEY); } catch { /* storage unavailable */ }
    setSelected(saved && symbols.includes(saved) ? saved : symbols[0] ?? null);
  }, [state, selected]);

  const pick = (s: string) => {
    setSelected(s);
    try { localStorage.setItem(SEL_KEY, s); } catch { /* ignore */ }
  };

  // Live market data (public Bybit data via our server) for the selected coin.
  useEffect(() => {
    if (gate !== "ready" || !selected) return;
    let cancelled = false;
    const fetchMarket = async () => {
      setMarketLoading(true);
      const r = await api<MarketView>(`/api/market?symbol=${encodeURIComponent(selected)}`);
      if (cancelled) return;
      setMarketLoading(false);
      setMarket(r.data && typeof r.data === "object" && "ok" in r.data ? r.data : { ok: false, fetchedAt: Date.now(), error: { kind: "network", message: errorMessage(r.data, "Market data unavailable.") } });
    };
    setMarket(null);
    void fetchMarket();
    const id = setInterval(() => { if (document.visibilityState === "visible") void fetchMarket(); }, STATE_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [gate, selected]);

  async function runNow() {
    setRunning(true);
    setRunMsg(null);
    const r = await api<{ message?: string }>("/api/admin/run", { method: "POST", body: {} });
    setRunning(false);
    setRunMsg({ ok: r.ok, text: errorMessage(r.data, r.ok ? "Check completed." : "Check failed.") });
    void load();
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST", body: {} });
    setState(null);
    setGate("login");
  }

  const markers1 = useMemo(() => (state && market?.ok && selected ? buildMarkers(state.trades, selected, market.h1.candles.map((c) => c.time), 3600) : []), [state, market, selected]);
  const markers4 = useMemo(() => (state && market?.ok && selected ? buildMarkers(state.trades, selected, market.h4.candles.map((c) => c.time), 14400) : []), [state, market, selected]);

  if (gate === "loading") {
    return <main className="mx-auto max-w-7xl space-y-4 px-4 py-8"><Skeleton className="h-12" /><Skeleton className="h-40" /><Skeleton className="h-72" /></main>;
  }
  if (gate === "login") return <Login onDone={() => { setGate("loading"); void load(); }} />;
  if (gate === "setup" || gate === "error" || !state) {
    const cfg = gateInfo?.config;
    const steps = cfg ? setupChecklist({ ...cfg }, null) : [];
    return (
      <main className="mx-auto max-w-2xl px-4 py-12">
        <div className="mb-6 text-2xl font-bold"><span className="text-btc">₿</span> Crypto Sentinel</div>
        <Notice tone={gate === "setup" ? "warn" : "bad"} title={gate === "setup" ? "Setup required" : "Cannot load the dashboard"}>{gateInfo?.message}</Notice>
        {steps.length > 0 && (
          <ol className="mt-5 space-y-3">
            {steps.slice(0, 4).map((s) => (
              <li key={s.id} className="flex gap-3 rounded-xl border border-line bg-panel/80 p-3 text-sm">
                <span aria-label={s.done ? "done" : "to do"} className={`mt-0.5 inline-flex h-5 w-5 flex-none items-center justify-center rounded-full text-xs font-bold ${s.done ? "bg-up/15 text-up" : "bg-warn/15 text-warn"}`}>{s.done ? "✓" : "!"}</span>
                <span><span className="block font-medium">{s.title}</span><span className="block text-xs text-fg-mute">{s.detail}</span></span>
              </li>
            ))}
          </ol>
        )}
        <Btn className="mt-6" onClick={() => { setGate("loading"); void load(); }}>Check again</Btn>
      </main>
    );
  }

  const mb = monitorBadge(state.monitor.state);
  const sel = state.assets.find((a) => a.symbol === selected) ?? null;
  const ev = state.evaluations.find((e) => e.symbol === selected);
  const last = state.lastSignals.find((s) => s.symbol === selected);
  const t = market?.ok ? market.ticker : null;
  const marketTone = market === null ? "neutral" : market.ok ? (market.tickerFresh && !market.h1.stale ? "good" : "warn") : "bad";
  const marketLabel = market === null ? (marketLoading ? "Market data loading" : "Market data pending") : market.ok ? (market.tickerFresh && !market.h1.stale ? "Live Bybit data" : "Data stale") : "Market data unavailable";

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 sm:px-6">
      <header className="sticky top-0 z-20 -mx-4 border-b border-line bg-ink/85 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-xl bg-btc/15 text-lg font-bold text-btc">₿</span>
            <div>
              <h1 className="text-base font-bold leading-tight tracking-tight">Crypto Sentinel</h1>
              <p className="text-xs text-fg-mute">Spot · USDT pairs · paper trading only</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={marketTone}>{marketLabel}</Pill>
            <Pill tone={mb.tone} title={state.monitor.message}>{mb.label}</Pill>
            <span className="num hidden text-xs text-fg-mute md:inline" title="Last successful monitor run">Updated {ageLabel(state.monitor.lastSuccessAt, state.now)}</span>
            <Btn onClick={runNow} disabled={running} className="!min-h-[36px] !py-1.5">{running ? "Checking…" : "Run check now"}</Btn>
            <Btn onClick={logout} className="!min-h-[36px] !py-1.5">Sign out</Btn>
          </div>
        </div>
        <nav aria-label="Sections" className="-mb-1 mt-2 flex gap-4 overflow-x-auto text-xs text-fg-mute">
          {[["coins", "Coins"], ["market", "Market"], ["portfolio", "Portfolio"], ["history", "History"], ["email", "Email"], ["settings", "Settings"], ["health", "Health"]].map(([id, label]) => (
            <a key={id} href={`#${id}`} className="whitespace-nowrap py-1 hover:text-fg">{label}</a>
          ))}
        </nav>
      </header>

      <main className="mt-5 space-y-5">
        {runMsg && <Notice tone={runMsg.ok ? "good" : "bad"} title={runMsg.ok ? "Manual check finished" : "Manual check failed"}>{runMsg.text}</Notice>}
        {(state.monitor.state === "never_run" || state.monitor.state === "stopped" || state.monitor.state === "failing") && (
          <Notice tone={state.monitor.state === "never_run" ? "warn" : "bad"} title={state.monitor.state === "never_run" ? "Monitoring has not started" : state.monitor.state === "stopped" ? "Monitoring has stopped" : "Market data is unavailable"}>
            {state.monitor.message} No new signals or emails are generated while this is the case. See System health for setup steps.
          </Notice>
        )}
        {!state.email.configured && (
          <Notice tone="warn" title="Email alerts are not connected">{state.email.issue} Signals are still recorded, but nothing can be emailed until a provider is connected.</Notice>
        )}

        <Coins assets={state.assets} evaluations={state.evaluations} positions={state.positions} selected={selected} now={state.now} onSelect={pick} onChanged={load} />

        {sel && (
          <Card
            id="market"
            title={`${baseOf(sel.symbol)}/USDT · market`}
            right={<span className="text-xs text-fg-mute">{market?.ok ? `fetched ${fmtUtc(market.fetchedAt)}` : "live public data"}</span>}
          >
            {market === null ? (
              <Skeleton className="h-24" />
            ) : !market.ok ? (
              <Notice tone="bad" title="Live market data is unavailable">{market.error.message} Nothing is estimated or shown from memory; the monitor will not trade on missing data.</Notice>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
                  <Stat label="Reference price" value={fmtPrice(t?.lastPrice)} sub="last traded (USDT)" />
                  <Stat label="24h change" value={fmtPct(t?.change24hPct)} tone={t && t.change24hPct !== 0 ? (t.change24hPct > 0 ? "up" : "down") : undefined} />
                  <Stat label="24h high" value={fmtPrice(t?.high24h)} />
                  <Stat label="24h low" value={fmtPrice(t?.low24h)} />
                  <Stat label="24h volume" value={`${t ? t.volume24h.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "—"} ${sel.base}`} sub={t ? `≈ ${fmtUsdt(t.turnover24h / 1e6, 1)}M USDT` : undefined} />
                </div>
                <div className="mt-6 grid gap-6 xl:grid-cols-2">
                  <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-mute">1-hour · signal timeframe</h3>
                    <Chart data={market.h1} markers={markers1} label={`${baseOf(sel.symbol)} 1-hour`} fastLabel={`EMA ${state.settings.emaFast}`} slowLabel={`EMA ${state.settings.emaSlow}`} />
                    <p className="mt-1 text-xs text-fg-mute">Last closed candle {fmtUtc(market.h1.lastClosedAt)}{market.h1.stale ? " — STALE" : ""}</p>
                  </div>
                  <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-mute">4-hour · trend confirmation</h3>
                    <Chart data={market.h4} markers={markers4} label={`${baseOf(sel.symbol)} 4-hour`} fastLabel={`EMA ${state.settings.emaFast}`} slowLabel={`EMA ${state.settings.emaSlow}`} />
                    <p className="mt-1 text-xs text-fg-mute">Last closed candle {fmtUtc(market.h4.lastClosedAt)}{market.h4.stale ? " — STALE" : ""}</p>
                  </div>
                </div>
              </>
            )}
          </Card>
        )}

        {sel && <Signal symbol={sel.symbol} evaluation={ev} lastSignal={last} settings={state.settings} />}

        <Portfolio account={state.account} positions={state.positions} assets={state.assets} stats={state.stats} now={state.now} feeRatePct={state.settings.feeRatePct} />
        <div id="history"><TradeHistory trades={state.trades} /></div>
        <EmailPanel email={state.email} notifications={state.notifications} onChanged={load} />
        <SettingsPanel settings={state.settings} onSaved={load} />
        <Health state={state} />
      </main>

      <footer className="mt-10 border-t border-line pt-5 text-xs leading-relaxed text-fg-mute">
        <p><strong className="text-fg-dim">Educational paper-trading simulator.</strong> Crypto Sentinel never places real orders, holds funds or connects to your exchange account; it only reads Bybit’s public market data. Signals come from transparent technical rules, not predictions, and are not financial advice. Simulated results ignore slippage and do not represent actual fills or guarantee future performance. Any real decision is yours alone.</p>
      </footer>
    </div>
  );
}
