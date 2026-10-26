"use client";
import { useEffect, useState, type FormEvent } from "react";
import type { Settings } from "@/lib/types";
import { api, errorMessage } from "./api";
import { Btn, Card } from "./ui";

type NumKey = "positionAmountUsdt" | "stopLossPct" | "takeProfitPct" | "feeRatePct" | "entryWindowMinutes" | "emaFast" | "emaSlow" | "rsiPeriod" | "rsiMin" | "rsiMax" | "macdFast" | "macdSlow" | "macdSignal" | "atrPeriod" | "slippagePct" | "minRiskReward";

const GROUPS: Array<{ title: string; hint?: string; fields: Array<{ key: NumKey; label: string; step?: string; unit?: string }> }> = [
  { title: "Paper position & exits", hint: "Illustrative values, not recommendations.", fields: [
    { key: "positionAmountUsdt", label: "Position amount", step: "0.5", unit: "USDT" },
    { key: "stopLossPct", label: "Downside exit", step: "0.1", unit: "%" },
    { key: "takeProfitPct", label: "Upside exit", step: "0.1", unit: "%" },
    { key: "feeRatePct", label: "Fee per side", step: "0.01", unit: "%" },
    { key: "entryWindowMinutes", label: "Entry window after candle close", unit: "min" },
  ] },
  { title: "LONG / SHORT analysis", hint: "Separate from BUY/SELL. Slippage is an assumption used only for cost estimates.", fields: [
    { key: "slippagePct", label: "Assumed slippage per side", step: "0.01", unit: "%" },
    { key: "minRiskReward", label: "Minimum reward/risk", step: "0.1" },
  ] },
  { title: "Indicators", hint: "Changes apply from the next monitor run.", fields: [
    { key: "emaFast", label: "EMA fast" }, { key: "emaSlow", label: "EMA slow" },
    { key: "rsiPeriod", label: "RSI period" }, { key: "rsiMin", label: "RSI minimum", step: "1" }, { key: "rsiMax", label: "RSI maximum", step: "1" },
    { key: "macdFast", label: "MACD fast" }, { key: "macdSlow", label: "MACD slow" }, { key: "macdSignal", label: "MACD signal" },
    { key: "atrPeriod", label: "ATR period" },
  ] },
];

export default function SettingsPanel({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setDraft(settings), [settings]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const r = await api("/api/settings", { method: "PUT", body: draft });
    setBusy(false);
    setMsg({ ok: r.ok, text: r.ok ? "Settings saved." : errorMessage(r.data, "Could not save settings.") });
    if (r.ok) onSaved();
  }

  const input = "mt-1 w-full rounded-lg border border-line-2 bg-ink px-3 py-2 text-fg outline-none focus:border-accent num";
  const Toggle = ({ k, label }: { k: "buyEmailEnabled" | "sellEmailEnabled" | "trendExitEnabled" | "directionalEnabled" | "directionalEmailEnabled"; label: string }) => (
    <label className="flex cursor-pointer items-center gap-3 text-sm">
      <input type="checkbox" checked={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.checked })} className="h-4 w-4 accent-[#7aa2ff]" />
      {label}
    </label>
  );

  return (
    <Card id="settings" title="Settings">
      <form onSubmit={save} className="space-y-6">
        {GROUPS.map((g) => (
          <fieldset key={g.title}>
            <legend className="text-xs font-semibold uppercase tracking-wider text-fg-mute">{g.title}</legend>
            {g.hint && <p className="mt-1 text-xs text-fg-mute">{g.hint}</p>}
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {g.fields.map((f) => (
                <label key={f.key} className="block text-xs text-fg-dim">
                  {f.label}{f.unit ? ` (${f.unit})` : ""}
                  <input type="number" inputMode="decimal" step={f.step ?? "1"} value={Number.isFinite(draft[f.key]) ? draft[f.key] : ""} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value === "" ? NaN : Number(e.target.value) })} className={input} />
                </label>
              ))}
            </div>
          </fieldset>
        ))}
        <fieldset>
          <legend className="text-xs font-semibold uppercase tracking-wider text-fg-mute">Alerts & exits</legend>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-fg-dim sm:col-span-2">Email recipient
              <input type="email" value={draft.emailRecipient} onChange={(e) => setDraft({ ...draft, emailRecipient: e.target.value })} className={`${input} !font-sans`} autoComplete="off" />
            </label>
            <Toggle k="buyEmailEnabled" label="Email me when BUY conditions are met" />
            <Toggle k="sellEmailEnabled" label="Email me when SELL conditions are met" />
            <Toggle k="directionalEnabled" label="Run LONG / SHORT / NEUTRAL analysis" />
            <Toggle k="directionalEmailEnabled" label="Email me when a LONG or SHORT setup appears" />
            <Toggle k="trendExitEnabled" label="Also exit when the 1h EMA trend turns down (optional)" />
          </div>
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <Btn variant="primary" type="submit" disabled={busy || !dirty}>{busy ? "Saving…" : "Save settings"}</Btn>
          {dirty && <Btn onClick={() => setDraft(settings)}>Discard</Btn>}
          {msg && <span role="status" className={`text-sm ${msg.ok ? "text-up" : "text-down"}`}>{msg.text}</span>}
        </div>
        <p className="text-xs text-fg-mute">New position amounts and thresholds apply to future simulated entries; positions already open keep the values they were opened with.</p>
      </form>
    </Card>
  );
}
