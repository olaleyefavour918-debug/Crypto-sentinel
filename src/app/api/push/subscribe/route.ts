import { json, requireAdminMutation } from "@/lib/auth";
import { internalError, withDb } from "@/lib/api";
import { validEndpoint, validKeys } from "@/lib/webpush";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_DEVICES = 10;

export async function POST(req: Request) {
  const denied = requireAdminMutation(req);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => null)) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
    const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
    const p256dh = typeof body?.keys?.p256dh === "string" ? body.keys.p256dh : "";
    const auth = typeof body?.keys?.auth === "string" ? body.keys.auth : "";
    if (!validEndpoint(endpoint) || !validKeys(p256dh, auth)) {
      return json({ error: "invalid_subscription", message: "This browser's notification subscription was not recognised." }, 400);
    }
    const got = await withDb();
    if (got.res) return got.res;
    const count = Number((await got.db.query("select count(*)::int as n from push_subscriptions where endpoint <> $1", [endpoint])).rows[0].n);
    if (count >= MAX_DEVICES) return json({ error: "too_many_devices", message: `At most ${MAX_DEVICES} devices can receive notifications.` }, 409);
    await got.db.query(
      `insert into push_subscriptions (endpoint, p256dh, auth) values ($1, $2, $3)
       on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, failures = 0, last_error = null`,
      [endpoint, p256dh, auth],
    );
    return json({ ok: true });
  } catch (e) {
    return internalError(e);
  }
}

export async function DELETE(req: Request) {
  const denied = requireAdminMutation(req);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => null)) as { endpoint?: unknown } | null;
    const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
    if (!endpoint) return json({ error: "invalid_subscription", message: "Missing endpoint." }, 400);
    const got = await withDb();
    if (got.res) return got.res;
    await got.db.query("delete from push_subscriptions where endpoint = $1", [endpoint]);
    return json({ ok: true });
  } catch (e) {
    return internalError(e);
  }
}
