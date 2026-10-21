import { clientIp, json, requireAdminMutation } from "@/lib/auth";
import { internalError, withDb } from "@/lib/api";
import { rateLimit } from "@/lib/ratelimit";
import { pushToAll } from "@/lib/webpush";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request) {
  const denied = requireAdminMutation(req);
  if (denied) return denied;
  try {
    const got = await withDb();
    if (got.res) return got.res;
    const rl = await rateLimit(got.db, `push-test:${clientIp(req)}`, 5, 60_000);
    if (!rl.allowed) return json({ error: "rate_limited", message: "Please wait a minute before sending another test." }, 429, { "retry-after": String(rl.retryAfterSec) });
    const out = await pushToAll(got.db, { title: "Crypto Sentinel test", body: "If you can see this, phone notifications work. Nothing was traded.", tag: "test", url: "/" });
    if (out.sent === 0) {
      const message = out.failed ? `The push service did not accept it (${out.errors[0] ?? "error"}). Try again, or turn notifications off and on.` : "No device is subscribed yet. Tap “Enable notifications on this device” first.";
      return json({ ok: false, ...out, message }, out.failed ? 502 : 409);
    }
    return json({ ok: true, ...out, message: `Sent to ${out.sent} device(s). The push service accepted it. Check your phone's notifications.` });
  } catch (e) {
    return internalError(e);
  }
}
