import { json, requireAdmin } from "@/lib/auth";
import { internalError, withDb } from "@/lib/api";
import { directionalSummary } from "@/lib/directional-run";
import { emailConfig } from "@/lib/email";
import { assessMonitor, configStatus } from "@/lib/health";
import {
  getAccount, getKv, lastSignals, latestEvaluations, listAssets, listNotifications, listOpenPositions, listTrades,
  loadSettings, recentJobRuns, tradeStats,
} from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const denied = requireAdmin(req);
  if (denied) {
    // While ADMIN_PASSWORD is missing the app is in setup mode; show which pieces are missing (booleans only).
    if (!process.env.ADMIN_PASSWORD) return json({ error: "setup_required", config: configStatus() }, 503);
    return denied;
  }
  try {
    const got = await withDb();
    if (got.res) {
      const body = await got.res.json();
      return json({ ...body, config: configStatus() }, got.res.status);
    }
    const db = got.db;
    const now = Date.now();
    const settings = await loadSettings(db);
    const [account, assets, positions, trades, notifications, evaluations, signals, jobRuns, marketApi, stats, directional] = await Promise.all([
      getAccount(db), listAssets(db), listOpenPositions(db), listTrades(db, 100), listNotifications(db, 15), latestEvaluations(db),
      lastSignals(db), recentJobRuns(db, 30), getKv(db, "market_api"), tradeStats(db), directionalSummary(db),
    ]);
    const cfg = emailConfig();
    return json({
      now,
      config: configStatus(),
      settings,
      account,
      assets,
      positions,
      stats,
      directional,
      trades,
      notifications,
      evaluations,
      lastSignals: signals,
      marketApi,
      jobRuns: jobRuns.slice(0, 12),
      monitor: assessMonitor(jobRuns, now, settings),
      email: { provider: cfg.provider, configured: cfg.configured, issue: cfg.issue, deliveryConfirmation: cfg.provider === "resend" && cfg.webhookConfigured, recipient: settings.emailRecipient },
      database: "ok",
    });
  } catch (e) {
    return internalError(e);
  }
}
