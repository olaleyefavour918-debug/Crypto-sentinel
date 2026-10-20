import { BybitError, fetchInstrument, sanitizeError } from "@/lib/bybit";
import { clientIp, json, requireAdminMutation } from "@/lib/auth";
import { internalError, readJson, withDb } from "@/lib/api";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/ratelimit";
import { addAsset, listAssets, MAX_ASSETS, removeAsset, setAssetEnabled } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const BASE_RE = /^[A-Z0-9]{2,10}$/;
const SYMBOL_RE = /^[A-Z0-9]{2,12}USDT$/;

/** Add a coin: POST { "base": "DOGE" }. Verified against Bybit's public instrument list before it is stored. */
export async function POST(req: Request) {
  const denied = requireAdminMutation(req);
  if (denied) return denied;
  try {
    const got = await withDb();
    if (got.res) return got.res;
    const rl = await rateLimit(got.db, `assets:${clientIp(req)}`, 20, 60_000);
    if (!rl.allowed) return json({ error: "rate_limited" }, 429, { "retry-after": String(rl.retryAfterSec) });
    const body = (await readJson(req, 1024)) as { base?: unknown } | undefined;
    const raw = typeof body?.base === "string" ? body.base.trim().toUpperCase().replace(/(\/)?USDT$/, "") : "";
    if (!BASE_RE.test(raw)) return json({ error: "validation_failed", message: "Enter a coin ticker such as DOGE or ADA (letters/digits, 2–10 characters)." }, 400);
    const symbol = `${raw}USDT`;
    const existing = await listAssets(got.db);
    if (existing.some((a) => a.symbol === symbol)) return json({ error: "already_exists", message: `${raw} is already in your list.` }, 409);
    if (existing.length >= MAX_ASSETS) return json({ error: "limit_reached", message: `At most ${MAX_ASSETS} coins can be monitored (exchange rate limits and the 60 s run budget).` }, 400);
    let info;
    try {
      info = await fetchInstrument(symbol);
    } catch (e) {
      const msg = e instanceof BybitError && e.kind === "blocked" ? e.message : "Could not reach Bybit to verify this coin. Nothing was added; try again shortly.";
      logger.warn("assets.verify_failed", { symbol, error: sanitizeError(e) });
      return json({ error: "exchange_unreachable", message: msg }, 502);
    }
    if (!info) return json({ error: "not_listed", message: `${symbol} is not listed on Bybit spot.` }, 404);
    if (!info.trading) return json({ error: "not_trading", message: `${symbol} exists on Bybit but is not currently trading.` }, 409);
    const added = await addAsset(got.db, symbol, raw);
    if (!added) return json({ error: "already_exists", message: `${raw} is already in your list.` }, 409);
    logger.info("assets.added", { symbol });
    return json({ ok: true, assets: await listAssets(got.db) }, 201);
  } catch (e) {
    return internalError(e);
  }
}

/** Pause / resume a coin: PATCH { "symbol": "ETHUSDT", "enabled": false }. Open positions are still managed while paused. */
export async function PATCH(req: Request) {
  const denied = requireAdminMutation(req);
  if (denied) return denied;
  try {
    const got = await withDb();
    if (got.res) return got.res;
    const body = (await readJson(req, 1024)) as { symbol?: unknown; enabled?: unknown } | undefined;
    if (!body || typeof body.symbol !== "string" || !SYMBOL_RE.test(body.symbol) || typeof body.enabled !== "boolean") {
      return json({ error: "validation_failed", message: "Expected { symbol, enabled }." }, 400);
    }
    const ok = await setAssetEnabled(got.db, body.symbol, body.enabled);
    if (!ok) return json({ error: "not_found" }, 404);
    logger.info("assets.toggled", { symbol: body.symbol, enabled: body.enabled });
    return json({ ok: true, assets: await listAssets(got.db) });
  } catch (e) {
    return internalError(e);
  }
}

/** Remove a coin: DELETE { "symbol": "ETHUSDT" }. Refused while a simulated position is open. History is kept. */
export async function DELETE(req: Request) {
  const denied = requireAdminMutation(req);
  if (denied) return denied;
  try {
    const got = await withDb();
    if (got.res) return got.res;
    const body = (await readJson(req, 1024)) as { symbol?: unknown } | undefined;
    if (!body || typeof body.symbol !== "string" || !SYMBOL_RE.test(body.symbol)) {
      return json({ error: "validation_failed", message: "Expected { symbol }." }, 400);
    }
    const result = await removeAsset(got.db, body.symbol);
    if (result === "not_found") return json({ error: "not_found" }, 404);
    if (result === "has_open_position") {
      return json({ error: "has_open_position", message: `${body.symbol} has an open simulated position. Pause it instead; it will keep being monitored for its exit, and you can remove it afterwards.` }, 409);
    }
    logger.info("assets.removed", { symbol: body.symbol });
    return json({ ok: true, assets: await listAssets(got.db) });
  } catch (e) {
    return internalError(e);
  }
}
