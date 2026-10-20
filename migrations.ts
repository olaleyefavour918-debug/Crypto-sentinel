import type { Db } from "./db";
import { DEFAULT_SETTINGS, STARTING_BALANCE_USDT } from "./settings";

/**
 * Schema migrations. Applied automatically (once, under an advisory lock) on the first request after a deploy,
 * and also runnable manually with `npm run db:migrate`. Add new migrations to the END of this list; never edit
 * a migration that has already been applied.
 */
export const MIGRATIONS: Array<{ id: string; sql: string }> = [
  {
    id: "001_init",
    sql: `
create table if not exists app_settings (
  id smallint primary key default 1 check (id = 1),
  settings jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists paper_account (
  id smallint primary key default 1 check (id = 1),
  starting_balance numeric(20,8) not null check (starting_balance >= 0),
  available_balance numeric(20,8) not null check (available_balance >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists paper_positions (
  id bigserial primary key,
  status text not null check (status in ('open','closed')),
  entry_candle_start timestamptz not null,
  opened_at timestamptz not null,
  entry_price numeric(20,8) not null check (entry_price > 0),
  amount_usdt numeric(20,8) not null check (amount_usdt > 0),
  quantity_btc numeric(20,8) not null check (quantity_btc > 0),
  fee_rate_pct numeric(10,6) not null,
  stop_loss_pct numeric(10,4) not null,
  take_profit_pct numeric(10,4) not null,
  trend_exit_enabled boolean not null,
  entry_reason text not null,
  entry_indicators jsonb not null,
  closed_at timestamptz,
  exit_price numeric(20,8),
  exit_reason text,
  gross_pnl numeric(20,8),
  entry_fee numeric(20,8),
  exit_fee numeric(20,8),
  net_pnl numeric(20,8),
  constraint paper_positions_closed_fields check (
    (status = 'open' and closed_at is null)
    or (status = 'closed' and closed_at is not null and exit_price is not null and net_pnl is not null)
  )
);
-- At most ONE open simulated position, enforced by the database itself.
create unique index if not exists paper_positions_one_open on paper_positions (status) where status = 'open';
-- At most ONE simulated entry per 1h candle (duplicate-entry protection that survives restarts and races).
create unique index if not exists paper_positions_one_per_candle on paper_positions (entry_candle_start);

create table if not exists paper_trades (
  id bigserial primary key,
  position_id bigint not null references paper_positions(id),
  event_type text not null check (event_type in ('BUY','SELL')),
  event_key text not null unique,
  occurred_at timestamptz not null,
  price numeric(20,8) not null check (price > 0),
  amount_usdt numeric(20,8) not null,
  quantity_btc numeric(20,8) not null,
  reason text not null,
  indicators jsonb not null,
  gross_pnl numeric(20,8),
  entry_fee numeric(20,8),
  exit_fee numeric(20,8),
  net_pnl numeric(20,8),
  created_at timestamptz not null default now()
);
create index if not exists paper_trades_occurred_idx on paper_trades (occurred_at desc);

create table if not exists email_notifications (
  id bigserial primary key,
  dedupe_key text not null unique,
  kind text not null check (kind in ('BUY','SELL','TEST')),
  trade_id bigint references paper_trades(id),
  recipient text not null,
  subject text not null,
  text_body text not null,
  html_body text not null,
  status text not null check (status in ('queued','sending','accepted','delivered','bounced','failed','skipped')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  provider text,
  provider_message_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  accepted_at timestamptz,
  delivered_at timestamptz
);
create index if not exists email_notifications_status_idx on email_notifications (status, next_attempt_at);
create index if not exists email_notifications_provider_idx on email_notifications (provider_message_id);

create table if not exists market_snapshots (
  id bigserial primary key,
  captured_at timestamptz not null default now(),
  price numeric(20,8) not null,
  price_change_24h_pct numeric(12,6),
  high_24h numeric(20,8),
  low_24h numeric(20,8),
  volume_24h_btc numeric(24,8),
  turnover_24h_usdt numeric(24,8),
  h1_last_closed timestamptz not null,
  h4_last_closed timestamptz not null,
  source text not null default 'bybit-live'
);
create index if not exists market_snapshots_captured_idx on market_snapshots (captured_at desc);

create table if not exists signal_evaluations (
  id bigserial primary key,
  eval_key text not null unique,
  evaluated_at timestamptz not null,
  h1_candle_start timestamptz,
  status text not null check (status in ('SIGNAL','NO_SIGNAL','DATA_INVALID')),
  conditions jsonb not null,
  indicators jsonb not null,
  summary text not null
);
create index if not exists signal_evaluations_evaluated_idx on signal_evaluations (evaluated_at desc);

create table if not exists job_runs (
  id bigserial primary key,
  started_at timestamptz not null,
  finished_at timestamptz,
  status text not null check (status in ('running','success','partial','failed','skipped_locked')),
  trigger_source text not null default 'cron',
  duration_ms int,
  message text,
  details jsonb
);
create index if not exists job_runs_started_idx on job_runs (started_at desc);

create table if not exists job_lock (
  name text primary key,
  owner text not null,
  locked_until timestamptz not null,
  acquired_at timestamptz not null default now()
);

create table if not exists rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (bucket, window_start)
);

create table if not exists kv (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
`,
  },
  {
    id: "002_multi_asset",
    sql: `
-- Monitored coins. Managed from the website (Settings → Coins); no code edits needed.
create table if not exists assets (
  symbol text primary key check (symbol ~ '^[A-Z0-9]{2,12}USDT$'),
  base text not null,
  enabled boolean not null default true,
  -- Edge trigger: after a simulated position closes the coin is "disarmed" and only re-arms once the BUY
  -- conditions have lapsed, so the next BUY alert is a genuinely new signal (not the same setup repeating).
  signal_armed boolean not null default true,
  added_at timestamptz not null default now(),
  last_checked_at timestamptz,
  last_ok_at timestamptz,
  last_error text,
  last_price numeric(24,10),
  last_eval_status text
);
insert into assets (symbol, base) values
  ('BTCUSDT','BTC'), ('ETHUSDT','ETH'), ('SOLUSDT','SOL'), ('XRPUSDT','XRP'), ('BNBUSDT','BNB')
on conflict (symbol) do nothing;

alter table paper_positions add column if not exists symbol text not null default 'BTCUSDT';
alter table paper_trades add column if not exists symbol text not null default 'BTCUSDT';
alter table signal_evaluations add column if not exists symbol text not null default 'BTCUSDT';
alter table market_snapshots add column if not exists symbol text not null default 'BTCUSDT';
alter table paper_positions alter column entry_price type numeric(24,10);
alter table paper_positions alter column quantity_btc type numeric(28,10);
alter table paper_trades alter column price type numeric(24,10);
alter table paper_trades alter column quantity_btc type numeric(28,10);
alter table market_snapshots alter column price type numeric(24,10);
alter table paper_positions rename column quantity_btc to quantity;
alter table paper_trades rename column quantity_btc to quantity;
alter table market_snapshots rename column volume_24h_btc to volume_24h_base;

-- One open position PER COIN, and one entry per coin per 1h candle (database-enforced duplicate protection).
drop index if exists paper_positions_one_open;
drop index if exists paper_positions_one_per_candle;
create unique index if not exists paper_positions_one_open_per_symbol on paper_positions (symbol) where status = 'open';
create unique index if not exists paper_positions_one_per_candle_symbol on paper_positions (symbol, entry_candle_start);
create index if not exists paper_trades_symbol_idx on paper_trades (symbol, occurred_at desc);
create index if not exists signal_evaluations_symbol_idx on signal_evaluations (symbol, evaluated_at desc);
create index if not exists market_snapshots_symbol_idx on market_snapshots (symbol, captured_at desc);
`,
  },
];

