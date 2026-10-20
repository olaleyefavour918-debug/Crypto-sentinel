"use client";
import { useState, type FormEvent } from "react";
import { baseOf, fmtPrice } from "@/lib/format";
import type { Asset, EvaluationRow, Position } from "@/lib/store";
import { ageLabel } from "@/lib/time";
import { evalBadge } from "@/lib/viewmodel";
import { api, errorMessage } from "./api";
import { Btn, Card, Empty, Pill } from "./ui";

const SUGGESTIONS = ["DOGE", "ADA", "AVAX", "LINK", "TON", "LTC"];

export default function Coins({ assets, evaluations, positions, selected, now, onSelect, onChanged }: {
  assets: Asset[]; evaluations: EvaluationRow[]; positions: Position[]; selected: string | null; now: number;
  onSelect: (symbol: string) => void; onChanged: () => void;
}) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    setBusy(true);
    setMsg(null);
    const r = await api("/api/assets", { method: "POST", body: { base: input } });
    setBusy(false);
    if (r.ok) {
      setMsg({ tone: "good", text: `${input.trim().toUpperCase()} added. It will be evaluated on the next monitor run.` });
      setInput("");
      onChanged();
    } else setMsg({ tone: "bad", text: errorMessage(r.data, "Could not add this coin.") });
  }

  async function toggle(a: Asset) {
    const r = await api("/api/assets", { method: "PATCH", body: { symbol: a.symbol, enabled: !a.enabled } });
    if (!r.ok) setMsg({ tone: "bad", text: errorMessage(r.data) });
    onChanged();
  }

  async function remove(symbol: string) {
    const r = await api("/api/assets", { method: "DELETE", body: { symbol } });
    setConfirmRemove(null);
    setMsg(r.ok ? { tone: "good", text: `${baseOf(symbol)} removed. Its trade history is kept.` } : { tone: "bad", text: errorMessage(r.data) });
    onChanged();
  }

  const evalOf = (s: string) => evaluations.find((e) => e.symbol === s);
  const openOf = (s: string) => positions.find((p) => p.symbol === s);

  return (
    <Card
      id="coins"
      title="Coins being monitored"
      right={<span className="text-xs text-fg-mute">{assets.length} selected · Bybit spot, USDT pairs</span>}
    >
      {assets.length === 0 ? (
        <Empty>No coins selected. Add one below (for example BTC, ETH, SOL, XRP or BNB) to start monitoring.</Empty>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {assets.map((a) => {
            const ev = evalOf(a.symbol);
            const badge = evalBadge(ev?.status ?? a.lastEvalStatus);
            const pos = openOf(a.symbol);
            const isSel = selected === a.symbol;
            return (
              <li key={a.symbol} className={`rounded-xl border p-3 transition-colors ${isSel ? "border-accent/60 bg-accent/5" : "border-line bg-ink-2/60"} ${a.enabled ? "" : "opacity-70"}`}>
                <button type="button" onClick={() => onSelect(a.symbol)} aria-pressed={isSel} className="block w-full text-left">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-base font-semibold">{baseOf(a.symbol)}<span className="text-fg-mute">/USDT</span></span>
                    <span className="num text-base font-semibold">{fmtPrice(a.lastPrice)}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {!a.enabled ? <Pill tone="warn">Paused</Pill> : <Pill tone={badge.tone}>{badge.label}</Pill>}
                    {pos && <Pill tone="good" title="A simulated position is open; exits are still monitored">Position open</Pill>}
                    {a.enabled && !pos && !a.signalArmed && <Pill tone="neutral" title="Waiting for conditions to lapse before the next entry">Re-arming</Pill>}
                    {a.lastError && <Pill tone="bad" title={a.lastError}>Data error</Pill>}
                  </div>
                  <div className="mt-2 text-xs text-fg-mute">Checked {ageLabel(a.lastCheckedAt, now)}</div>
                </button>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Btn onClick={() => toggle(a)} aria-label={`${a.enabled ? "Pause" : "Resume"} ${baseOf(a.symbol)}`} className="!min-h-[34px] !px-2.5 !py-1 text-xs">{a.enabled ? "Pause" : "Resume"}</Btn>
                  {confirmRemove === a.symbol ? (
                    <>
                      <Btn variant="danger" onClick={() => remove(a.symbol)} className="!min-h-[34px] !px-2.5 !py-1 text-xs">Confirm remove</Btn>
                      <Btn onClick={() => setConfirmRemove(null)} className="!min-h-[34px] !px-2.5 !py-1 text-xs">Cancel</Btn>
                    </>
                  ) : (
                    <Btn variant="danger" onClick={() => setConfirmRemove(a.symbol)} aria-label={`Remove ${baseOf(a.symbol)}`} className="!min-h-[34px] !px-2.5 !py-1 text-xs">Remove</Btn>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <form onSubmit={add} className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="add-coin" className="block text-xs font-medium uppercase tracking-wider text-fg-mute">Add a coin</label>
          <input
            id="add-coin" value={input} onChange={(e) => setInput(e.target.value.toUpperCase())} placeholder="Ticker, e.g. DOGE" maxLength={14}
            autoCapitalize="characters" autoComplete="off" spellCheck={false}
            className="mt-1 w-full rounded-lg border border-line-2 bg-ink px-3 py-2.5 text-fg outline-none placeholder:text-fg-mute focus:border-accent"
          />
        </div>
        <Btn variant="primary" type="submit" disabled={busy || !input.trim()}>{busy ? "Checking Bybit…" : "Add coin"}</Btn>
      </form>
      <div className="mt-2 flex flex-wrap gap-1.5 text-xs text-fg-mute">
        <span className="py-1">Ideas:</span>
        {SUGGESTIONS.filter((s) => !assets.some((a) => a.base === s)).map((s) => (
          <button key={s} type="button" onClick={() => setInput(s)} className="rounded-full border border-line-2 px-2.5 py-1 hover:bg-white/5 hover:text-fg">{s}</button>
        ))}
      </div>
      <p className="mt-2 text-xs text-fg-mute">Each coin is checked against Bybit’s public spot list before it is added. Up to 15 coins. Removing a coin keeps its history; a coin with an open simulated position can be paused but not removed until it closes.</p>
      {msg && <p role="status" className={`mt-3 text-sm ${msg.tone === "good" ? "text-up" : "text-down"}`}>{msg.text}</p>}
    </Card>
  );
}
