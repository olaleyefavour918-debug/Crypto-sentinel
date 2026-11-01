/** Read-only probe: can real Bybit history be obtained from this machine, and how big is it? */
import { gunzipSync } from "node:zlib";
import { defaultBaseUrls } from "@/lib/bybit";
import { M5 } from "@/lib/setups-backtest";
import type { Candle } from "@/lib/types";
import { fetchKlines, probe } from "./data";

const links = (html: string): string[] => [...html.matchAll(/href="([^"?#]+)"/g)].map((m) => m[1]).filter((x) => !x.startsWith("/") && !x.startsWith("http"));
async function list(url: string): Promise<{ status: string; items: string[] }> {
  try { const r = await fetch(url); const t = await r.text(); return { status: `HTTP ${r.status}`, items: links(t) }; } catch (e) { return { status: `unreachable: ${String(e)}`, items: [] }; }
}

async function main() {
  console.log("# Bybit data-access probe");
  console.log("\n## API hosts (the app's own list first)");
  const hosts = [...new Set([...defaultBaseUrls(), "https://api.bybit.com", "https://api.bytick.com", "https://api.bybit.nl", "https://api.bybit-tr.com", "https://api.bybit.kz"])];
  for (const h of hosts) console.log(`- ${h}: ${(await probe(`${h}/v5/market/kline?category=spot&symbol=BTCUSDT&interval=60&limit=2`)).slice(0, 160)}`);
  console.log(`- Binance for comparison: ${(await probe("https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=2")).slice(0, 160)}`);

  console.log("\n## public.bybit.com directory listings");
  for (const path of ["", "spot/", "spot/BTCUSDT/", "spot/DOGEUSDT/", "trading/BTCUSDT/", "kline_for_metatrader4/", "kline_for_metatrader4/BTCUSDT/"]) {
    const l = await list(`https://public.bybit.com/${path}`);
    console.log(`- /${path}: ${l.status}, ${l.items.length} entries${l.items.length ? `, first ${l.items.slice(0, 3).join(", ")}, last ${l.items.slice(-3).join(", ")}` : ""}`);
  }

  console.log("\n## One day of real Bybit SPOT trades");
  const spot = await list("https://public.bybit.com/spot/BTCUSDT/");
  const files = spot.items.filter((f) => f.endsWith(".csv.gz"));
  if (!files.length) { console.log("No spot trade files listed, so this route is not available."); return; }
  const pick = files[files.length - 3];
  const day = pick.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
  console.log(`Spot files listed: ${files.length}, from ${files[0]} to ${files[files.length - 1]}. Testing ${pick}.`);
  for (const sym of ["BTCUSDT", "DOGEUSDT"]) {
    const url = `https://public.bybit.com/spot/${sym}/${sym}_${day}.csv.gz`;
    const t0 = Date.now();
    const r = await fetch(url);
    if (!r.ok) { console.log(`${sym}: HTTP ${r.status}`); continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    const text = gunzipSync(buf).toString("utf8");
    const lines = text.split("\n").filter(Boolean);
    console.log(`${sym} ${day}: ${(buf.length / 1e6).toFixed(1)} MB compressed, ${lines.length - 1} trades, downloaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`  header: ${lines[0]}`);
    console.log(`  sample: ${lines[1]}`);
    if (sym !== "BTCUSDT") continue;
    const head = lines[0].split(",").map((x) => x.trim().toLowerCase());
    const ti = head.findIndex((x) => x.includes("time")), pi = head.findIndex((x) => x === "price"), vi = head.findIndex((x) => ["volume", "size", "qty", "amount", "quantity"].includes(x));
    if (ti < 0 || pi < 0 || vi < 0) { console.log(`  could not identify columns (time ${ti}, price ${pi}, volume ${vi})`); continue; }
    const agg = new Map<number, Candle>();
    for (let i = 1; i < lines.length; i++) {
      const f = lines[i].split(",");
      let t = Number(f[ti]); if (t < 1e12) t *= 1000;
      const k = Math.floor(t / M5) * M5, p = Number(f[pi]), v = Number(f[vi]);
      if (!(p > 0)) continue;
      const c = agg.get(k);
      if (!c) agg.set(k, { start: k, open: p, high: p, low: p, close: p, volume: v, turnover: p * v, }); else { c.high = Math.max(c.high, p); c.low = Math.min(c.low, p); c.close = p; c.volume += v; c.turnover += p * v; }
    }
    const t0d = Date.parse(day + "T00:00:00Z");
    console.log(`  5-minute candles built from trades: ${agg.size} of 288 expected (trade order in file may be newest-first: open/close taken in file order)`);
    try {
      const bin = await fetchKlines("binance", "BTCUSDT", "5m", "5", M5, t0d, t0d + 86_400_000);
      const diffs: number[] = [], vr: number[] = [];
      for (const b of bin) { const a = agg.get(b.start); if (!a) continue; diffs.push(Math.abs(a.high / b.high - 1) * 100); if (b.volume > 0) vr.push(a.volume / b.volume); }
      diffs.sort((x, y) => x - y); vr.sort((x, y) => x - y);
      console.log(`  vs Binance same day: ${diffs.length} candles matched, median |high diff| ${(diffs[Math.floor(diffs.length / 2)] ?? NaN).toFixed(4)}%, median volume ratio Bybit/Binance ${(vr[Math.floor(vr.length / 2)] ?? NaN).toFixed(3)}`);
    } catch (e) { console.log(`  Binance comparison failed: ${String(e).slice(0, 120)}`); }
  }
  console.log("\n## Size estimate");
  console.log("If BTCUSDT is representative, multiply the per-day compressed size above by 190 days (150 + 40 warm-up) and by the number of coins; busier coins are larger.");
}
main().catch((e) => { console.error(String(e)); process.exit(1); });
