/**
 * Read-only audit of the signal engine. Changes nothing, places no orders, touches no database.
 *   npx tsx --tsconfig tests/tsconfig.json scripts/audit/run.ts --source binance --days 150 --out audit-out
 *   npx tsx --tsconfig tests/tsconfig.json scripts/audit/run.ts --source synthetic --days 40 --symbols BTCUSDT,ETHUSDT   (code check only)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { rng } from "@/lib/setups-backtest";
import type { Candle } from "@/lib/types";
import { DAY, buildCtx, type Ctx } from "./ctx";
import { fetch5m, synthetic, type Source } from "./data";
import { bounceSection, exitSection } from "./sec-bounce";
import { dataSection, qualitySection } from "./sec-quality";
import { trendSection, type Period } from "./sec-trend";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const source = arg("source", "binance") as Source | "synthetic";
const days = Number(arg("days", "150"));
const symbols = arg("symbols", "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,BNBUSDT,DOGEUSDT,ADAUSDT,LINKUSDT").split(",");
const out = arg("out", "audit-out");

async function main() {
  const endMs = Math.floor(Date.now() / DAY) * DAY;
  const startMs = endMs - days * DAY;
  const P: Period = { startMs, endMs, splitMs: startMs + 0.6 * (endMs - startMs) };
  const from = startMs - 40 * DAY - 3 * DAY;
  const raw = new Map<string, Candle[]>();
  for (const [i, s] of symbols.entries()) {
    raw.set(s, source === "synthetic" ? synthetic(i, from, endMs, rng(500 + i)) : await fetch5m(source, s, from, endMs));
    console.error(`${s}: ${raw.get(s)?.length} candles`);
  }
  const btc = raw.get("BTCUSDT") ?? null;
  const ctxs: Ctx[] = [];
  for (const s of symbols) {
    const t0 = Date.now();
    ctxs.push(buildCtx(s, raw.get(s) as Candle[], s === "BTCUSDT" ? null : btc, startMs - 3 * DAY, endMs, DEFAULT_SETTINGS));
    console.error(`${s}: ${ctxs[ctxs.length - 1].hours.length} hourly evaluations in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  const label = source === "synthetic" ? "SYNTHETIC RANDOM DATA: this only checks that the audit code runs and says NOTHING about the strategies" : source === "bybit" ? "Bybit public spot 5-minute candles (api.bybit.com)" : "Binance public spot 5-minute candles (data-api.binance.vision), a proxy for Bybit";
  const L: string[] = [`# Signal-engine audit (read-only)`, `Data: ${label}`, `Replay window ${new Date(startMs).toISOString().slice(0, 10)} → ${new Date(endMs).toISOString().slice(0, 10)}; in-sample ends ${new Date(P.splitMs).toISOString().slice(0, 10)}. Coins: ${symbols.join(", ")}. Decisions use the live monitor's 200-candle windows. Nothing here was tuned; it is a diagnosis.`, ""];
  L.push("## 1. Trend BUY", "", ...trendSection(ctxs, P), "");
  L.push("## 2. Support-Bounce", "", ...bounceSection(ctxs, P), "");
  L.push("## 3. Exit warning", "", ...exitSection(ctxs, P), "");
  L.push("## 4. Data source", "");
  if (source === "synthetic") L.push("Skipped in synthetic mode.");
  else { const d = await dataSection(P, symbols, source, raw); L.push(...d.lines); }
  L.push("", "## 5. Back-test quality", "", ...qualitySection(ctxs, P, btc, raw));
  mkdirSync(out, { recursive: true });
  const text = L.join("\n");
  writeFileSync(`${out}/audit-${source}.md`, text);
  console.log(text);
}
main().catch((e) => { console.error(String(e && (e as Error).stack ? (e as Error).stack : e)); process.exit(1); });
