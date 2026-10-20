import { json } from "@/lib/auth";
import { internalError, withDb } from "@/lib/api";
import { applyDeliveryEvent, verifySvixSignature } from "@/lib/email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Optional: lets Resend confirm "delivered"/"bounced". Requests are accepted only with a valid Svix signature. */
export async function POST(req: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return json({ error: "not_configured" }, 404);
  try {
    const body = await req.text();
    if (body.length > 100_000) return json({ error: "too_large" }, 413);
    const ok = verifySvixSignature({
      secret,
      id: req.headers.get("svix-id"),
      timestamp: req.headers.get("svix-timestamp"),
      signature: req.headers.get("svix-signature"),
      body,
    });
    if (!ok) return json({ error: "invalid_signature" }, 401);
    const event = JSON.parse(body) as { type?: string; data?: { email_id?: string } };
    const got = await withDb();
    if (got.res) return got.res;
    if (event.type && event.data?.email_id) await applyDeliveryEvent(got.db, event.type, event.data.email_id);
    return json({ ok: true });
  } catch (e) {
    return internalError(e);
  }
}
