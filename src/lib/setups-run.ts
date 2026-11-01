import type { Db, Queryable, Row } from "./db";
import { computeStats, resolveSignal, type PerfStats, type ResolvedTrade, type SignalOutcome } from "./directional";
import { logger } from "./logger";
import { step, type SetupEvent, type SetupState, type SetupStatus } from "./lifecycle";
import { closedCandles } from "./rules";
import { buildSetupEmail } from "./setups-alerts";
import { elapsedFraction, evaluateStrategy, SETUP, STRATEGIES, type Cond, type SetupLevels, type StrategyId } from "./setups";
import { getKv, setKv } from "./store";
import { toMs } from "./time";
import { INTERVAL_MS, type Candle, type Settings } from "./types";

const H1 = INTERVAL_MS["60"];
const H4 = INTERVAL_MS["240"];
const ts = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const json = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);

export function rowToState(r: Row): SetupState {
  return {
    symbol: String(r.symbol), strategy: r.strategy as StrategyId, status: r.status as SetupStatus,
    firstSeenAt: toMs(r.first_seen_at) as number, statusSince: toMs(r.status_since) as number,
    signalCandleStart: toMs(r.signal_candle_start), signalPrice: numOrNull(r.signal_price), signalPriceAt: toMs(r.signal_price_at),
    confirmCandleClose: numOrNull(r.confirm_candle_close), potentialScans: Number(r.potential_scans), repaints: Number(r.repaints),
    convertedFromPotential: Boolean(r.converted), expireReason: (r.expire_reason as string | null) ?? null, expiredAt: toMs(r.expired_at),
    levels: r.levels ? (json(r.levels) as SetupLevels) : null, variant: (r.variant as string | null) ?? null,
    refs: r.refs ? json(r.refs) : { zoneLow: null, zoneHigh: null, atr: null },
    lastPrice: numOrNull(r.last_price), lastScanAt: toMs(r.last_scan_at) as number,
    conditions: json(r.conditions) as Cond[], reasons: json(r.reasons) as string[],
  };
}

function stateParams(s: SetupState): unknown[] {
  return [
    s.status, ts(s.statusSince), ts(s.signalCandleStart), s.signalPrice, ts(s.signalPriceAt), s.confirmCandleClose, s.potentialScans, s.repaints,
    s.convertedFromPotential, s.expireReason, ts(s.expiredAt), s.levels ? JSON.stringify(s.levels) : null, s.variant, JSON.stringify(s.refs),
    s.lastPrice, ts(s.lastScanAt), JSON.stringify(s.conditions), JSON.stringify(s.reasons),
  ];
}

const UPDATE_SQL = `update setups set status = $2, status_since = $3::timestamptz, signal_candle_start = $4::timestamptz, signal_price = $5,
  signal_price_at = $6::timestamptz, confirm_candle_close = $7, potential_scans = $8, repaints = $9, converted = $10, expire_reason = $11,
  expired_at = $12::timestamptz, levels = $13::jsonb, variant = $14, refs = $15::jsonb, last_price = $16, last_scan_at = $17::timestamptz,
  conditions = $18::jsonb, reasons = $19::jsonb where id = $1`;

const INSERT_SQL = `insert into setups (symbol, strategy, first_seen_at, status, status_since, signal_candle_start, signal_price, signal_price_at,
  confirm_candle_close, potential_scans, repaints, converted, expire_reason, expired_at, levels, variant, refs, last_price, last_scan_at, conditions, reasons)
  values ($1, $2, $3::timestamptz, $4, $5::timestamptz, $6::timestamptz, $7, $8::timestamptz, $9, $10, $11, $12, $13, $14::timestamptz, $15::jsonb, $16, $17::jsonb, $18, $19::timestamptz, $20::jsonb, $21::jsonb)
  returning id`;

export interface SetupsInput {
  symbol: string;
  /** False when the coin is paused. */
  enabled: boolean;
  settings: Settings;
  /** All klines as returned by the exchange (the newest may be the unfinished candle). */
  h1All: Candle[];
  h4All: Candle[];
  /** Live price from the ticker, if it is fresh. */
  price: number | null;
  nowMs: number;
  /** BTC 4H closed candles for the market-wide guard. */
  btcH4Closed?: Candle[] | null;
}

