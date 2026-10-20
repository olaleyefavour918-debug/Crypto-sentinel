import { clientIp, json, requireAdminMutation } from "@/lib/auth";
import { internalError, withDb } from "@/lib/api";
import { runMonitor } from "@/lib/monitor";
import { rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/** “Run check now” button. Uses the same locked, idempotent monitor pass as the scheduler. */
export async function POST(req: Request) {
  const denied = requireAdminMutation(req);
  if (denied) return denied;
  try {
    const got = await withDb();
    if (got.res) return got.res;
    const rl = await rateLimit(got.db, `manual-run:${clientIp(req)}`, 6, 60_000);
    if (!rl.allowed) return json({ error: "rate_limited" }, 429, { "retry-after": String(rl.retryAfterSec) });
    const result = await runMonitor({ db: got.db, trigger: "manual" });
    return json({ ok: result.status !== "failed", ...result });
  } catch (e) {
    return internalError(e);
  }
}
