import type { Db, Queryable, Row } from "./db";
import { analyzeDirection, computeStats, resolveSignal, type DirectionalAssessment, type PerfStats, type ResolvedTrade, type SignalOutcome, type SignalStatus } from "./directional";
import { buildDirectionalEmail, queueDirectionalEmail } from "./directional-email";
import { baseOf } from "./format";
import { logger } from "./logger";
import { json, ts } from "./store";
import { toMs } from "./time";
import { INTERVAL_MS, type Candle, type Settings } from "./types";

/** Persistence + per-run orchestration for the LONG / SHORT / NEUTRAL analysis. Never touches paper trades or the BUY/SELL tables. */

export interface DirectionRow {
  symbol: string;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  candleStart: number;
  evaluatedAt: number;
  price: number | null;
  assessment: DirectionalAssessment;
}

export interface SignalRow {
  id: number;
  symbol: string;
  direction: "LONG" | "SHORT";
  candleStart: number;
  createdAt: number;
  priceRef: number;
  stop: number;
  takeProfit: number;
  riskReward: number;
  score: number;
  status: SignalStatus;
  fillPrice: number | null;
  exitPrice: number | null;
  exitAt: number | null;
  bars: number | null;
  grossPct: number | null;
  netPct: number | null;
  rMultiple: number | null;
  mfePct: number | null;
  maePct: number | null;
  ambiguous: boolean;
  reasons: string[];
  invalidations: string[];
}

const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function mapSignal(x: Row): SignalRow {
  const payload = json(x.payload) as Partial<DirectionalAssessment> | null;
  return {
    id: Number(x.id), symbol: x.symbol, direction: x.direction, candleStart: toMs(x.candle_start) as number, createdAt: toMs(x.created_at) as number,
    priceRef: Number(x.price_ref), stop: Number(x.stop), takeProfit: Number(x.take_profit), riskReward: Number(x.risk_reward), score: Number(x.score),
    status: x.status, fillPrice: numOrNull(x.fill_price), exitPrice: numOrNull(x.exit_price), exitAt: toMs(x.exit_at), bars: x.bars === null ? null : Number(x.bars),
    grossPct: numOrNull(x.gross_pct), netPct: numOrNull(x.net_pct), rMultiple: numOrNull(x.r_multiple), mfePct: numOrNull(x.mfe_pct), maePct: numOrNull(x.mae_pct),
    ambiguous: Boolean(x.ambiguous), reasons: payload?.reasons ?? [], invalidations: payload?.invalidations ?? [],
  };
}

export async function listDirectionState(q: Queryable): Promise<DirectionRow[]> {
  const r = await q.query<Row>("select * from direction_state order by symbol");
  return r.rows.map((x) => ({
    symbol: x.symbol, direction: x.direction, candleStart: toMs(x.candle_start) as number, evaluatedAt: toMs(x.evaluated_at) as number,
    price: numOrNull(x.price), assessment: json(x.payload) as DirectionalAssessment,
  }));
}

export async function listSignals(q: Queryable, limit = 50): Promise<SignalRow[]> {
  const r = await q.query<Row>("select * from directional_signals order by id desc limit $1", [limit]);
  return r.rows.map(mapSignal);
}

export async function resolvedTrades(q: Queryable): Promise<ResolvedTrade[]> {
  const r = await q.query<Row>(
    "select symbol, direction, status, exit_at, net_pct, gross_pct, r_multiple, ambiguous from directional_signals where status in ('tp','sl','expired','reversed') and net_pct is not null and exit_at is not null",
  );
  return r.rows.map((x) => ({
    symbol: x.symbol, direction: x.direction, status: x.status, exitAt: toMs(x.exit_at) as number, netPct: Number(x.net_pct),
    grossPct: Number(x.gross_pct), rMultiple: numOrNull(x.r_multiple), ambiguous: Boolean(x.ambiguous),
  }));
}

export interface DirectionalSummary {
  assessments: DirectionRow[];
  signals: SignalRow[];
  stats: PerfStats;
  counts: { open: number; missed: number };
}

export async function directionalSummary(q: Queryable): Promise<DirectionalSummary> {
  const [assessments, signals, trades, c] = await Promise.all([
    listDirectionState(q),
    listSignals(q, 40),
    resolvedTrades(q),
    q.query<Row>("select count(*) filter (where status = 'open')::int as open, count(*) filter (where status = 'missed')::int as missed from directional_signals"),
  ]);
  return { assessments, signals, stats: computeStats(trades), counts: { open: Number(c.rows[0].open), missed: Number(c.rows[0].missed) } };
}

async function saveOutcome(q: Queryable, id: number, o: SignalOutcome, nowMs: number): Promise<void> {
  await q.query(
    `update directional_signals set status = $2, fill_price = $3, exit_price = $4, exit_at = $5::timestamptz, bars = $6, gross_pct = $7, net_pct = $8,
       r_multiple = $9, mfe_pct = $10, mae_pct = $11, ambiguous = $12, resolved_at = $13::timestamptz where id = $1 and status = 'open'`,
    [id, o.status, o.fillPrice, o.exitPrice, o.exitAt === null ? null : ts(o.exitAt), o.bars, o.grossPct, o.netPct, o.rMultiple, o.mfePct, o.maePct, o.ambiguous, ts(nowMs)],
  );
}

