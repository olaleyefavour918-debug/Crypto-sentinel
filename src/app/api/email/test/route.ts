import { clientIp, json, requireAdminMutation } from "@/lib/auth";
import { internalError, withDb } from "@/lib/api";
import { sendTestEmail } from "@/lib/email";
import { rateLimit } from "@/lib/ratelimit";
import { loadSettings } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request) {
  const denied = requireAdminMutation(req);
  if (denied) return denied;
  try {
    const got = await withDb();
    if (got.res) return got.res;
    const rl = await rateLimit(got.db, `email-test:${clientIp(req)}`, 3, 60_000);
    if (!rl.allowed) return json({ error: "rate_limited", message: "Please wait a minute before sending another test." }, 429, { "retry-after": String(rl.retryAfterSec) });
    const settings = await loadSettings(got.db);
    const out = await sendTestEmail(got.db, settings.emailRecipient);
    return json(out, out.ok ? 200 : 502);
  } catch (e) {
    return internalError(e);
  }
}
