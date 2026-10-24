"use client";
import { useState } from "react";
import type { BacktestResult, PerfBucket, PerfStats } from "@/lib/directional";
import { baseOf } from "@/lib/format";
import { fmtUtcShort } from "@/lib/time";
import type { Asset } from "@/lib/store";
import { api, errorMessage } from "./api";
import { Btn, Card, Notice, Stat } from "./ui";

const pct = (n: number | null, dp = 2) => (n === null ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(dp)}%`);

function Tiles({ b }: { b: PerfBucket }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat label="Resolved signals" value={String(b.count)} sub={`${b.wins} winning · ${b.losses} not`} />
      <Stat label="Win rate" value={b.winRatePct === null ? "—" : `${b.winRatePct.toFixed(0)}%`} sub="after est. costs" />
      <Stat label="Cumulative net" value={pct(b.totalNetPct)} tone={b.totalNetPct > 0 ? "up" : b.totalNetPct < 0 ? "down" : undefined} sub={`avg ${pct(b.avgNetPct)}`} />
      <Stat label="Max drawdown" value={`${b.maxDrawdownPct.toFixed(2)} pts`} sub={`profit factor ${b.profitFactor === null ? "—" : b.profitFactor.toFixed(2)}`} />
    </div>
  );
}

export default function PerformancePanel({ stats, counts, assets }: { stats: PerfStats; counts: { open: number; missed: number }; assets: Asset[] }) {
  const [symbol, setSymbol] = useState(assets[0]?.symbol ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true); setErr(null); setResult(null);
    const r = await api<{ result?: BacktestResult; message?: string }>(`/api/backtest?symbol=${encodeURIComponent(symbol)}`);
    setBusy(false);
    if (r.ok && r.data.result) setResult(r.data.result);
    else setErr(errorMessage(r.data, "Back-test failed."));
  }

  return (
    <Card id="performance" title="LONG / SHORT performance & risk">
      <p className="text-sm text-fg-dim">Every LONG/SHORT signal is tracked forward with candles that came <em>after</em> it: the simulated fill is the next candle’s open, and estimated fees and slippage are deducted. Nothing is back-filled or cherry-picked.</p>
      <div className="mt-4"><Tiles b={stats} /></div>
      <p className="mt-2 text-xs text-fg-mute">Still being tracked: {counts.open} · not fillable (price gapped past a level): {counts.missed}. LONG: {stats.long.count} resolved ({pct(stats.long.totalNetPct)}), SHORT: {stats.short.count} resolved ({pct(stats.short.totalNetPct)}).</p>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-fg-mute">{stats.caveats.map((c) => <li key={c}>{c}</li>)}</ul>

      <h3 className="mt-6 text-xs font-semibold uppercase tracking-wider text-fg-mute">Historical back-test (walk-forward)</h3>
      <p className="mt-1 text-sm text-fg-dim">Replays the same rules over the latest ~1000 hourly candles of one coin, using only candles that had already closed at each step (no look-ahead).</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="rounded-lg border border-line-2 bg-ink px-3 py-2 text-sm" aria-label="Coin to back-test">
          {assets.map((a) => <option key={a.symbol} value={a.symbol}>{a.base}/USDT</option>)}
        </select>
        <Btn variant="primary" disabled={busy || !symbol} onClick={run}>{busy ? "Running…" : "Run back-test"}</Btn>
      </div>
      {err && <div className="mt-3"><Notice tone="bad" title="Back-test unavailable">{err}</Notice></div>}
      {result && (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-fg-dim">{baseOf(result.symbol)}/USDT · {fmtUtcShort(result.from)} → {fmtUtcShort(result.to)} · {result.signals.length} signal(s), {result.stats.count} resolved, {result.stillOpen} still open, {result.skippedMissed} not fillable.</p>
          {result.stats.count ? <Tiles b={result.stats} /> : <Notice tone="neutral" title="No resolved signals in this window">The rules stayed selective: most hours were NEUTRAL. That is not a failure.</Notice>}
          <ul className="list-disc space-y-1 pl-5 text-xs text-fg-mute">{[...result.stats.caveats, ...result.limitations].map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
      )}
    </Card>
  );
}
