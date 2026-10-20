import { json, requireAdmin } from "@/lib/auth";
import { internalError, withDb } from "@/lib/api";
import { SYMBOL_RE } from "@/lib/bybit";
import { buildMarketView, type MarketView } from "@/lib/marketview";
import { listAssets, loadSettings } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const cache = new Map<string, { at: number; view: MarketView }>();
const TTL_MS = 10_000;

/**
 * Live public market data for one monitored coin: GET /api/market?symbol=ETHUSDT
 * (10 s in-memory cache per coin per instance to respect exchange rate limits).
 */
export async function GET(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  try {
    const symbol = (new URL(req.url).searchParams.get("symbol") ?? "BTCUSDT").toUpperCase();
    if (!SYMBOL_RE.test(symbol)) return json({ error: "invalid_symbol", message: "Symbol must look like BTCUSDT." }, 400);
    const hit = cache.get(symbol);
    if (hit && Date.now() - hit.at < TTL_MS) return json(hit.view, hit.view.ok ? 200 : 502);
    const got = await withDb();
    if (got.res) return got.res;
    // Only monitored coins can be queried — the endpoint is not an open proxy to the exchange.
    const assets = await listAssets(got.db);
    if (!assets.some((a) => a.symbol === symbol)) return json({ error: "unknown_symbol", message: `${symbol} is not in your coin list.` }, 404);
    const settings = await loadSettings(got.db);
    const view = await buildMarketView(symbol, settings);
    if (view.ok) cache.set(symbol, { at: Date.now(), view });
    return json(view, view.ok ? 200 : 502);
  } catch (e) {
    return internalError(e);
  }
}