const EARLY_COOLDOWN_MS = 6 * 3600_000;
const EARLY_DAILY_CAP = 6;

async function allowEarlyAlert(q: Queryable, symbol: string, strategy: StrategyId): Promise<boolean> {
  const perCoin = await q.query<Row>(
    `select 1 from setup_events e join setups s on s.id = e.setup_id
      where e.kind = 'POTENTIAL' and e.notify and s.symbol = $1 and s.strategy = $2 and e.created_at > now() - ($3::int * interval '1 millisecond') limit 1`,
    [symbol, strategy, EARLY_COOLDOWN_MS],
  );
  if (perCoin.rows.length > 0) return false;
  const day = await q.query<Row>("select count(*)::int as n from setup_events where kind = 'POTENTIAL' and notify and created_at > now() - interval '24 hours'");
  return Number(day.rows[0].n) < EARLY_DAILY_CAP;
}

const CONFIRMED_COOLDOWN_MS = 12 * 3600_000;
const CONFIRMED_DAILY_CAP = 10;

/** Confirmed setups can be frequent (exit warnings especially), so they are rate limited too: 1 per coin per strategy per 12h and 10 per day. */
async function allowConfirmedAlert(q: Queryable, symbol: string, strategy: StrategyId): Promise<boolean> {
  const perCoin = await q.query<Row>(
    `select 1 from setup_events e join setups s on s.id = e.setup_id
      where e.kind = 'CONFIRMED' and e.notify and s.symbol = $1 and s.strategy = $2 and e.created_at > now() - ($3::int * interval '1 millisecond') limit 1`,
    [symbol, strategy, CONFIRMED_COOLDOWN_MS],
  );
  if (perCoin.rows.length > 0) return false;
  const day = await q.query<Row>("select count(*)::int as n from setup_events where kind = 'CONFIRMED' and notify and created_at > now() - interval '24 hours'");
  return Number(day.rows[0].n) < CONFIRMED_DAILY_CAP;
}

/**
 * Runs the three strategies for one coin, advances each lifecycle, records events, queues the alerts the user's settings allow and tracks
 * Support-Bounce outcomes. Opens and closes NO paper trade, places NO order. Safe to call every 5 minutes.
 */
