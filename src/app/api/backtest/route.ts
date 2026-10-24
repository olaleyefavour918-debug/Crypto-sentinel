import { json, requireAdmin } from "@/lib/auth";
import { internalError, withDb } from "@/lib/api";
import { SYMBOL_RE, fetchKlines, sanitizeError } from "@/lib/bybit";
import { runBacktest, type BacktestResult } from "@/lib/directional";
import { closedCandles } from "@/lib/rules";
import { listAssets, loadSettings } from "@/lib/store";
import { INTERVAL_MS } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const cache = new Map<string, { at: number; result: BacktestResult }>();
const TTL_MS = 15 * 60_000;

/** Walk-forward replay of the LONG/SHORT rules over the latest ~1000 hourly candles of one monitored coin. */
export async function GET(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  try {
    const symbol = (new URL(req.url).searchParams.get("symbol") ?? "").toUpperCase();
    if (!SYMBOL_RE.test(symbol)) return json({ error: "invalid_symbol", message: "Symbol must look like BTCUSDT." }, 400);
    const got = await withDb();
    if (got.res) return got.res;
    const assets = await listAssets(got.db);
    if (!assets.some((a) => a.symbol === symbol)) return json({ error: "unknown_symbol", message: `${symbol} is not in your coin list.` }, 404);
    const settings = await loadSettings(got.db);
    const key = `${symbol}:${JSON.stringify([settings.emaFast, settings.emaSlow, settings.rsiPeriod, settings.macdFast, settings.macdSlow, settings.macdSignal, settings.atrPeriod, settings.feeRatePct, settings.slippagePct, settings.minRiskReward])}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return json({ ok: true, cached: true, result: hit.result });
    let result: BacktestResult;
    try {
      const [h1, h4] = await Promise.all([fetchKlines(symbol, "60", 1000), fetchKlines(symbol, "240", 1000)]);
      const now = Date.now();
      result = runBacktest({ symbol, h1: closedCandles(h1, INTERVAL_MS["60"], now), h4: closedCandles(h4, INTERVAL_MS["240"], now), settings });
    } catch (e) {
      return json({ ok: false, error: "market_data_unavailable", message: `Could not fetch historical candles: ${sanitizeError(e)}` }, 502);
    }
    cache.set(key, { at: Date.now(), result });
    return json({ ok: true, cached: false, result });
  } catch (e) {
    return internalError(e);
  }
}
