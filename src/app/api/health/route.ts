import { json } from "@/lib/auth";
import { withDb } from "@/lib/api";
import { assessMonitor } from "@/lib/health";
import { loadSettings, recentJobRuns } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Public, minimal liveness probe: no secrets, no configuration details, no market data. */
export async function GET() {
  const got = await withDb();
  if (got.res) {
    const body = await got.res.json().catch(() => ({}));
    return json({ ok: false, database: (body as { error?: string }).error === "database_not_configured" ? "not_configured" : "error", time: new Date().toISOString() }, 503);
  }
  try {
    const settings = await loadSettings(got.db);
    const runs = await recentJobRuns(got.db, 30);
    const m = assessMonitor(runs, Date.now(), settings);
    const healthy = m.state === "active" || m.state === "slow";
    return json({ ok: healthy, database: "ok", monitor: { state: m.state, lastSuccessAt: m.lastSuccessAt ? new Date(m.lastSuccessAt).toISOString() : null }, time: new Date().toISOString() }, healthy ? 200 : 503);
  } catch {
    return json({ ok: false, database: "error", time: new Date().toISOString() }, 503);
  }
}
