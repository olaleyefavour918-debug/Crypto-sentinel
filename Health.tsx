import { fmtUtcShort, ageLabel } from "@/lib/time";
import { monitorBadge, setupChecklist } from "@/lib/viewmodel";
import type { AppState } from "./api";
import { Card, Notice, Pill } from "./ui";

export default function Health({ state }: { state: AppState }) {
  const m = state.monitor;
  const mb = monitorBadge(m.state);
  const steps = setupChecklist(state.config, m.state);
  const open = steps.filter((s) => !s.done);
  const api = state.marketApi;
  const apiBad = !!api?.lastError;

  return (
    <Card id="health" title="System health" right={<Pill tone={mb.tone}>{mb.label}</Pill>}>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 text-sm">
        <div><div className="text-xs uppercase tracking-wider text-fg-mute">Monitor</div><div className="mt-1">{m.message}</div></div>
        <div><div className="text-xs uppercase tracking-wider text-fg-mute">Last successful run</div><div className="mt-1 num">{m.lastSuccessAt ? `${fmtUtcShort(m.lastSuccessAt)} (${ageLabel(m.lastSuccessAt, state.now)})` : "never"}</div></div>
        <div><div className="text-xs uppercase tracking-wider text-fg-mute">Bybit market data</div><div className="mt-1">{api?.lastSuccessAt ? `OK ${ageLabel(api.lastSuccessAt, state.now)}` : "no successful fetch yet"}{apiBad && <span className="block text-xs text-down">{api?.lastError}</span>}</div></div>
        <div><div className="text-xs uppercase tracking-wider text-fg-mute">Database</div><div className="mt-1">{state.database === "ok" ? "Connected" : state.database}</div></div>
      </div>
      {m.cadenceMinutes !== null && <p className="mt-3 text-xs text-fg-mute">Observed cadence: one run about every {m.cadenceMinutes} min (measured from recorded runs, not assumed).</p>}

      {open.length > 0 && (
        <div className="mt-5">
          <Notice tone="warn" title={`${open.length} setup step${open.length > 1 ? "s" : ""} still open`}>
            <ul className="mt-1 list-disc space-y-1 pl-5">{open.map((s) => <li key={s.id}><strong className="text-fg">{s.title}:</strong> {s.detail}</li>)}</ul>
          </Notice>
        </div>
      )}

      <h3 className="mt-6 text-xs font-semibold uppercase tracking-wider text-fg-mute">Recent monitor runs</h3>
      {state.jobRuns.length === 0 ? (
        <p className="mt-2 text-sm text-fg-mute">No runs recorded yet.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead><tr className="text-left text-xs text-fg-mute"><th className="py-1.5 pr-3 font-normal">Started (UTC)</th><th className="pr-3 font-normal">Source</th><th className="pr-3 font-normal">Result</th><th className="font-normal">Detail</th></tr></thead>
            <tbody>
              {state.jobRuns.map((r) => (
                <tr key={r.id} className="border-t border-line align-top">
                  <td className="num whitespace-nowrap py-1.5 pr-3">{fmtUtcShort(r.startedAt)}</td>
                  <td className="pr-3">{r.triggerSource}</td>
                  <td className="pr-3"><Pill tone={r.status === "success" ? "good" : r.status === "partial" || r.status === "skipped_locked" ? "warn" : r.status === "running" ? "neutral" : "bad"}>{r.status.replace("_", " ")}</Pill></td>
                  <td className="max-w-[320px] truncate text-xs text-fg-mute" title={r.message ?? ""}>{r.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <details className="mt-6 rounded-xl border border-line bg-ink-2/60 p-3 text-sm">
        <summary className="cursor-pointer font-medium">How the monitor is scheduled</summary>
        <div className="mt-2 space-y-2 text-fg-dim">
          <p>Nothing runs inside your browser. A scheduler calls <code className="rounded bg-white/5 px-1">GET /api/cron/monitor</code> with the header <code className="rounded bg-white/5 px-1">Authorization: Bearer &lt;CRON_SECRET&gt;</code>. Each call checks every selected coin once and ends.</p>
          <p><strong className="text-fg">Vercel Hobby</strong> only allows a cron once per day, so use a free external scheduler (for example cron-job.org) every 1–5 minutes. <strong className="text-fg">Vercel Pro</strong> can run Vercel Cron every minute. Hourly signals only need a check every few minutes; shorter intervals mainly make exits (stop/target) react faster.</p>
          <p>This page reports the cadence it actually observes. If runs stop arriving, the badge above turns red.</p>
        </div>
      </details>
    </Card>
  );
}
