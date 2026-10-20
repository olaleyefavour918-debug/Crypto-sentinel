import { checkAdminPassword, clientIp, isSecureRequest, json, sameOrigin, sessionCookie, signSession } from "@/lib/auth";
import { readJson, withDb, internalError } from "@/lib/api";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    if (!process.env.ADMIN_PASSWORD) {
      return json({ error: "setup_required", message: "ADMIN_PASSWORD is not set on the server (see README)." }, 503);
    }
    if (!sameOrigin(req)) return json({ error: "forbidden" }, 403);
    // Brute-force protection (shared across serverless instances via Postgres). Fail closed if the DB is down.
    const got = await withDb();
    if (got.res) return got.res;
    const rl = await rateLimit(got.db, `login:${clientIp(req)}`, 8, 5 * 60_000);
    if (!rl.allowed) {
      logger.warn("auth.login_rate_limited");
      return json({ error: "rate_limited", message: "Too many attempts. Try again later." }, 429, { "retry-after": String(rl.retryAfterSec) });
    }
    const body = (await readJson(req, 2048)) as { password?: unknown } | undefined;
    if (!body || !checkAdminPassword(body.password)) {
      logger.warn("auth.login_failed");
      return json({ error: "invalid_credentials", message: "Incorrect password." }, 401);
    }
    const token = signSession(process.env);
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(token, isSecureRequest(req)) });
  } catch (e) {
    return internalError(e);
  }
}
