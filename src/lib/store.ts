import type { Queryable, Row } from "./db";
import { normalizeStoredSettings } from "./settings";
import { toMs } from "./time";
import type { Settings } from "./types";

/** Postgres returns numeric/bigint as strings; always coerce at the boundary. */
export const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
export const ts = (ms: number): string => new Date(ms).toISOString();

export async function loadSettings(q: Queryable): Promise<Settings> {
  const r = await q.query<Row>("select settings from app_settings where id = 1");
  const raw = r.rows[0]?.settings;
  return normalizeStoredSettings(typeof raw === "string" ? JSON.parse(raw) : raw);
}

export async function saveSettings(q: Queryable, s: Settings): Promise<void> {
  await q.query(
    "insert into app_settings (id, settings, updated_at) values (1, $1::jsonb, now()) on conflict (id) do update set settings = excluded.settings, updated_at = now()",
    [JSON.stringify(s)],
  );
}

export interface Account {
  startingBalance: number;
  availableBalance: number;
}

export async function getAccount(q: Queryable): Promise<Account> {
  const r = await q.query<Row>("select starting_balance, available_balance from paper_account where id = 1");
  const row = r.rows[0];
  return { startingBalance: Number(row.starting_balance), availableBalance: Number(row.available_balance) };
}

export interface Position {
  id: number;
  symbol: string;
  status: "open" | "closed";
  entryCandleStart: number;
  openedAt: number;
  entryPrice: number;
  amountUsdt: number;
  quantity: number;
  feeRatePct: number;
  stopLossPct: number;
  takeProfitPct: number;
  trendExitEnabled: boolean;
  entryReason: string;
  entryIndicators: unknown;
  closedAt: number | null;
  exitPrice: number | null;
  exitReason: string | null;
  grossPnl: number | null;
  entryFee: number | null;
  exitFee: number | null;
  netPnl: number | null;
}

export const json = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);

export function mapPosition(r: Row): Position {
  return {
    id: Number(r.id),
    symbol: r.symbol,
    status: r.status,
    entryCandleStart: toMs(r.entry_candle_start) as number,
    openedAt: toMs(r.opened_at) as number,
    entryPrice: Number(r.entry_price),
    amountUsdt: Number(r.amount_usdt),
    quantity: Number(r.quantity),
    feeRatePct: Number(r.fee_rate_pct),
    stopLossPct: Number(r.stop_loss_pct),
    takeProfitPct: Number(r.take_profit_pct),
    trendExitEnabled: Boolean(r.trend_exit_enabled),
    entryReason: r.entry_reason,
    entryIndicators: json(r.entry_indicators),
    closedAt: toMs(r.closed_at),
    exitPrice: n(r.exit_price),
    exitReason: r.exit_reason ?? null,
    grossPnl: n(r.gross_pnl),
    entryFee: n(r.entry_fee),
    exitFee: n(r.exit_fee),
    netPnl: n(r.net_pnl),
  };
}

export async function getOpenPosition(q: Queryable, symbol: string): Promise<Position | null> {
  const r = await q.query<Row>("select * from paper_positions where status = 'open' and symbol = $1 limit 1", [symbol]);
  return r.rows[0] ? mapPosition(r.rows[0]) : null;
}

export async function listOpenPositions(q: Queryable): Promise<Position[]> {
  const r = await q.query<Row>("select * from paper_positions where status = 'open' order by opened_at");
  return r.rows.map(mapPosition);
}

export interface TradeEvent {
  id: number;
  symbol: string;
  positionId: number;
  type: "BUY" | "SELL";
  occurredAt: number;
  price: number;
  amountUsdt: number;
  quantity: number;
  reason: string;
  grossPnl: number | null;
  entryFee: number | null;
  exitFee: number | null;
  netPnl: number | null;
  notificationStatus: string | null;
  notificationError: string | null;
}

export async function listTrades(q: Queryable, limit = 100): Promise<TradeEvent[]> {
  const r = await q.query<Row>(
    `select t.*, n.status as notif_status, n.last_error as notif_error
       from paper_trades t
       left join email_notifications n on n.trade_id = t.id
      order by t.occurred_at desc, t.id desc
      limit $1`,
    [limit],
  );
  return r.rows.map((x) => ({
    id: Number(x.id),
    symbol: x.symbol,
    positionId: Number(x.position_id),
    type: x.event_type,
    occurredAt: toMs(x.occurred_at) as number,
    price: Number(x.price),
    amountUsdt: Number(x.amount_usdt),
    quantity: Number(x.quantity),
    reason: x.reason,
    grossPnl: n(x.gross_pnl),
    entryFee: n(x.entry_fee),
    exitFee: n(x.exit_fee),
    netPnl: n(x.net_pnl),
    notificationStatus: x.notif_status ?? null,
    notificationError: x.notif_error ?? null,
  }));
}