const setupMemo = new WeakMap<object, Promise<void>>();

export async function runMigrations(db: Db): Promise<string[]> {
  const applied: string[] = [];
  await db.tx(async (q) => {
    await q.query("select pg_advisory_xact_lock($1)", [727001]);
    await q.exec(`create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())`);
    const done = new Set((await q.query<{ id: string }>("select id from schema_migrations")).rows.map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await q.exec(m.sql);
      await q.query("insert into schema_migrations (id) values ($1)", [m.id]);
      applied.push(m.id);
    }
    // Seed singleton rows (idempotent). Defaults live in code so there is one source of truth.
    await q.query("insert into app_settings (id, settings) values (1, $1::jsonb) on conflict (id) do nothing", [JSON.stringify(DEFAULT_SETTINGS)]);
    await q.query(
      "insert into paper_account (id, starting_balance, available_balance) values (1, $1, $1) on conflict (id) do nothing",
      [STARTING_BALANCE_USDT],
    );
  });
  return applied;
}

/** Runs migrations once per process (retries after a failure). Safe to call on every request. */
export function ensureSetup(db: Db): Promise<void> {
  let p = setupMemo.get(db);
  if (!p) {
    p = runMigrations(db).then(() => undefined);
    setupMemo.set(db, p);
    p.catch(() => setupMemo.delete(db));
  }
  return p;
}
