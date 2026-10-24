"use client";
import { baseOf, fmtPrice } from "@/lib/format";
import { ageLabel, fmtUtcShort } from "@/lib/time";
import type { DirectionRow, SignalRow } from "@/lib/directional-run";
import type { Asset } from "@/lib/store";
import { Card, Empty, Notice, Pill } from "./ui";

const trendWord = (t: string) => (t === "UP" ? "uptrend" : t === "DOWN" ? "downtrend" : t === "SIDEWAYS" ? "sideways / mixed" : "unknown");
const tone = (d: string): "good" | "bad" | "neutral" => (d === "LONG" ? "good" : d === "SHORT" ? "bad" : "neutral");
const statusLabel: Record<string, string> = { open: "Open (tracking)", tp: "Reached target", sl: "Hit stop", expired: "Expired", reversed: "Closed by opposite signal", missed: "Not fillable (gap)" };

export function SignalGuide() {
  return (
    <details className="rounded-xl border border-line-2 bg-white/5 px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium text-fg">What do BUY / SELL and LONG / SHORT / NEUTRAL mean? (they are different systems)</summary>
      <div className="mt-3 space-y-2 text-fg-dim">
        <p><strong className="text-fg">BUY / SELL</strong> — the original spot paper-trading rules. BUY opens a simulated spot position; SELL closes it (stop, target or trend exit). A SELL means “exit what I hold”, it is <em>not</em> a short.</p>
        <p><strong className="text-fg">LONG / SHORT</strong> — a separate directional analysis: LONG = conditions favour a rise, SHORT = conditions favour a fall, each with reference entry, stop and target. It opens no paper position and places no order; outcomes are only tracked to measure performance.</p>
        <p><strong className="text-fg">NEUTRAL</strong> — conditions are unclear, contradictory or too weak (or reward/risk is poor after costs), so nothing is signalled.</p>
        <p>A BUY is not automatically a futures LONG, and a SELL is not automatically a SHORT. Both systems can send alerts for the same coin at different times, or at the same time; each email says which system it comes from.</p>
      </div>
    </details>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between gap-3 border-t border-line py-1.5 text-sm"><dt className="text-fg-mute">{k}</dt><dd className="num text-right">{v}</dd></div>;
}

function CoinCard({ row, asset, openSignal, now }: { row: DirectionRow | undefined; asset: Asset; openSignal: SignalRow | undefined; now: number }) {
  const a = row?.assessment;
  const base = asset.base;
  return (
    <div className="rounded-xl border border-line-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold">{base}<span className="text-fg-mute">/USDT</span></div>
        <div className="flex items-center gap-2">
          {openSignal && <Pill tone="warn" title="A signal of this type is still being tracked">tracking {openSignal.direction}</Pill>}
          <Pill tone={a ? tone(a.direction) : "neutral"}>{a ? (a.dataOk ? a.direction : "NO DATA") : "Not evaluated yet"}</Pill>
        </div>
      </div>
      {!row || !a ? (
        <p className="mt-2 text-sm text-fg-mute">No assessment stored yet. It appears after the next monitor run.</p>
      ) : !a.dataOk ? (
        <p className="mt-2 text-sm text-fg-mute">Not assessed: {a.dataIssue}. With missing or stale data the system stays neutral rather than guessing. Checked {ageLabel(row.evaluatedAt, now)}.</p>
      ) : (
        <>
          <p className="mt-2 text-xs text-fg-mute">
            Live price {asset.lastPrice !== null ? fmtPrice(asset.lastPrice) : "—"} · analysis uses the closed 1h candle of {fmtUtcShort(a.candleStart)} (close {fmtPrice(a.price)}) · checked {ageLabel(row.evaluatedAt, now)}
          </p>
          <dl className="mt-2">
            <Row k="1h trend" v={trendWord(a.h1Trend)} />
            <Row k="4h trend (confirmation)" v={trendWord(a.h4Trend)} />
            <Row k="Score LONG / SHORT" v={`${a.longScore} / ${a.shortScore}`} />
            {a.levels && a.direction !== "NEUTRAL" ? (
              <>
                <Row k="Entry reference" v={fmtPrice(a.levels.entry)} />
                <Row k="Stop-loss reference" v={`${fmtPrice(a.levels.stop)} (${a.levels.riskPct.toFixed(2)}%)`} />
                <Row k="Take-profit reference" v={`${fmtPrice(a.levels.takeProfit)} (${a.levels.rewardPct.toFixed(2)}%)`} />
                <Row k="Reward / risk" v={`${a.levels.riskReward.toFixed(2)} · ${a.levels.netRiskReward.toFixed(2)} after est. costs`} />
              </>
            ) : null}
            <Row k="Support / resistance" v={`${a.support !== null ? fmtPrice(a.support) : "—"} / ${a.resistance !== null ? fmtPrice(a.resistance) : "—"}`} />
            {a.volatility && <Row k="Volatility (ATR)" v={`${a.volatility.atrPct.toFixed(2)}% · ${a.volatility.regime}`} />}
            {a.volume && <Row k="Volume vs 20-candle avg" v={`${a.volume.ratio.toFixed(2)}×`} />}
          </dl>
          {a.direction !== "NEUTRAL" ? (
            <>
              <h4 className="mt-3 text-xs font-semibold uppercase tracking-wider text-fg-mute">Why</h4>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-fg-dim">{a.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
              <details className="mt-2 text-sm"><summary className="cursor-pointer text-fg">What would invalidate it</summary>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-fg-dim">{a.invalidations.map((r) => <li key={r}>{r}</li>)}</ul>
              </details>
            </>
          ) : (
            <>
              <h4 className="mt-3 text-xs font-semibold uppercase tracking-wider text-fg-mute">Why neutral</h4>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-fg-dim">{a.notes.slice(0, 4).map((r) => <li key={r}>{r}</li>)}</ul>
              <details className="mt-2 text-sm"><summary className="cursor-pointer text-fg">All conditions checked</summary>
                <ul className="mt-1 space-y-1 text-fg-dim">{a.checks.map((c) => <li key={c.id}>LONG {c.long === null ? "?" : c.long ? "✓" : "✗"} · SHORT {c.short === null ? "?" : c.short ? "✓" : "✗"} — {c.label}: {c.detail}</li>)}</ul>
              </details>
            </>
          )}
          <details className="mt-2 text-sm"><summary className="cursor-pointer text-fg">Costs &amp; limitations</summary>
            <p className="mt-1 text-fg-dim">Estimated round-trip costs ≈ {a.costs.roundTripPct.toFixed(2)}% (fees {a.costs.feePerSidePct}% + slippage {a.costs.slippagePerSidePct}% per side).</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-fg-dim">{a.limitations.map((r) => <li key={r}>{r}</li>)}</ul>
          </details>
        </>
      )}
      <p className="sr-only">{baseOf(asset.symbol)}</p>
    </div>
  );
}

export default function DirectionalPanel({ assessments, signals, assets, now, enabled }: { assessments: DirectionRow[]; signals: SignalRow[]; assets: Asset[]; now: number; enabled: boolean }) {
  const open = new Map(signals.filter((s) => s.status === "open").map((s) => [s.symbol, s]));
  const recent = signals.slice(0, 12);
  return (
    <Card id="directional" title="LONG / SHORT analysis" right={<Pill tone={enabled ? "good" : "warn"}>{enabled ? "On" : "Off"}</Pill>}>
      <SignalGuide />
      <div className="mt-3"><Notice tone="warn" title="Analysis, not advice">Levels are reference estimates built from closed Bybit spot candles. They are not predictions or guarantees, and no order is ever placed. Neutral is a normal, common result.</Notice></div>
      {!enabled && <div className="mt-3"><Notice tone="warn" title="LONG/SHORT analysis is switched off in Settings">Assessments below are not refreshed into alerts until you turn it on. BUY/SELL is unaffected.</Notice></div>}
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {assets.map((a) => <CoinCard key={a.symbol} asset={a} row={assessments.find((r) => r.symbol === a.symbol)} openSignal={open.get(a.symbol)} now={now} />)}
      </div>
      <h3 className="mt-6 text-xs font-semibold uppercase tracking-wider text-fg-mute">Recent LONG / SHORT signals</h3>
      {recent.length === 0 ? (
        <div className="mt-2"><Empty>No LONG or SHORT signal has been raised yet. That is fine: the system only signals when every condition agrees.</Empty></div>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="text-left text-xs text-fg-mute"><th className="py-1 pr-3">Coin</th><th className="pr-3">Direction</th><th className="pr-3">Raised</th><th className="pr-3 text-right">Ref</th><th className="pr-3 text-right">Stop</th><th className="pr-3 text-right">Target</th><th className="pr-3">Status</th><th className="text-right">Net</th></tr></thead>
            <tbody>
              {recent.map((s) => (
                <tr key={s.id} className="border-t border-line">
                  <td className="py-1.5 pr-3">{baseOf(s.symbol)}</td>
                  <td className="pr-3"><Pill tone={tone(s.direction)}>{s.direction}</Pill></td>
                  <td className="pr-3 text-fg-dim">{fmtUtcShort(s.createdAt)}</td>
                  <td className="num pr-3 text-right">{fmtPrice(s.priceRef)}</td>
                  <td className="num pr-3 text-right">{fmtPrice(s.stop)}</td>
                  <td className="num pr-3 text-right">{fmtPrice(s.takeProfit)}</td>
                  <td className="pr-3 text-fg-dim">{statusLabel[s.status] ?? s.status}</td>
                  <td className={`num text-right ${s.netPct === null ? "" : s.netPct >= 0 ? "text-up" : "text-down"}`}>{s.netPct === null ? "—" : `${s.netPct >= 0 ? "+" : "−"}${Math.abs(s.netPct).toFixed(2)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
