"use client";
import { useState } from "react";
import { fmtPrice, pairLabel } from "@/lib/format";
import { setupFreshness } from "@/lib/freshness";
import { validityText } from "@/lib/lifecycle";
import { STRATEGY_LABEL } from "@/lib/setups";
import type { SetupView, SetupsSummary } from "@/lib/setups-run";
import { ageLabel, fmtUtc } from "@/lib/time";
import type { Settings } from "@/lib/types";
import { Card, Empty, Notice, Pill } from "./ui";

type Tab = "early" | "confirmed" | "exit" | "other";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "early", label: "Early (unconfirmed)" },
  { id: "confirmed", label: "Confirmed" },
  { id: "exit", label: "Exit warnings" },
  { id: "other", label: "Watching / expired" },
];

function pick(tab: Tab, s: SetupView): boolean {
  if (tab === "early") return s.status === "POTENTIAL" && s.strategy !== "EXIT_WARNING";
  if (tab === "confirmed") return s.status === "CONFIRMED" && s.strategy !== "EXIT_WARNING";
  if (tab === "exit") return s.strategy === "EXIT_WARNING" && (s.status === "POTENTIAL" || s.status === "CONFIRMED");
  return s.status === "WATCH" || s.status === "EXPIRED";
}

const statusTone = (s: SetupView): "good" | "bad" | "warn" | "neutral" =>
  s.status === "CONFIRMED" ? (s.strategy === "EXIT_WARNING" ? "bad" : "good") : s.status === "POTENTIAL" ? "warn" : "neutral";

function statusText(s: SetupView): string {
  if (s.status === "POTENTIAL") return s.strategy === "EXIT_WARNING" ? "POTENTIAL EXIT WARNING · not confirmed" : "POTENTIAL BUY · not confirmed";
  if (s.status === "CONFIRMED") return s.strategy === "EXIT_WARNING" ? "CONFIRMED EXIT WARNING" : "CONFIRMED BUY SETUP";
  return s.status;
}