/** Resolves every open signal of a coin against the closed candles that came AFTER the signal candle. */
export async function resolveOpenSignals(db: Db, symbol: string, h1Closed: Candle[], settings: Settings, nowMs: number): Promise<string[]> {
  const actions: string[] = [];
  const open = await db.query<Row>("select * from directional_signals where symbol = $1 and status = 'open' order by id", [symbol]);
  for (const row of open.rows) {
    const o = resolveSignal({ direction: row.direction, candleStart: toMs(row.candle_start) as number, stop: Number(row.stop), takeProfit: Number(row.take_profit) }, h1Closed, settings);
    if (o.status !== "open") {
      await saveOutcome(db, Number(row.id), o, nowMs);
      actions.push(`${baseOf(symbol)}: ${row.direction} analysis ${o.status === "tp" ? "reached its target" : o.status === "sl" ? "hit its stop reference" : o.status === "missed" ? "was not fillable (price gapped past a level)" : "expired"}${o.netPct === null ? "" : ` (net ${o.netPct >= 0 ? "+" : "−"}${Math.abs(o.netPct).toFixed(2)}%)`}`);
    }
  }
  return actions;
}

export interface DirectionalRunInput {
  symbol: string;
  enabled: boolean;
  settings: Settings;
  h1Closed: Candle[];
  h4Closed: Candle[];
  nowMs: number;
  /** Description of the current BUY/SELL state for context in the email (never changes behaviour). */
  spotContext?: string;
}

/**
 * One pass for one coin: analyse, remember the assessment, resolve open signals, and raise a new signal ONLY on a
 * transition into LONG/SHORT (so the same setup never alerts twice). An opposite signal closes the old one first.
 */
export async function processDirectional(db: Db, input: DirectionalRunInput): Promise<{ assessment: DirectionalAssessment; actions: string[] }> {
  const { symbol, settings, h1Closed, h4Closed, nowMs } = input;
  const H1 = INTERVAL_MS["60"];
  const actions: string[] = [];
  const a = analyzeDirection({ h1: h1Closed, h4: h4Closed, now: nowMs, settings });
  const prevRow = await db.query<Row>("select direction from direction_state where symbol = $1", [symbol]);
  const prev = (prevRow.rows[0]?.direction as string | undefined) ?? null;

  if (a.candleStart !== null) {
    await db.query(
      `insert into direction_state (symbol, direction, candle_start, evaluated_at, price, payload) values ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6::jsonb)
       on conflict (symbol) do update set direction = excluded.direction, candle_start = excluded.candle_start, evaluated_at = excluded.evaluated_at, price = excluded.price, payload = excluded.payload`,
      [symbol, a.direction, ts(a.candleStart), ts(nowMs), a.price, JSON.stringify(a)],
    );
  }
  actions.push(...(await resolveOpenSignals(db, symbol, h1Closed, settings, nowMs)));

  const wantsSignal = settings.directionalEnabled && input.enabled && a.dataOk && a.direction !== "NEUTRAL" && a.levels !== null && a.candleStart !== null && prev !== a.direction;
  if (wantsSignal && a.levels && a.candleStart !== null && a.direction !== "NEUTRAL") {
    const closeAt = a.candleStart + H1;
    if (nowMs - closeAt > settings.entryWindowMinutes * 60_000) {
      logger.info("directional.window_passed", { symbol, direction: a.direction });
      return { assessment: a, actions };
    }
    const direction = a.direction;
    const lv = a.levels;
    await db.tx(async (q) => {
      const open = await q.query<Row>("select * from directional_signals where symbol = $1 and status = 'open' for update", [symbol]);
      for (const row of open.rows) {
        if (row.direction === direction) return; // an identical-direction setup is still active: no duplicate
        const o = resolveSignal({ direction: row.direction, candleStart: toMs(row.candle_start) as number, stop: Number(row.stop), takeProfit: Number(row.take_profit) }, h1Closed, settings, { reverseAt: { price: a.price as number, at: closeAt } });
        const final: SignalOutcome = o.status === "open" ? { ...o, status: "reversed", exitPrice: a.price, exitAt: closeAt } : o;
        await saveOutcome(q, Number(row.id), final, nowMs);
        actions.push(`${baseOf(symbol)}: earlier ${row.direction} analysis closed because the opposite direction appeared`);
      }
      const ins = await q.query<Row>(
        `insert into directional_signals (symbol, direction, candle_start, price_ref, stop, take_profit, risk_reward, score, payload)
         values ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9::jsonb) on conflict do nothing returning id`,
        [symbol, direction, ts(a.candleStart as number), a.price, lv.stop, lv.takeProfit, lv.riskReward, direction === "LONG" ? a.longScore : a.shortScore, JSON.stringify(a)],
      );
      if (!ins.rows[0]) return;
      const id = Number(ins.rows[0].id);
      const message = buildDirectionalEmail({ symbol, direction, assessment: a, evaluatedAt: nowMs, spotContext: input.spotContext });
      await queueDirectionalEmail(q, { signalId: id, kind: direction, settings, message });
      actions.push(`${baseOf(symbol)}: ${direction} analysis signal (reward/risk ${lv.riskReward.toFixed(2)}, reference ${a.price})`);
    });
  }
  return { assessment: a, actions };
}
