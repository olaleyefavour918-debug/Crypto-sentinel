/**
 * Runs the Crypto Sentinel monitor in a loop from a GitHub Actions job (no Vercel needed).
 * Each pass is the SAME runMonitor() the website's cron endpoint runs: Bybit candles/tickers, evaluation, paper trades,
 * email and push alerts. The database lease inside runMonitor prevents overlapping scans, even if another scheduler
 * (cron-job.org, Vercel cron) is also calling it.
 *
 * Usage: tsx scripts/scan-loop.ts [--minutes 345] [--every 60]
 * Env: DATABASE_URL (Neon) plus the same email variables the website uses (SMTP_*, RESEND_API_KEY, EMAIL_*).
 */
import { getDb } from "../src/lib/db";
import { runMonitor } from "../src/lib/monitor";
import { sanitizeError } from "../src/lib/bybit";

const arg = (n: string, d: number) => { const i = process.argv.indexOf(`--${n}`); const v = i >= 0 ? Number(process.argv[i + 1]) : NaN; return Number.isFinite(v) && v > 0 ? v : d; };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  const minutes = arg("minutes", 345);
  const everyMs = arg("every", 60) * 1000;
  const endAt = Date.now() + minutes * 60_000;
  const db = getDb();
  let runs = 0, failed = 0, consecutiveFailures = 0;
  console.log(`scan-loop start: every ${everyMs / 1000}s for ${minutes} min`);
  while (Date.now() + 5_000 < endAt) {
    const t0 = Date.now();
    try {
      const r = await runMonitor({ db, trigger: "cron" });
      runs++;
      if (r.status === "failed") { failed++; consecutiveFailures++; } else consecutiveFailures = 0;
      console.log(`${new Date().toISOString()} ${r.status} ${Date.now() - t0}ms`);
    } catch (e) {
      runs++; failed++; consecutiveFailures++;
      console.log(`${new Date().toISOString()} ERROR ${sanitizeError(e)}`);
    }
    // A database that stays unreachable for 10 minutes ends this run non-zero so the failure is visible in GitHub.
    if (consecutiveFailures >= 10) { console.log("10 failed scans in a row: stopping so the next run starts clean"); process.exit(1); }
    const wait = everyMs - (Date.now() - t0);
    if (wait > 0) await sleep(Math.min(wait, Math.max(0, endAt - Date.now())));
  }
  console.log(`scan-loop done: ${runs} scans, ${failed} failed`);
  process.exit(0);
}

main().catch((e) => { console.error("scan-loop crashed:", sanitizeError(e)); process.exit(1); });
