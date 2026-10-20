import { json, requireCron } from "@/lib/auth";
import { internalError, withDb } from "@/lib/api";
import { runMonitor } from "@/lib/monitor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Scheduler entry point. Vercel Cron calls this with GET and `Authorization: Bearer $CRON_SECRET`;
 * external schedulers (cron-job.org, GitHub Actions) must send the same header.
 * Each call is one bounded monitoring pass — nothing loops or sleeps inside the function.
 */
async function handle(req: Request) {
  const denied = requireCron(req);
  if (denied) return denied;
  try {
    const got = await withDb();
    if (got.res) return got.res;
    const result = await runMonitor({ db: got.db, trigger: "cron" });
    const code = result.status === "failed" ? 502 : 200;
    return json({ ok: result.status !== "failed", ...result }, code);
  } catch (e) {
    return internalError(e);
  }
}

export const GET = handle;
export const POST = handle;
