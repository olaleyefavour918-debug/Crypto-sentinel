import { emailConfig } from "./email";
import { connectionString } from "./db";
import type { JobRunRow } from "./store";
import type { Settings } from "./types";

export type MonitorState = "never_run" | "active" | "slow" | "failing" | "stopped";

export interface MonitorAssessment {
  state: MonitorState;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastRunStatus: string | null;
  cadenceMinutes: number | null;
  catchesEntries: boolean | null;
  message: string;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Derives monitoring status from recorded job runs. Never claims the monitor is active unless a run has actually
 * completed recently; the observed cadence (not the configured one) is what is reported.
 */
export function assessMonitor(runs: JobRunRow[], now: number, settings: Pick<Settings, "entryWindowMinutes">): MonitorAssessment {
  const real = runs.filter((r) => r.status !== "skipped_locked" && r.status !== "running");
  if (real.length === 0) {
    return {
      state: "never_run", lastRunAt: null, lastSuccessAt: null, lastRunStatus: null, cadenceMinutes: null, catchesEntries: null,
      message: "The monitor has not run yet. Trigger it from your scheduler (see System health → Setup) or press “Run check now”.",
    };
  }
  const sorted = [...real].sort((a, b) => b.startedAt - a.startedAt);
  const last = sorted[0];
  const lastSuccess = sorted.find((r) => r.status === "success" || r.status === "partial") ?? null;
  const gaps: number[] = [];
  const window = sorted.filter((r) => now - r.startedAt <= 24 * 3600_000).slice(0, 12);
  for (let i = 0; i + 1 < window.length; i++) gaps.push(window[i].startedAt - window[i + 1].startedAt);
  const cadenceMs = gaps.length >= 2 ? median(gaps) : null;
  const cadenceMinutes = cadenceMs === null ? null : Math.round((cadenceMs / 60_000) * 10) / 10;
  const staleAfterMs = cadenceMs === null ? 10 * 60_000 : Math.max(3 * 60_000, 2.5 * cadenceMs);
  const age = now - last.startedAt;
  const catchesEntries = cadenceMinutes === null ? null : cadenceMinutes <= settings.entryWindowMinutes / 2;
  const base = { lastRunAt: last.startedAt, lastSuccessAt: lastSuccess?.startedAt ?? null, lastRunStatus: last.status, cadenceMinutes, catchesEntries };

  if (age > staleAfterMs) {
    return { ...base, state: "stopped", message: `No monitor run for ${Math.round(age / 60_000)} min${cadenceMinutes ? ` (normal cadence ≈ ${cadenceMinutes} min)` : ""}. Monitoring appears to have stopped; no new signals are being evaluated.` };
  }
  if (last.status === "failed") {
    return { ...base, state: "failing", message: "The latest monitor run failed (market data unavailable). Signals are paused until data is healthy." };
  }
  if (cadenceMinutes !== null && cadenceMinutes > 15) {
    return { ...base, state: "slow", message: `Runs are happening about every ${cadenceMinutes} min. That is too infrequent to catch hourly entries reliably; use a 1–5 minute scheduler.` };
  }
  return { ...base, state: "active", message: cadenceMinutes ? `Running about every ${cadenceMinutes} min.` : "Running." };
}

export interface ConfigStatus {
  database: boolean;
  adminPassword: boolean;
  cronSecret: boolean;
  emailProvider: "resend" | "brevo" | null;
  emailConfigured: boolean;
  emailIssue: string | null;
  deliveryConfirmation: boolean;
}

export function configStatus(env: Record<string, string | undefined> = process.env): ConfigStatus {
  const e = emailConfig(env);
  return {
    database: connectionString(env as NodeJS.ProcessEnv) !== null,
    adminPassword: !!env.ADMIN_PASSWORD,
    cronSecret: !!env.CRON_SECRET && env.CRON_SECRET.length >= 16,
    emailProvider: e.provider,
    emailConfigured: e.configured,
    emailIssue: e.issue,
    deliveryConfirmation: e.provider === "resend" && e.webhookConfigured,
  };
}