export interface NotificationRow {
  id: number;
  kind: string;
  recipient: string;
  subject: string;
  status: string;
  attempts: number;
  provider: string | null;
  lastError: string | null;
  createdAt: number;
  acceptedAt: number | null;
  deliveredAt: number | null;
}

export async function listNotifications(q: Queryable, limit = 20): Promise<NotificationRow[]> {
  const r = await q.query<Row>(
    `select id, kind, recipient, subject, status, attempts, provider, last_error, created_at, accepted_at, delivered_at
       from email_notifications order by id desc limit $1`,
    [limit],
  );
  return r.rows.map((x) => ({
    id: Number(x.id),
    kind: x.kind,
    recipient: x.recipient,
    subject: x.subject,
    status: x.status,
    attempts: Number(x.attempts),
    provider: x.provider ?? null,
    lastError: x.last_error ?? null,
    createdAt: toMs(x.created_at) as number,
    acceptedAt: toMs(x.accepted_at),
    deliveredAt: toMs(x.delivered_at),
  }));
}

export interface EvaluationRow {
  symbol: string;
  evaluatedAt: number;
  h1CandleStart: number | null;
  status: string;
  conditions: unknown;
  indicators: unknown;
  summary: string;
}

/** The most recent entry-rule evaluation for every coin. */
export async function latestEvaluations(q: Queryable): Promise<EvaluationRow[]> {
  const r = await q.query<Row>("select distinct on (symbol) * from signal_evaluations order by symbol, evaluated_at desc");
  return r.rows.map((x) => ({
    symbol: x.symbol,
    evaluatedAt: toMs(x.evaluated_at) as number,
    h1CandleStart: toMs(x.h1_candle_start),
    status: x.status as string,
    conditions: json(x.conditions),
    indicators: json(x.indicators),
    summary: x.summary as string,
  }));
}

/** The most recent time each coin's evaluation was a BUY signal. */
export async function lastSignals(q: Queryable): Promise<Array<{ symbol: string; evaluatedAt: number; h1CandleStart: number | null; summary: string }>> {
  const r = await q.query<Row>(
    "select distinct on (symbol) symbol, evaluated_at, h1_candle_start, summary from signal_evaluations where status = 'SIGNAL' order by symbol, evaluated_at desc",
  );
  return r.rows.map((x) => ({ symbol: x.symbol, evaluatedAt: toMs(x.evaluated_at) as number, h1CandleStart: toMs(x.h1_candle_start), summary: x.summary as string }));
}

export interface JobRunRow {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  triggerSource: string;
  durationMs: number | null;
  message: string | null;
}

export async function recentJobRuns(q: Queryable, limit = 15): Promise<JobRunRow[]> {
  const r = await q.query<Row>(
    "select id, started_at, finished_at, status, trigger_source, duration_ms, message from job_runs order by started_at desc, id desc limit $1",
    [limit],
  );
  return r.rows.map((x) => ({
    id: Number(x.id),
    startedAt: toMs(x.started_at) as number,
    finishedAt: toMs(x.finished_at),
    status: x.status,
    triggerSource: x.trigger_source,
    durationMs: n(x.duration_ms),
    message: x.message ?? null,
  }));
}

export async function getKv<T = unknown>(q: Queryable, key: string): Promise<T | null> {
  const r = await q.query<Row>("select value from kv where key = $1", [key]);
  const v = r.rows[0]?.value;
  return v === undefined ? null : (json(v) as T);
}

export async function setKv(q: Queryable, key: string, value: unknown): Promise<void> {
  await q.query(
    "insert into kv (key, value, updated_at) values ($1, $2::jsonb, now()) on conflict (key) do update set value = excluded.value, updated_at = now()",
    [key, JSON.stringify(value)],
  );
}

export interface TradeStats {
  closedCount: number;
  netTotal: number;
  wins: number;
  bySymbol: Array<{ symbol: string; closedCount: number; netTotal: number; wins: number }>;
}