export async function processSetups(db: Db, input: SetupsInput): Promise<string[]> {
  const { symbol, settings, nowMs } = input;
  if (!settings.setupsEnabled || !input.enabled) return [];
  const h1Closed = closedCandles(input.h1All, H1, nowMs);
  const h4Closed = closedCandles(input.h4All, H4, nowMs);
  if (h1Closed.length === 0 || h4Closed.length === 0) return [];
  const lastClosed = h1Closed[h1Closed.length - 1];
  const live = input.h1All.filter((c) => c.start + H1 > nowMs && c.start === lastClosed.start + H1)[0] ?? null;
  const forming = live && elapsedFraction(live.start, nowMs) >= SETUP.minElapsed ? live : null;
  const actions: string[] = [];
  const base = symbol.replace(/USDT$/, "");

  for (const strategy of STRATEGIES) {
    const common = { symbol, h1Closed, h4Closed, now: nowMs, settings, btcH4: input.btcH4Closed ?? null };
    const closed = evaluateStrategy(strategy, { ...common, forming: null });
    await noteDataHealth(db, symbol, closed.dataOk ? null : closed.dataIssue, nowMs);
    if (!closed.dataOk) continue;
    const preview = forming ? evaluateStrategy(strategy, { ...common, forming }) : null;

    const latest = (await db.query<Row>("select * from setups where symbol = $1 and strategy = $2 order by id desc limit 1", [symbol, strategy])).rows[0] ?? null;
    const prev = latest ? rowToState(latest) : null;
    const price = input.price ?? preview?.price ?? closed.price;
    const res = step(prev, symbol, strategy, { now: nowMs, price, closed, preview });

    if (res.state) {
      await db.tx(async (q) => {
        let id: number;
        if (latest && prev && prev.status !== "EXPIRED") {
          id = Number(latest.id);
          await q.query(UPDATE_SQL, [id, ...stateParams(res.state as SetupState)]);
        } else {
          const s = res.state as SetupState;
          const ins = await q.query<Row>(INSERT_SQL, [symbol, strategy, ts(s.firstSeenAt), s.status, ts(s.statusSince), ts(s.signalCandleStart), s.signalPrice, ts(s.signalPriceAt), s.confirmCandleClose, s.potentialScans, s.repaints, s.convertedFromPotential, s.expireReason, ts(s.expiredAt), s.levels ? JSON.stringify(s.levels) : null, s.variant, JSON.stringify(s.refs), s.lastPrice, ts(s.lastScanAt), JSON.stringify(s.conditions), JSON.stringify(s.reasons)]);
          id = Number(ins.rows[0].id);
        }
        for (const ev of res.events) {
          const kind = ev.kind === "POTENTIAL" || ev.kind === "CONFIRMED" ? ev.kind : null;
          const notify = kind !== null && (await shouldNotify(q, settings, symbol, strategy, kind));
          await q.query("insert into setup_events (setup_id, kind, at, price, note, notify) values ($1, $2, $3::timestamptz, $4, $5, $6)", [id, ev.kind, ts(ev.at), ev.price, ev.note, notify]);
          if (kind === "CONFIRMED" && notify && settings.setupConfirmedEmailEnabled) {
            const msg = buildSetupEmail({ symbol, strategy, kind, state: res.state as SetupState, now: nowMs, latestPrice: price });
            await q.query(
              `insert into email_notifications (dedupe_key, kind, recipient, subject, text_body, html_body, status)
               values ($1, 'SETUP', $2, $3, $4, $5, 'queued') on conflict (dedupe_key) do nothing`,
              [`setup:${id}:confirmed`, settings.emailRecipient, msg.subject, msg.text, msg.html],
            );
          }
          const line = describe(base, strategy, ev, settings.setupAlertsEnabled && notify);
          if (line) actions.push(line);
        }
      });
    } else if (prev && prev.status !== "EXPIRED") {
      // Defensive: step() always returns a state for an active setup.
      logger.warn("setups.no_state", { symbol, strategy });
    }
  }

  await trackBounceOutcomes(db, symbol, h1Closed, settings).catch((e) => logger.warn("setups.outcome_failed", { symbol, error: String(e) }));
  return actions;
}

function describe(base: string, strategy: StrategyId, ev: SetupEvent, alerted: boolean): string {
  const name = strategy === "BOUNCE" ? "Support-Bounce" : strategy === "EXIT_WARNING" ? "Exit warning" : "Trend BUY";
  if (ev.kind === "WATCH" || ev.kind === "REGRESSED") return "";
  return `${base}: ${name} ${ev.kind}${alerted ? " (alert sent)" : " (recorded, no alert)"}`;
}

async function shouldNotify(q: Queryable, s: Settings, symbol: string, strategy: StrategyId, kind: "POTENTIAL" | "CONFIRMED"): Promise<boolean> {
  if (!s.setupAlertsEnabled) return false; // shadow mode
  if (kind === "CONFIRMED") return strategy !== "TREND_BUY" && (await allowConfirmedAlert(q, symbol, strategy)); // the existing BUY alert already covers a confirmed trend BUY
  if (!s.setupEarlyPushEnabled) return false;
  return allowEarlyAlert(q, symbol, strategy);
}

/** Remembers, per coin, whether the data looked delayed/unusable, so the dashboard can say "DATA DELAYED". Only writes on change. */
async function noteDataHealth(db: Db, symbol: string, issue: string | null, now: number): Promise<void> {
  const map = (await getKv<Record<string, { at: number; issue: string | null }>>(db, "setups_data_issues")) ?? {};
  const cur = map[symbol]?.issue ?? null;
  if (cur === issue) return;
  map[symbol] = { at: now, issue };
  await setKv(db, "setups_data_issues", map);
}

