/**
 * How fresh is what the dashboard shows? A setup is re-checked on every monitor pass (cron-job.org, every 5 minutes).
 * If a live (not expired) setup has not been re-checked for this long, the dashboard says so instead of presenting an
 * old price as current.
 */
export const SETUP_STALE_MS = 15 * 60_000;

export interface Freshness {
  ageMs: number;
  stale: boolean;
}

export function setupFreshness(lastScanAt: number, now: number, status: string): Freshness {
  const ageMs = Math.max(0, now - lastScanAt);
  return { ageMs, stale: status !== "EXPIRED" && ageMs > SETUP_STALE_MS };
}
