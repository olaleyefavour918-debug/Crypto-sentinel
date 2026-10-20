/**
 * Pure view-model helpers for the dashboard (no React, no I/O) so the wording the user relies on is unit-tested.
 * Honesty rules encoded here: "accepted" is never shown as "delivered"; a monitor is only "active" if runs are
 * actually arriving; unrealized P/L is only shown when a recent price exists.
 */
import type { MonitorState } from "./health";
import { unrealized } from "./paper";
import type { Account, Asset, Position, TradeEvent } from "./store";

export type Tone = "good" | "warn" | "bad" | "neutral";

export function notificationLabel(status: string): { label: string; tone: Tone; explain: string } {
  switch (status) {
    case "queued": return { label: "Queued", tone: "neutral", explain: "Stored; will be handed to the email provider on the next monitor run." };
    case "sending": return { label: "Sending", tone: "neutral", explain: "Being handed to the email provider right now." };
    case "accepted": return { label: "Accepted by provider", tone: "warn", explain: "The provider accepted the message. This is NOT proof it reached the inbox — check your inbox and spam folder." };
    case "delivered": return { label: "Delivered (confirmed)", tone: "good", explain: "The provider confirmed delivery to the recipient's mail server." };
    case "bounced": return { label: "Bounced", tone: "bad", explain: "The provider reported a bounce or spam complaint." };
    case "failed": return { label: "Failed", tone: "bad", explain: "Could not be sent. It is retried automatically a few times; see the error." };
    case "skipped": return { label: "Skipped (alerts off)", tone: "neutral", explain: "Email alerts for this event type are turned off in Settings." };
    default: return { label: status, tone: "neutral", explain: "" };
  }
}

export function monitorBadge(state: MonitorState): { label: string; tone: Tone } {
  switch (state) {
    case "active": return { label: "Monitor running", tone: "good" };
    case "slow": return { label: "Monitor slow", tone: "warn" };
    case "failing": return { label: "Data unavailable", tone: "bad" };
    case "stopped": return { label: "Monitor stopped", tone: "bad" };
    default: return { label: "Not started", tone: "warn" };
  }
}

export function evalBadge(status: string | null): { label: string; tone: Tone } {
  switch (status) {
    case "SIGNAL": return { label: "BUY conditions met", tone: "good" };
    case "NO_SIGNAL": return { label: "No signal", tone: "neutral" };
    case "DATA_INVALID": return { label: "Data not usable", tone: "warn" };
    default: return { label: "Not evaluated yet", tone: "neutral" };
  }
}

export interface Marker { time: number; kind: "BUY" | "SELL"; text: string }

/** Aligns simulated BUY/SELL events to the candle they happened in; events outside the plotted range are dropped. */
export function buildMarkers(trades: TradeEvent[], symbol: string, candleTimes: number[], intervalSec: number): Marker[] {
  if (candleTimes.length === 0) return [];
  const set = new Set(candleTimes);
  const out: Marker[] = [];
  for (const t of trades) {
    if (t.symbol !== symbol) continue;
    const bucket = Math.floor(t.occurredAt / 1000 / intervalSec) * intervalSec;
    if (!set.has(bucket)) continue;
    out.push({ time: bucket, kind: t.type, text: t.type });
  }
  return out.sort((a, b) => a.time - b.time);
}

export interface PositionRow {
  position: Position;
  price: number | null;
  priceAgeMs: number | null;
  unrealizedNet: number | null;
  unrealizedGross: number | null;
  unrealizedPct: number | null;
}

export interface PortfolioView {
  rows: PositionRow[];
  reserved: number;
  unrealizedNet: number;
  realizedNet: number;
  equity: number;
  stalePrices: boolean;
}

/** A price older than this is shown with a warning and not used for unrealized P/L. */
export const PRICE_MAX_AGE_MS = 10 * 60_000;

export function portfolioView(account: Account, positions: Position[], assets: Asset[], realizedNet: number, now: number, feeFallbackPct = 0.1): PortfolioView {
  const bySymbol = new Map(assets.map((a) => [a.symbol, a]));
  let reserved = 0;
  let unrealizedNet = 0;
  let stale = false;
  const rows = positions.map((p): PositionRow => {
    reserved += p.amountUsdt;
    const a = bySymbol.get(p.symbol);
    const price = a?.lastPrice ?? null;
    const age = a?.lastOkAt != null ? now - a.lastOkAt : null;
    const fresh = price !== null && age !== null && age <= PRICE_MAX_AGE_MS;
    if (!fresh) stale = true;
    if (!fresh || price === null) return { position: p, price, priceAgeMs: age, unrealizedNet: null, unrealizedGross: null, unrealizedPct: null };
    const u = unrealized({ amountUsdt: p.amountUsdt, entryPrice: p.entryPrice, quantity: p.quantity, feeRatePct: p.feeRatePct ?? feeFallbackPct, currentPrice: price });
    unrealizedNet += u.netPnl;
    return { position: p, price, priceAgeMs: age, unrealizedNet: u.netPnl, unrealizedGross: u.grossPnl, unrealizedPct: u.netPct };
  });
  return { rows, reserved, unrealizedNet, realizedNet, equity: account.availableBalance + reserved + unrealizedNet, stalePrices: stale };
}

export interface SetupStep { id: string; done: boolean; title: string; detail: string }

/** What still needs configuring, in plain English, derived from booleans only. */
export function setupChecklist(cfg: { database: boolean; adminPassword: boolean; cronSecret: boolean; emailConfigured: boolean; emailIssue: string | null }, monitorState: MonitorState | null): SetupStep[] {
  return [
    { id: "database", done: cfg.database, title: "Database connected", detail: "Add a Postgres database on Vercel (Storage → Neon). DATABASE_URL is injected automatically." },
    { id: "password", done: cfg.adminPassword, title: "Dashboard password set", detail: "Add ADMIN_PASSWORD (you choose it) in Vercel → Settings → Environment Variables, then redeploy." },
    { id: "cron", done: cfg.cronSecret, title: "Scheduler secret set", detail: "Add CRON_SECRET (32+ random characters). Vercel Cron and external schedulers use it to call /api/cron/monitor." },
    { id: "email", done: cfg.emailConfigured, title: "Email provider connected", detail: cfg.emailIssue ?? "Add SMTP_USER + SMTP_PASS (Gmail App Password), or RESEND_API_KEY, or BREVO_API_KEY + EMAIL_FROM." },
    { id: "monitor", done: monitorState === "active" || monitorState === "slow", title: "Monitor is receiving scheduled runs", detail: "Create a 1-minute scheduler (cron-job.org or Vercel Pro). Vercel Hobby cron only runs once a day." },
  ];
}