// ── Support-Bounce outcome tracking (separate from the paper account) ────────

function saveOutcomeSql(): string {
  return `update setups set outcome_status = $2, outcome_net_pct = $3, outcome_gross_pct = $4, outcome_r = $5, outcome_exit_at = $6::timestamptz, outcome_ambiguous = $7 where id = $1`;
}

async function trackBounceOutcomes(db: Db, symbol: string, h1Closed: Candle[], settings: Settings): Promise<void> {
  const rows = await db.query<Row>(
    "select id, signal_candle_start, levels from setups where symbol = $1 and strategy = 'BOUNCE' and signal_candle_start is not null and levels is not null and confirm_candle_close is not null and (outcome_status is null or outcome_status = 'open')",
    [symbol],
  );
  for (const r of rows.rows) {
    const lv = json(r.levels) as SetupLevels;
    const o: SignalOutcome = resolveSignal({ direction: "LONG", candleStart: toMs(r.signal_candle_start) as number, stop: lv.stop, takeProfit: lv.target }, h1Closed, settings);
    if (o.status === "open") continue; // still unresolved: leave the outcome empty
    await db.query(saveOutcomeSql(), [Number(r.id), o.status, o.netPct, o.grossPct, o.rMultiple, o.exitAt === null ? null : ts(o.exitAt), o.ambiguous]);
  }
}

// ── Reading for the dashboard ────────────────────────────────────────────────

export interface SetupView extends SetupState {
  id: number;
  outcomeStatus: string | null;
  outcomeNetPct: number | null;
}

export interface SetupsSummary {
  setups: SetupView[];
  /** Support-Bounce results tracked separately from the paper account. */
  bounceStats: PerfStats;
  /** How many early reads there were and how many were confirmed when the candle closed. */
  early: { raised: number; confirmed: number; faded: number };
  dataIssues: Array<{ symbol: string; issue: string; at: number }>;
}

export async function setupsSummary(q: Queryable, nowMs: number): Promise<SetupsSummary> {
  const rows = await q.query<Row>(
    `select * from setups where status <> 'EXPIRED' or expired_at > now() - interval '24 hours' order by (status = 'EXPIRED'), last_scan_at desc, id desc limit 120`,
  );
  const setups: SetupView[] = rows.rows.map((r) => ({ ...rowToState(r), id: Number(r.id), outcomeStatus: (r.outcome_status as string | null) ?? null, outcomeNetPct: numOrNull(r.outcome_net_pct) }));
  const tr = await q.query<Row>("select symbol, outcome_status, outcome_exit_at, outcome_net_pct, outcome_gross_pct, outcome_r, outcome_ambiguous from setups where strategy = 'BOUNCE' and outcome_status in ('tp','sl','expired')");
  const trades: ResolvedTrade[] = tr.rows.map((r) => ({
    symbol: String(r.symbol), direction: "LONG", status: r.outcome_status as ResolvedTrade["status"], exitAt: toMs(r.outcome_exit_at) as number,
    netPct: Number(r.outcome_net_pct), grossPct: Number(r.outcome_gross_pct), rMultiple: numOrNull(r.outcome_r), ambiguous: Boolean(r.outcome_ambiguous),
  }));
  const ev = await q.query<Row>(
    `select count(*) filter (where kind = 'POTENTIAL')::int as raised,
            (select count(*)::int from setups where converted) as confirmed,
            (select count(*)::int from setups where repaints > 0) as faded
       from setup_events`,
  );
  const issues = (await getKv<Record<string, { at: number; issue: string | null }>>(q, "setups_data_issues")) ?? {};
  const dataIssues = Object.entries(issues).filter(([, v]) => v.issue && nowMs - v.at < 6 * 3600_000).map(([symbol, v]) => ({ symbol, issue: v.issue as string, at: v.at }));
  return {
    setups,
    bounceStats: computeStats(trades),
    early: { raised: Number(ev.rows[0].raised), confirmed: Number(ev.rows[0].confirmed), faded: Number(ev.rows[0].faded) },
    dataIssues,
  };
}
