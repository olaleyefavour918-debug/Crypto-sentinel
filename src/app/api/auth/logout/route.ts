import { clearedSessionCookie, isSecureRequest, json, sameOrigin } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "forbidden" }, 403);
  return json({ ok: true }, 200, { "set-cookie": clearedSessionCookie(isSecureRequest(req)) });
}
