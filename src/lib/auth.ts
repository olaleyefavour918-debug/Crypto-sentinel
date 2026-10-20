import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Access protection.
 *  • Dashboard + admin APIs: a single admin password (env ADMIN_PASSWORD, chosen by you; there is NO default) →
 *    signed, HttpOnly, SameSite=Strict session cookie.
 *  • Scheduler endpoint: Bearer token (env CRON_SECRET). Vercel Cron attaches it automatically.
 * If either secret is missing, the corresponding endpoints refuse to work (fail closed) instead of falling open.
 */

export const SESSION_COOKIE = "bs_session";
export const SESSION_TTL_MS = 7 * 24 * 3600_000;

type Env = Record<string, string | undefined>;

export function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function sessionSecret(env: Env): string | null {
  if (env.SESSION_SECRET && env.SESSION_SECRET.length >= 16) return env.SESSION_SECRET;
  if (env.ADMIN_PASSWORD) return createHmac("sha256", "btc-sentinel/session/v1").update(env.ADMIN_PASSWORD).digest("hex");
  return null;
}

const b64u = (s: string) => Buffer.from(s, "utf8").toString("base64url");

export function signSession(env: Env, now: number = Date.now(), ttlMs = SESSION_TTL_MS): string {
  const secret = sessionSecret(env);
  if (!secret) throw new Error("ADMIN_PASSWORD is not configured");
  const payload = b64u(JSON.stringify({ v: 1, exp: now + ttlMs, jti: randomUUID() }));
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySession(env: Env, token: string | null | undefined, now: number = Date.now()): boolean {
  const secret = sessionSecret(env);
  if (!secret || !token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!constantTimeEquals(sig, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { v?: number; exp?: number };
    return data.v === 1 && typeof data.exp === "number" && data.exp > now;
  } catch {
    return false;
  }
}

export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

export function sessionCookie(token: string, secure: boolean, maxAgeSec = SESSION_TTL_MS / 1000): string {
  return [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSec}`, secure ? "Secure" : ""]
    .filter(Boolean)
    .join("; ");
}

export function clearedSessionCookie(secure: boolean): string {
  return sessionCookie("", secure, 0);
}

export function isSecureRequest(req: Request): boolean {
  return new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
}

export function clientIp(req: Request): string {
  const xf = req.headers.get("x-forwarded-for");
  const ip = (xf ? xf.split(",")[0] : req.headers.get("x-real-ip")) ?? "unknown";
  return ip.trim().slice(0, 64) || "unknown";
}

/** Rejects cross-site browser requests. Requests without an Origin header (curl, server-to-server) are allowed. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return req.headers.get("sec-fetch-site") !== "cross-site";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function hasAdminSession(req: Request, env: Env = process.env): boolean {
  return verifySession(env, parseCookie(req.headers.get("cookie"), SESSION_COOKIE));
}

/** Returns a Response to send back when access is denied, or null when the caller is an authenticated admin. */
export function requireAdmin(req: Request, env: Env = process.env): Response | null {
  if (!env.ADMIN_PASSWORD) {
    return json({ error: "setup_required", message: "ADMIN_PASSWORD is not set. Add it in your hosting environment variables (see README)." }, 503);
  }
  return hasAdminSession(req, env) ? null : json({ error: "unauthorized", message: "Sign in required." }, 401);
}

/** For mutating admin endpoints: admin session AND same-origin AND JSON content type. */
export function requireAdminMutation(req: Request, env: Env = process.env): Response | null {
  const denied = requireAdmin(req, env);
  if (denied) return denied;
  if (!sameOrigin(req)) return json({ error: "forbidden", message: "Cross-origin request rejected." }, 403);
  return null;
}

export function requireCron(req: Request, env: Env = process.env): Response | null {
  const secret = env.CRON_SECRET;
  if (!secret || secret.length < 16) {
    return json({ error: "setup_required", message: "CRON_SECRET is not set (16+ characters required). The monitor endpoint is disabled until it is." }, 503);
  }
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return token && constantTimeEquals(token, secret) ? null : json({ error: "unauthorized" }, 401);
}

export function checkAdminPassword(input: unknown, env: Env = process.env): boolean {
  return typeof input === "string" && input.length > 0 && input.length <= 200 && !!env.ADMIN_PASSWORD && constantTimeEquals(input, env.ADMIN_PASSWORD);
}