function Card1({ s, now }: { s: SetupView; now: number }) {
  const move = s.signalPrice && s.lastPrice ? ((s.lastPrice - s.signalPrice) / s.signalPrice) * 100 : null;
  const failed = s.conditions.filter((c) => !c.passed).length;
  const fresh = setupFreshness(s.lastScanAt, now, s.status);
  return (
    <div className="rounded-xl border border-line-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold">{pairLabel(s.symbol)} <span className="text-xs font-normal text-fg-mute">· {STRATEGY_LABEL[s.strategy]}</span></div>
        <Pill tone={statusTone(s)}>{statusText(s)}</Pill>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        <div><dt className="text-xs text-fg-mute">Signal price</dt><dd className="num">{s.signalPrice !== null ? fmtPrice(s.signalPrice) : "—"}</dd></div>
        <div><dt className="text-xs text-fg-mute">Latest price</dt><dd className="num">{s.lastPrice !== null ? fmtPrice(s.lastPrice) : "—"}{move !== null && <span className="text-fg-mute"> ({move >= 0 ? "+" : "−"}{Math.abs(move).toFixed(2)}%)</span>}</dd></div>
        <div><dt className="text-xs text-fg-mute">First detected (UTC)</dt><dd className="num">{fmtUtc(s.firstSeenAt)}</dd></div>
        {s.status !== "WATCH" && <div><dt className="text-xs text-fg-mute">{s.status === "CONFIRMED" ? "Confirmed (UTC)" : s.status === "EXPIRED" ? "Expired (UTC)" : "Current status since (UTC)"}</dt><dd className="num">{fmtUtc(s.status === "EXPIRED" && s.expiredAt ? s.expiredAt : s.statusSince)}</dd></div>}
        <div><dt className="text-xs text-fg-mute">Last checked · data source</dt><dd className={`num ${fresh.stale ? "text-down" : ""}`}>{ageLabel(s.lastScanAt, now)} · Bybit spot</dd></div>
        <div><dt className="text-xs text-fg-mute">Signal price time (UTC)</dt><dd className="num">{s.signalPriceAt ? fmtUtc(s.signalPriceAt) : "—"}</dd></div>
        <div><dt className="text-xs text-fg-mute">Age</dt><dd className="num">{s.signalPriceAt ? ageLabel(s.signalPriceAt, now) : "—"}</dd></div>
        <div><dt className="text-xs text-fg-mute">Timeframe</dt><dd>1H setup · 4H context</dd></div>
        <div><dt className="text-xs text-fg-mute">Validity</dt><dd>{validityText(s, now)}</dd></div>
      </dl>
      {fresh.stale && <p className="mt-2 text-xs text-down">STALE: this setup was last checked {ageLabel(s.lastScanAt, now)}. The prices shown may be out of date until the next successful scan.</p>}
      {s.status === "POTENTIAL" && <p className="mt-2 text-xs text-warn">Based on the 1H candle that is still forming. It can disappear before the candle closes.</p>}
      {s.levels && s.status !== "WATCH" && (
        <p className="num mt-2 text-xs text-fg-mute">Reference stop {fmtPrice(s.levels.stop)} · target {fmtPrice(s.levels.target)} · net reward/risk {s.levels.netRiskReward.toFixed(2)} (after costs). Reference only, no order is placed.</p>
      )}
      {s.reasons.length > 0 && <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-fg-dim">{s.reasons.slice(0, 6).map((r) => <li key={r}>{r}</li>)}</ul>}
      {s.status === "EXPIRED" && <p className="mt-2 text-xs text-fg-mute">Expired: {s.expireReason}.{s.outcomeStatus ? ` Tracked outcome: ${s.outcomeStatus}${s.outcomeNetPct !== null ? ` (${s.outcomeNetPct.toFixed(2)}% after costs)` : ""}.` : ""}</p>}
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-fg-dim">Checklist ({s.conditions.length - failed}/{s.conditions.length} passed)</summary>
        <ul className="mt-2 space-y-1">
          {s.conditions.map((c) => (
            <li key={c.id} className="flex gap-2"><span aria-hidden className={c.passed ? "text-up" : "text-down"}>{c.passed ? "✓" : "✗"}</span><span><span className="text-fg">{c.label}</span> <span className="num text-xs text-fg-mute">{c.detail}</span></span></li>
          ))}
        </ul>
      </details>
    </div>
  );
}

export default function SetupsPanel({ data, settings, now }: { data: SetupsSummary | undefined; settings: Settings; now: number }) {
  const [tab, setTab] = useState<Tab>("confirmed");
  if (settings.setupsEnabled === false) return null;
  const setups = data?.setups ?? [];
  const list = setups.filter((s) => pick(tab, s));
  const b = data?.bounceStats;
  const e = data?.early;
  return (
    <Card title="Setups — early reads, confirmed setups and exit warnings" right={<Pill tone={settings.setupAlertsEnabled ? "good" : "warn"}>{settings.setupAlertsEnabled ? "alerts on" : "recording only (alerts off)"}</Pill>}>
      <div className="space-y-3">
        <p className="text-sm text-fg-dim">Rule-based analysis, not a prediction. Paper trading only: nothing here opens or closes a trade or places an order, and nothing is guaranteed. An early read uses the unfinished candle and is never shown as confirmed.</p>
        {!settings.setupAlertsEnabled && <Notice tone="warn" title="Recording only">Setups are being detected and tracked here, but no email or phone alert is sent for them yet. Switch on “Alert me about setups” in Settings once you are comfortable with the results.</Notice>}
        {data && data.dataIssues.length > 0 && <Notice tone="bad" title="DATA DELAYED">{data.dataIssues.map((d) => `${pairLabel(d.symbol)}: ${d.issue}`).join(" · ")}. No new setups are created for these coins until fresh data returns.</Notice>}
        <div role="tablist" className="flex flex-wrap gap-2">
          {TABS.map((t) => {
            const n = setups.filter((s) => pick(t.id, s)).length;
            return <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={`rounded-lg border px-3 py-1.5 text-sm ${tab === t.id ? "border-accent text-fg bg-white/5" : "border-line-2 text-fg-dim hover:bg-white/5"}`}>{t.label} <span className="num text-xs text-fg-mute">{n}</span></button>;
          })}
        </div>
        {list.length === 0 ? <Empty>Nothing in this tab right now. That is normal: setups are rare by design.</Empty> : <div className="space-y-3">{list.map((s) => <Card1 key={s.id} s={s} now={now} />)}</div>}
        <div className="rounded-xl border border-line-2 bg-white/5 px-4 py-3 text-sm text-fg-dim">
          <div className="font-medium text-fg">How reliable is this? Honest tracking</div>
          <p className="mt-1">Support-Bounce results (tracked separately, not part of your paper account): {b && b.count > 0 ? `${b.count} resolved, ${b.winRatePct !== null ? b.winRatePct.toFixed(0) + "% won" : "—"}` : "none resolved yet"}. {b?.caveats[0] ?? "Only 0 resolved signals so far."} Do not treat this strategy as proven.</p>
          {e && <p className="mt-1">Early reads: {e.raised} raised · {e.confirmed} confirmed at candle close · {e.faded} faded before closing.</p>}
        </div>
      </div>
    </Card>
  );
}
