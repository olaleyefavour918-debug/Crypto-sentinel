import { json, requireAdmin } from "@/lib/auth";
import { internalError, withDb } from "@/lib/api";
import { getVapid, listSubscriptions } from "@/lib/webpush";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Public VAPID key (safe to expose) + how many devices are subscribed. */
export async function GET(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  try {
    const got = await withDb();
    if (got.res) return got.res;
    const keys = await getVapid(got.db);
    const subs = await listSubscriptions(got.db);
    return json({ publicKey: keys.publicKey, devices: subs.length });
  } catch (e) {
    return internalError(e);
  }
}
