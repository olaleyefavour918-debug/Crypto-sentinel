import { clientIp, json, requireAdminMutation } from "@/lib/auth";
import { internalError, readJson, withDb } from "@/lib/api";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/ratelimit";
import { loadSettings, saveSettings } from "@/lib/store";
import { validateSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PUT(req: Request) {
  const denied = requireAdminMutation(req);
  if (denied) return denied;
  try {
    const got = await withDb();
    if (got.res) return got.res;
    const rl = await rateLimit(got.db, `settings:${clientIp(req)}`, 30, 60_000);
    if (!rl.allowed) return json({ error: "rate_limited" }, 429, { "retry-after": String(rl.retryAfterSec) });
    const body = await readJson(req);
    if (body === undefined) return json({ error: "invalid_json", message: "Body must be valid JSON (max 16 KB)." }, 400);
    const current = await loadSettings(got.db);
    const result = validateSettings(body, current);
    if (!result.ok) return json({ error: "validation_failed", errors: result.errors }, 400);
    await saveSettings(got.db, result.value);
    logger.info("settings.updated", { keys: Object.keys(body as object) });
    return json({ ok: true, settings: result.value });
  } catch (e) {
    return internalError(e);
  }
}
