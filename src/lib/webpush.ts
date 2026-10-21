import { createECDH, createCipheriv, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from "node:crypto";
import type { Db, Queryable, Row } from "./db";
import { logger } from "./logger";
import { baseOf, fmtPrice, pairLabel } from "./format";
import { getKv } from "./store";

/**
 * Web Push (RFC 8030 + VAPID RFC 8292 + message encryption RFC 8291 "aes128gcm"), implemented with node:crypto only.
 * No third-party service: the browser's own push service (Google/Mozilla/Apple) carries the encrypted message.
 * The VAPID key pair is generated on first use and stored in the database (kv), so no environment variable is needed.
 */

const b64u = (b: Buffer) => b.toString("base64url");
const fromB64u = (s: string) => Buffer.from(s, "base64url");

export interface PushSubscriptionRow { id: number; endpoint: string; p256dh: string; auth: string }
export interface PushPayload { title: string; body: string; tag: string; url: string }
export interface PushDeps { fetchFn?: typeof fetch; now?: () => number }

interface VapidKeys { publicKey: string; privateJwk: { kty: string; crv: string; x: string; y: string; d: string } }

/** Allowed push-service hosts (stops the server being used to call arbitrary URLs). */
const ALLOWED_HOST_SUFFIXES = ["googleapis.com", "mozilla.com", "push.apple.com", "windows.com", "notify.windows.com"];
export function validEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== "https:" || endpoint.length > 1000) return false;
    return ALLOWED_HOST_SUFFIXES.some((s) => u.hostname === s || u.hostname.endsWith(`.${s}`));
  } catch {
    return false;
  }
}
export function validKeys(p256dh: string, auth: string): boolean {
  try {
    const k = fromB64u(p256dh);
    return k.length === 65 && k[0] === 4 && fromB64u(auth).length === 16;
  } catch {
    return false;
  }
}

export async function getVapid(q: Queryable): Promise<VapidKeys> {
  const existing = await getKv<VapidKeys>(q, "vapid");
  if (existing?.publicKey && existing.privateJwk?.d) return existing;
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" }) as VapidKeys["privateJwk"];
  const publicKey = b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]));
  const keys: VapidKeys = { publicKey, privateJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d } };
  // Concurrent first-use race: keep whichever row wins.
  await q.query("insert into kv (key, value, updated_at) values ('vapid', $1::jsonb, now()) on conflict (key) do nothing", [JSON.stringify(keys)]);
  return (await getKv<VapidKeys>(q, "vapid")) ?? keys;
}