export async function tradeStats(q: Queryable): Promise<TradeStats> {
  const r = await q.query<Row>(
    `select symbol,
            count(*) as closed_count,
            coalesce(sum(net_pnl), 0) as net_total,
            count(*) filter (where net_pnl > 0) as wins
       from paper_positions where status = 'closed' group by symbol order by symbol`,
  );
  const bySymbol = r.rows.map((x) => ({ symbol: x.symbol as string, closedCount: Number(x.closed_count), netTotal: Number(x.net_total), wins: Number(x.wins) }));
  return {
    closedCount: bySymbol.reduce((a, b) => a + b.closedCount, 0),
    netTotal: bySymbol.reduce((a, b) => a + b.netTotal, 0),
    wins: bySymbol.reduce((a, b) => a + b.wins, 0),
    bySymbol,
  };
}

// ── Monitored coins ──────────────────────────────────────────────────────────
export const MAX_ASSETS = 15;

export interface Asset {
  symbol: string;
  base: string;
  enabled: boolean;
  signalArmed: boolean;
  addedAt: number;
  lastCheckedAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
  lastPrice: number | null;
  lastEvalStatus: string | null;
}

const mapAsset = (x: Row): Asset => ({
  symbol: x.symbol,
  base: x.base,
  enabled: Boolean(x.enabled),
  signalArmed: Boolean(x.signal_armed),
  addedAt: toMs(x.added_at) as number,
  lastCheckedAt: toMs(x.last_checked_at),
  lastOkAt: toMs(x.last_ok_at),
  lastError: x.last_error ?? null,
  lastPrice: n(x.last_price),
  lastEvalStatus: x.last_eval_status ?? null,
});

export async function listAssets(q: Queryable): Promise<Asset[]> {
  const r = await q.query<Row>("select * from assets order by added_at, symbol");
  return r.rows.map(mapAsset);
}

/** Coins the monitor must look at: enabled ones, plus any paused coin that still has an open simulated position (exits keep working). */
export async function listMonitoredAssets(q: Queryable): Promise<Asset[]> {
  const r = await q.query<Row>(
    `select a.* from assets a
      where a.enabled or exists (select 1 from paper_positions p where p.symbol = a.symbol and p.status = 'open')
      order by a.added_at, a.symbol`,
  );
  return r.rows.map(mapAsset);
}

export async function addAsset(q: Queryable, symbol: string, base: string): Promise<boolean> {
  const r = await q.query<Row>("insert into assets (symbol, base) values ($1, $2) on conflict (symbol) do nothing returning symbol", [symbol, base]);
  return r.rows.length > 0;
}

export async function setAssetEnabled(q: Queryable, symbol: string, enabled: boolean): Promise<boolean> {
  const r = await q.query<Row>("update assets set enabled = $2 where symbol = $1 returning symbol", [symbol, enabled]);
  return r.rows.length > 0;
}

export type RemoveAssetResult = "removed" | "not_found" | "has_open_position";

/** Removes a coin from monitoring. Refused while a simulated position is open (it must be closed by its exit rules first). */
export async function removeAsset(db: import("./db").Db, symbol: string): Promise<RemoveAssetResult> {
  return db.tx(async (q) => {
    const exists = await q.query<Row>("select symbol from assets where symbol = $1 for update", [symbol]);
    if (exists.rows.length === 0) return "not_found" as const;
    const open = await q.query<Row>("select 1 from paper_positions where symbol = $1 and status = 'open'", [symbol]);
    if (open.rows.length > 0) return "has_open_position" as const;
    await q.query("delete from assets where symbol = $1", [symbol]);
    return "removed" as const;
  });
}

export async function recordAssetCheck(
  q: Queryable,
  symbol: string,
  p: { at: number; ok: boolean; error: string | null; price: number | null; evalStatus: string | null },
): Promise<void> {
  await q.query(
    `update assets set last_checked_at = $2::timestamptz,
            last_ok_at = case when $3 then $2::timestamptz else last_ok_at end,
            last_error = $4,
            last_price = coalesce($5, last_price),
            last_eval_status = coalesce($6, last_eval_status)
      where symbol = $1`,
    [symbol, ts(p.at), p.ok, p.error, p.price, p.evalStatus],
  );
}

export async function setSignalArmed(q: Queryable, symbol: string, armed: boolean): Promise<void> {
  await q.query("update assets set signal_armed = $2 where symbol = $1", [symbol, armed]);
}