export function vapidAuthHeader(keys: VapidKeys, endpoint: string, nowMs: number, subject = "mailto:alerts@crypto-sentinel.invalid"): string {
  const aud = new URL(endpoint).origin;
  const head = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject })));
  const data = `${head}.${claims}`;
  const key = createPrivateKey({ key: keys.privateJwk, format: "jwk" });
  const sig = sign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${data}.${b64u(sig)}, k=${keys.publicKey}`;
}

/** RFC 8291 aes128gcm encryption. `fixed` is for the RFC test vector only. */
export function encryptPayload(
  plaintext: Buffer,
  uaPublic: Buffer,
  authSecret: Buffer,
  fixed?: { asPrivate: Buffer; salt: Buffer },
): Buffer {
  const ecdh = createECDH("prime256v1");
  if (fixed) ecdh.setPrivateKey(fixed.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, authSecret, keyInfo, 32));
  const salt = fixed?.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

export type PushSendResult = { ok: true } | { ok: false; gone: boolean; retryable: boolean; error: string };

export async function sendPush(keys: VapidKeys, sub: PushSubscriptionRow, payload: PushPayload, deps: PushDeps = {}): Promise<PushSendResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = (deps.now ?? Date.now)();
  try {
    if (!validEndpoint(sub.endpoint) || !validKeys(sub.p256dh, sub.auth)) return { ok: false, gone: true, retryable: false, error: "invalid subscription" };
    const body = encryptPayload(Buffer.from(JSON.stringify(payload)), fromB64u(sub.p256dh), fromB64u(sub.auth));
    const res = await fetchFn(sub.endpoint, {
      method: "POST",
      headers: {
        authorization: vapidAuthHeader(keys, sub.endpoint, now),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: "3600",
        urgency: "high",
      },
      body,
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status >= 200 && res.status < 300) return { ok: true };
    if (res.status === 404 || res.status === 410) return { ok: false, gone: true, retryable: false, error: `push service says subscription expired (${res.status})` };
    return { ok: false, gone: false, retryable: res.status === 429 || res.status >= 500, error: `push service HTTP ${res.status}` };
  } catch (e) {
    const name = (e as { name?: string })?.name;
    return { ok: false, gone: false, retryable: true, error: name === "TimeoutError" || name === "AbortError" ? "push service timed out" : "network error contacting push service" };
  }
}

export async function listSubscriptions(q: Queryable): Promise<PushSubscriptionRow[]> {
  const r = await q.query<Row>("select id, endpoint, p256dh, auth from push_subscriptions order by id");
  return r.rows.map((x) => ({ id: Number(x.id), endpoint: String(x.endpoint), p256dh: String(x.p256dh), auth: String(x.auth) }));
}

/** Sends to every subscribed device; removes expired subscriptions. Returns how many devices accepted. */
export async function pushToAll(db: Db, payload: PushPayload, deps: PushDeps = {}): Promise<{ sent: number; failed: number; removed: number; errors: string[] }> {
  const subs = await listSubscriptions(db);
  if (!subs.length) return { sent: 0, failed: 0, removed: 0, errors: [] };
  const keys = await getVapid(db);
  let sent = 0, failed = 0, removed = 0;
  const errors: string[] = [];
  for (const s of subs) {
    const r = await sendPush(keys, s, payload, deps);
    if (r.ok) {
      sent++;
      await db.query("update push_subscriptions set last_success_at = now(), last_error = null, failures = 0 where id = $1", [s.id]);
    } else if (r.gone) {
      removed++;
      await db.query("delete from push_subscriptions where id = $1", [s.id]);
    } else {
      failed++;
      errors.push(r.error);
      await db.query("update push_subscriptions set last_error = $2, failures = failures + 1 where id = $1", [s.id, r.error]);
    }
  }
  return { sent, failed, removed, errors };
}

export function tradePushPayload(t: { symbol: string; type: string; price: number; netPnl: number | null }): PushPayload {
  const pair = pairLabel(t.symbol);
  if (t.type === "BUY") {
    return { title: `BUY signal · ${pair}`, body: `Paper BUY at ${fmtPrice(t.price)} USDT. Review the chart and decide for yourself. No real order was placed.`, tag: `trade-${t.symbol}-BUY`, url: "/" };
  }
  const pnl = t.netPnl === null ? "" : ` · net ${t.netPnl >= 0 ? "+" : "−"}${Math.abs(t.netPnl).toFixed(2)} USDT`;
  return { title: `SELL signal · ${pair}`, body: `Paper position in ${baseOf(t.symbol)} closed at ${fmtPrice(t.price)} USDT${pnl}. No real order was placed.`, tag: `trade-${t.symbol}-SELL`, url: "/" };
}

const PUSH_MAX_AGE_MS = 60 * 60_000;

/**
 * Pushes trade events that have not been pushed yet. Each trade is claimed atomically, so a trade is pushed at most
 * once even if monitor runs overlap. Trades older than an hour are never pushed (a stale alert is misleading).
 */
export async function pushNewTrades(db: Db, deps: PushDeps = {}): Promise<{ trades: number; sent: number; failed: number }> {
  const now = (deps.now ?? Date.now)();
  const cutoff = new Date(now - PUSH_MAX_AGE_MS).toISOString();
  const claimed = await db.query<Row>(
    `update paper_trades set push_sent_at = now()
       where id in (select id from paper_trades where push_sent_at is null and occurred_at >= $1::timestamptz order by id limit 20)
         and push_sent_at is null
       returning symbol, event_type, price, net_pnl`,
    [cutoff],
  );
  await db.query("update paper_trades set push_sent_at = now() where push_sent_at is null and occurred_at < $1::timestamptz", [cutoff]);
  let sent = 0, failed = 0;
  for (const r of claimed.rows) {
    const out = await pushToAll(db, tradePushPayload({ symbol: String(r.symbol), type: String(r.event_type), price: Number(r.price), netPnl: r.net_pnl === null ? null : Number(r.net_pnl) }), deps);
    sent += out.sent;
    failed += out.failed;
    if (out.failed) logger.warn("push.failed", { errors: out.errors });
  }
  return { trades: claimed.rows.length, sent, failed };
}

