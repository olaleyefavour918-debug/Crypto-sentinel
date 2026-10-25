import { randomUUID } from "node:crypto";
import { BybitError, fetchKlines, fetchTickers, sanitizeError, type BybitDeps } from "./bybit";
import { isUniqueViolation, type Db, type Row } from "./db";
import { buildTradeEmail, processEmailQueue, queueTradeEmail, type EmailDeps } from "./email";
import { logger } from "./logger";
import { pushNewEarly, pushNewSignals, pushNewTrades, type PushDeps } from "./webpush";
import { processEarly } from "./early";
import { processDirectional } from "./directional-run";
import { balanceAfterClose, balanceAfterOpen, computeClose, roundPrice, simulatedQuantity } from "./paper";
import { ensureSetup } from "./migrations";
import { pruneRateLimits } from "./ratelimit";
import {
  candlesToFetch, closedCandles, evaluateBuy, evaluateExit, expectedLastClosedStart, latestSnapshot, MAX_TICKER_AGE_MS,
} from "./rules";
import { baseOf } from "./format";
import { getKv, getOpenPosition, listMonitoredAssets, loadSettings, mapPosition, recordAssetCheck, setKv, setSignalArmed, ts, type Asset } from "./store";
import { fmtUtcShort } from "./time";
import { INTERVAL_MS, type BuyEvaluation, type Candle, type Settings, type Ticker24h, type TimeframeSnapshot } from "./types";

const LOCK_NAME = "monitor";
const LOCK_MS = 75_000;

export interface MonitorDeps {
  db: Db;
  now?: () => number;
  bybit?: BybitDeps;
  email?: EmailDeps;
  push?: PushDeps;
  trigger?: "cron" | "manual";
}

export interface MonitorResult {
  status: "success" | "partial" | "failed" | "skipped_locked";
  message: string;
  jobRunId?: number;
  actions: string[];
  errors: string[];
  evaluationStatus?: string;
  price?: number;
}

/**
 * One monitoring pass. Designed to be invoked by a scheduler (never a long-running loop):
 *  1. take a DB lease so overlapping invocations cannot run concurrently,
 *  2. fetch PUBLIC Bybit data (1h + 4h klines, ticker),
 *  3. evaluate the BUY rule on closed candles and the exit rules on any open simulated position,
 *  4. record results atomically (DB constraints prevent duplicate entries/exits/emails),
 *  5. send any queued emails, record the run, release the lease.
 */
export async function runMonitor(deps: MonitorDeps): Promise<MonitorResult> {
  const { db } = deps;
  const clock = deps.now ?? Date.now;
  const startedAt = clock();
  await ensureSetup(db);

  const owner = randomUUID();
  const lease = await db.query<Row>(
    `insert into job_lock (name, owner, locked_until) values ($1, $2, now() + ($3::int * interval '1 millisecond'))
     on conflict (name) do update set owner = excluded.owner, locked_until = excluded.locked_until, acquired_at = now()
     where job_lock.locked_until < now()
     returning owner`,
    [LOCK_NAME, owner, LOCK_MS],
  );
  if (lease.rows.length === 0) {
    await db.query(
      "insert into job_runs (started_at, finished_at, status, trigger_source, duration_ms, message) values ($1::timestamptz, $1::timestamptz, 'skipped_locked', $2, 0, $3)",
      [ts(startedAt), deps.trigger ?? "cron", "Another monitor run holds the lock; this invocation was skipped."],
    );
    return { status: "skipped_locked", message: "Another run is in progress; skipped.", actions: [], errors: [] };
  }

  const run = await db.query<Row>(
    "insert into job_runs (started_at, status, trigger_source) values ($1::timestamptz, 'running', $2) returning id",
    [ts(startedAt), deps.trigger ?? "cron"],
  );
  const jobRunId = Number(run.rows[0].id);

  let result: MonitorResult;
  try {
    result = await doRun(deps, clock);
  } catch (e) {
    const msg = sanitizeError(e);
    logger.error("monitor.crashed", { error: msg });
    result = { status: "failed", message: `Monitor crashed: ${msg}`, actions: [], errors: [msg] };
  }

  try {
    await db.query(
      "update job_runs set finished_at = $2::timestamptz, status = $3, duration_ms = $4, message = $5, details = $6::jsonb where id = $1",
      [jobRunId, ts(clock()), result.status, Math.max(0, clock() - startedAt), result.message.slice(0, 500), JSON.stringify({ actions: result.actions, errors: result.errors, evaluation: result.evaluationStatus, price: result.price })],
    );
  } finally {
    await db.query("update job_lock set locked_until = now() where name = $1 and owner = $2", [LOCK_NAME, owner]).catch(() => undefined);
  }
  logger.info("monitor.finished", { status: result.status, actions: result.actions, errors: result.errors, jobRunId });
  return { ...result, jobRunId };
}

const ASSET_FETCH_CONCURRENCY = 4;
const RUN_TIME_BUDGET_MS = 45_000;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

interface AssetFetch {
  h1?: Candle[];
  h4?: Candle[];
  error?: string;
}

interface AssetOutcome {
  symbol: string;
  ok: boolean;
  actions: string[];
  errors: string[];
  evaluationStatus?: string;
  price?: number;
}

/**
 * One pass over every monitored coin. Each coin is processed independently: a failure (bad data, exchange error,
 * even a thrown exception) for one coin never blocks the others.
 */
async function doRun(deps: MonitorDeps, clock: () => number): Promise<MonitorResult> {
  const { db } = deps;
  const settings = await loadSettings(db);
  const assets = await listMonitoredAssets(db);
  if (assets.length === 0) {
    return { status: "success", message: "No coins are selected for monitoring. Add one in Settings → Coins.", actions: [], errors: [] };
  }
  const limit = candlesToFetch(settings);
  const deadline = clock() + RUN_TIME_BUDGET_MS;
  const symbols = assets.map((a) => a.symbol);

  // 1) One request for every ticker.
  let tickers: Map<string, import("./types").Ticker24h | BybitError> | null = null;
  let tickerError: string | null = null;
  try {
    tickers = await fetchTickers(symbols, deps.bybit);
  } catch (e) {
    tickerError = `tickers — ${sanitizeError(e)}`;
  }

  // 2) Klines for each coin (bounded concurrency to respect exchange rate limits).
  const fetched: AssetFetch[] = await mapLimit(assets, ASSET_FETCH_CONCURRENCY, async (a): Promise<AssetFetch> => {
    if (clock() > deadline) return { error: "run time budget exhausted before this coin was fetched" };
    try {
      const [h1, h4] = await Promise.all([fetchKlines(a.symbol, "60", limit, deps.bybit), fetchKlines(a.symbol, "240", limit, deps.bybit)]);
      return { h1, h4 };
    } catch (e) {
      return { error: sanitizeError(e) };
    }
  });

  // 3) Evaluate / trade, one coin at a time (keeps balance updates ordered and deterministic).
  const outcomes: AssetOutcome[] = [];
  for (let i = 0; i < assets.length; i++) {
    const a = assets[i];
    try {
      outcomes.push(await processAsset(deps, clock, settings, a, fetched[i], tickers, tickerError));
    } catch (e) {
      const msg = sanitizeError(e);
      logger.error("monitor.asset_failed", { symbol: a.symbol, error: msg });
      await recordAssetCheck(db, a.symbol, { at: clock(), ok: false, error: msg, price: null, evalStatus: null }).catch(() => undefined);
      outcomes.push({ symbol: a.symbol, ok: false, actions: [], errors: [`${baseOf(a.symbol)}: ${msg}`] });
    }
  }

  const actions = outcomes.flatMap((o) => o.actions);
  const errors = outcomes.flatMap((o) => o.errors);
  const okCount = outcomes.filter((o) => o.ok).length;
  const nowMs = clock();
  const prev = await getKv<{ lastSuccessAt?: number | null }>(db, "market_api");
  await setKv(db, "market_api", okCount > 0
    ? { lastAttemptAt: nowMs, lastSuccessAt: nowMs, lastError: null }
    : { lastAttemptAt: nowMs, lastSuccessAt: prev?.lastSuccessAt ?? null, lastError: errors[0] ?? "unknown", lastErrorAt: nowMs });

  // 4) Emails (queued inside the trade transactions above).
  try {
    const mail = await processEmailQueue(db, { ...deps.email, now: clock });
    if (mail.attempted) actions.push(`Email queue: ${mail.accepted} accepted, ${mail.failed} failed/retrying`);
  } catch (e) {
    errors.push(`email queue — ${sanitizeError(e)}`);
  }

  // 5) Phone notifications (best effort; email remains the reliable channel). Never fails the run.
  try {
    const pushed = await pushNewTrades(db, { ...deps.push, now: clock });
    if (pushed.trades) actions.push(`Push: ${pushed.sent} device notification(s) sent${pushed.failed ? `, ${pushed.failed} failed` : ""}`);
    const pushedSignals = await pushNewSignals(db, { ...deps.push, now: clock });
    if (pushedSignals.signals) actions.push(`Push (LONG/SHORT): ${pushedSignals.sent} device notification(s) sent${pushedSignals.failed ? `, ${pushedSignals.failed} failed` : ""}`);
    const pushedEarly = await pushNewEarly(db, { ...deps.push, now: clock });
    if (pushedEarly.alerts) actions.push(`Push (early heads-up): ${pushedEarly.sent} device notification(s) sent${pushedEarly.failed ? `, ${pushedEarly.failed} failed` : ""}`);
  } catch (e) {
    logger.warn("monitor.push_failed", { error: sanitizeError(e) });
  }

  await maybePrune(db, nowMs).catch((e) => logger.warn("monitor.prune_failed", { error: sanitizeError(e) }));

  const status: MonitorResult["status"] = okCount === 0 ? "failed" : errors.length ? "partial" : "success";
  const message =
    status === "failed"
      ? `Market data unavailable for all coins: ${errors[0] ?? "unknown error"}`
      : `${okCount}/${assets.length} coins checked${actions.length ? ` · ${actions.join(" · ")}` : ""}`;
  return {
    status,
    message,
    actions,
    errors,
    evaluationStatus: outcomes.map((o) => `${baseOf(o.symbol)}:${o.evaluationStatus ?? "n/a"}`).join(" "),
    price: outcomes[0]?.price,
  };
}

async function processAsset(
  deps: MonitorDeps,
  clock: () => number,
  settings: Settings,
  asset: Asset,
  data: AssetFetch,
  tickers: Map<string, import("./types").Ticker24h | BybitError> | null,
  tickerError: string | null,
): Promise<AssetOutcome> {
  const { db } = deps;
  const { symbol } = asset;
  const base = baseOf(symbol);
  const actions: string[] = [];
  const errors: string[] = [];
  const nowMs = clock();
  const H1 = INTERVAL_MS["60"];
  const H4 = INTERVAL_MS["240"];

  // Ticker for this coin (must be recent and consistent with our clock).
  let ticker: import("./types").Ticker24h | null = null;
  const entry = tickers?.get(symbol);
  if (entry && !(entry instanceof BybitError)) {
    const skew = Math.abs(nowMs - entry.serverTime);
    if (skew <= MAX_TICKER_AGE_MS) ticker = entry;
    else errors.push(`${base}: ticker timestamp is ${Math.round(skew / 1000)}s away from server time; price not used.`);
  } else if (entry instanceof BybitError) errors.push(`${base}: ticker — ${sanitizeError(entry)}`);
  else if (tickerError) errors.push(`${base}: ${tickerError}`);
  if (data.error) errors.push(`${base}: klines — ${data.error}`);
  const klinesOk = !!data.h1 && !!data.h4;

  let h1Closed: Candle[] = [];
  let h4Closed: Candle[] = [];
  let evaluation: BuyEvaluation | null = null;
  if (klinesOk) {
    h1Closed = closedCandles(data.h1 as Candle[], H1, nowMs);
    h4Closed = closedCandles(data.h4 as Candle[], H4, nowMs);
    evaluation = evaluateBuy({ h1: h1Closed, h4: h4Closed, now: nowMs, settings });
    await db.query(
      `insert into signal_evaluations (symbol, eval_key, evaluated_at, h1_candle_start, status, conditions, indicators, summary)
       values ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6::jsonb, $7::jsonb, $8)
       on conflict (eval_key) do update set evaluated_at = excluded.evaluated_at, h1_candle_start = excluded.h1_candle_start,
         status = excluded.status, conditions = excluded.conditions, indicators = excluded.indicators, summary = excluded.summary`,
      [
        symbol, `ENTRY:${symbol}:${expectedLastClosedStart(nowMs, H1)}`, ts(nowMs),
        evaluation.h1CandleStart === null ? null : ts(evaluation.h1CandleStart),
        evaluation.status, JSON.stringify(evaluation.conditions), JSON.stringify(evaluation.indicators), evaluation.summary,
      ],
    );
    if (ticker && h1Closed.length && h4Closed.length) {
      // At most one stored snapshot per coin per 5 minutes keeps the table small.
      await db.query(
        `insert into market_snapshots (symbol, captured_at, price, price_change_24h_pct, high_24h, low_24h, volume_24h_base, turnover_24h_usdt, h1_last_closed, h4_last_closed)
         select $1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz
          where not exists (select 1 from market_snapshots where symbol = $1 and captured_at > $2::timestamptz - interval '5 minutes')`,
        [symbol, ts(nowMs), ticker.lastPrice, ticker.change24hPct, ticker.high24h, ticker.low24h, ticker.volume24h, ticker.turnover24h, ts(h1Closed[h1Closed.length - 1].start), ts(h4Closed[h4Closed.length - 1].start)],
      );
    }
    // Re-arm: once the BUY conditions have lapsed, the next match counts as a brand-new signal.
    if (evaluation.status === "NO_SIGNAL" && !asset.signalArmed) {
      await setSignalArmed(db, symbol, true);
      asset = { ...asset, signalArmed: true };
    }
  }

  const h1Snap: TimeframeSnapshot | null = klinesOk && h1Closed.length ? latestSnapshot(h1Closed, settings) : null;
  const h4Snap: TimeframeSnapshot | null = klinesOk && h4Closed.length ? latestSnapshot(h4Closed, settings) : null;

  // ── Exit logic: runs on EVERY pass while a simulated position is open, even for paused coins ──
  const open = await getOpenPosition(db, symbol);
  let justClosed = false;
  let stateLabel: string | null = evaluation?.status ?? null;
  if (open) {
    stateLabel = "POSITION_OPEN";
    if (ticker) {
      const px = roundPrice(ticker.lastPrice);
      const decision = evaluateExit({ position: open, currentPrice: px, h1: h1Snap });
      if (decision.exit && decision.reason) {
        const closed = await closePosition(db, open.id, symbol, px, nowMs, `${decision.reason}: ${decision.detail}`, decision.reason, h1Snap, h4Snap, settings);
        if (closed) {
          justClosed = true;
          stateLabel = "CLOSED_WAITING_REARM";
          actions.push(`${base}: simulated SELL (${decision.reason}) at ${px}`);
        }
      }
    } else {
      errors.push(`${base}: open position could not be evaluated for exit because no fresh price was available.`);
    }
  }

  // ── Entry logic ──
  if (!open && !justClosed && evaluation?.status === "SIGNAL") {
    if (!asset.enabled) stateLabel = "SIGNAL_PAUSED";
    else if (!asset.signalArmed) stateLabel = "SIGNAL_WAITING_REARM";
    else if (!ticker) stateLabel = "SIGNAL_NO_PRICE";
    else {
      const candleClose = (evaluation.h1CandleStart as number) + H1;
      if (nowMs - candleClose > settings.entryWindowMinutes * 60_000) {
        stateLabel = "SIGNAL_WINDOW_PASSED";
      } else {
        const outcome = await openPosition(db, symbol, evaluation, roundPrice(ticker.lastPrice), nowMs, settings);
        actions.push(`${base}: ${outcome}`);
        stateLabel = "POSITION_OPEN";
      }
    }
  }

  // ── LONG / SHORT / NEUTRAL analysis: independent of the BUY/SELL logic above and can never break it ──
  if (klinesOk && h1Closed.length && h4Closed.length) {
    try {
      const spot = open && !justClosed ? "a simulated spot position is open (SELL watching)" : justClosed ? "a simulated spot position was just closed (SELL)" : stateLabel === "POSITION_OPEN" ? "a simulated spot position was just opened (BUY)" : evaluation?.status === "SIGNAL" ? "the BUY conditions are met" : "no BUY signal";
      const dir = await processDirectional(db, { symbol, enabled: asset.enabled, settings, h1Closed, h4Closed, nowMs, spotContext: spot });
      actions.push(...dir.actions);
    } catch (e) {
      logger.warn("monitor.directional_failed", { symbol, error: sanitizeError(e) });
      actions.push(`${base}: LONG/SHORT analysis could not run this time (BUY/SELL unaffected)`);
    }
  }

  // ── Early, unconfirmed heads-up: separate, opens no position, and can never break anything above ──
  if (klinesOk && h1Closed.length && h4Closed.length) {
    try {
      const buyHandled = Boolean(open) || justClosed || evaluation?.status === "SIGNAL";
      actions.push(...(await processEarly(db, { symbol, enabled: asset.enabled, settings, h1Closed, h4Closed, nowMs, buyHandled })));
    } catch (e) {
      logger.warn("monitor.early_failed", { symbol, error: sanitizeError(e) });
    }
  }

  const ok = klinesOk && ticker !== null;
  await recordAssetCheck(db, symbol, {
    at: nowMs, ok, error: errors[0] ?? null, price: ticker?.lastPrice ?? null, evalStatus: ok ? stateLabel : evaluation ? stateLabel : null,
  });
  return { symbol, ok, actions, errors, evaluationStatus: stateLabel ?? undefined, price: ticker?.lastPrice };
}

async function openPosition(db: Db, symbol: string, ev: BuyEvaluation, price: number, nowMs: number, settings: Settings): Promise<string> {
  const candleStart = ev.h1CandleStart as number;
  try {
    return await db.tx(async (q) => {
      const acct = (await q.query<Row>("select available_balance from paper_account where id = 1 for update")).rows[0];
      const available = Number(acct.available_balance);
      const amount = settings.positionAmountUsdt;
      if (amount > available + 1e-9) {
        return `BUY conditions met, but the simulated balance (${available.toFixed(2)} USDT) is below the position amount (${amount} USDT); no entry.`;
      }
      const qty = simulatedQuantity(amount, price);
      const reason = `${ev.summary} ${ev.conditions.filter((c) => c.evaluated).map((c) => `${c.passed ? "✓" : "✗"} ${c.label} (${c.detail})`).join("; ")}`;
      const pos = (
        await q.query<Row>(
          `insert into paper_positions (symbol, status, entry_candle_start, opened_at, entry_price, amount_usdt, quantity, fee_rate_pct, stop_loss_pct, take_profit_pct, trend_exit_enabled, entry_reason, entry_indicators)
           values ($12, 'open', $1::timestamptz, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb) returning id`,
          [ts(candleStart), ts(nowMs), price, amount, qty, settings.feeRatePct, settings.stopLossPct, settings.takeProfitPct, settings.trendExitEnabled, reason, JSON.stringify(ev.indicators), symbol],
        )
      ).rows[0];
      const positionId = Number(pos.id);
      const trade = (
        await q.query<Row>(
          `insert into paper_trades (symbol, position_id, event_type, event_key, occurred_at, price, amount_usdt, quantity, reason, indicators)
           values ($9, $1, 'BUY', $2, $3::timestamptz, $4, $5, $6, $7, $8::jsonb) returning id`,
          [positionId, `BUY:${symbol}:${candleStart}`, ts(nowMs), price, amount, qty, reason, JSON.stringify(ev.indicators), symbol],
        )
      ).rows[0];
      await q.query("update paper_account set available_balance = $1, updated_at = now() where id = 1", [balanceAfterOpen(available, amount)]);
      const message = buildTradeEmail({
        symbol, type: "BUY", price, at: nowMs, reason, h1: ev.indicators.h1, h4: ev.indicators.h4,
        amountUsdt: amount, quantity: qty, entryPrice: price, feeRatePct: settings.feeRatePct,
      });
      await queueTradeEmail(q, { tradeId: Number(trade.id), kind: "BUY", settings, message });
      return `simulated BUY of ${amount} USDT (${qty.toFixed(8)} ${baseOf(symbol)}) at ${price}`;
    });
  } catch (e) {
    if (isUniqueViolation(e)) return "duplicate simulated entry prevented (this candle already produced an entry, or a position is open).";
    throw e;
  }
}

async function closePosition(
  db: Db, positionId: number, symbol: string, price: number, nowMs: number, reason: string, exitReason: string,
  h1: TimeframeSnapshot | null, h4: TimeframeSnapshot | null, settings: Settings,
): Promise<boolean> {
  return db.tx(async (q) => {
    const row = (await q.query<Row>("select * from paper_positions where id = $1 and status = 'open' for update", [positionId])).rows[0];
    if (!row) return false; // already closed by a concurrent run
    const pos = mapPosition(row);
    const calc = computeClose({ amountUsdt: pos.amountUsdt, entryPrice: pos.entryPrice, exitPrice: price, feeRatePct: pos.feeRatePct, quantity: pos.quantity });
    await q.query(
      `update paper_positions set status = 'closed', closed_at = $2::timestamptz, exit_price = $3, exit_reason = $4,
         gross_pnl = $5, entry_fee = $6, exit_fee = $7, net_pnl = $8 where id = $1 and status = 'open'`,
      [positionId, ts(nowMs), price, exitReason, calc.grossPnl, calc.entryFee, calc.exitFee, calc.netPnl],
    );
    const trade = await q.query<Row>(
      `insert into paper_trades (symbol, position_id, event_type, event_key, occurred_at, price, amount_usdt, quantity, reason, indicators, gross_pnl, entry_fee, exit_fee, net_pnl)
       values ($13, $1, 'SELL', $2, $3::timestamptz, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
       on conflict (event_key) do nothing returning id`,
      [positionId, `SELL:${positionId}`, ts(nowMs), price, pos.amountUsdt, pos.quantity, reason, JSON.stringify({ h1, h4 }), calc.grossPnl, calc.entryFee, calc.exitFee, calc.netPnl, symbol],
    );
    // Disarm: the next BUY alert for this coin requires the entry conditions to lapse and then match again.
    await q.query("update assets set signal_armed = false where symbol = $1", [symbol]);
    const acct = (await q.query<Row>("select available_balance from paper_account where id = 1 for update")).rows[0];
    await q.query("update paper_account set available_balance = $1, updated_at = now() where id = 1", [balanceAfterClose(Number(acct.available_balance), pos.amountUsdt, calc.netPnl)]);
    if (trade.rows[0]) {
      const message = buildTradeEmail({
        symbol, type: "SELL", price, at: nowMs, reason, h1, h4, amountUsdt: pos.amountUsdt, quantity: pos.quantity,
        entryPrice: pos.entryPrice, exitPrice: price, grossPnl: calc.grossPnl, entryFee: calc.entryFee, exitFee: calc.exitFee,
        netPnl: calc.netPnl, feeRatePct: pos.feeRatePct,
      });
      await queueTradeEmail(q, { tradeId: Number(trade.rows[0].id), kind: "SELL", settings, message });
    }
    return true;
  });
}

async function maybePrune(db: Db, nowMs: number): Promise<void> {
  const last = await getKv<{ at: number }>(db, "last_prune");
  if (last && nowMs - last.at < 6 * 3600_000) return;
  await db.query("delete from market_snapshots where captured_at < $1::timestamptz", [ts(nowMs - 7 * 24 * 3600_000)]);
  await db.query("delete from job_runs where started_at < $1::timestamptz", [ts(nowMs - 14 * 24 * 3600_000)]);
  await db.query("delete from signal_evaluations where evaluated_at < $1::timestamptz", [ts(nowMs - 60 * 24 * 3600_000)]);
  await pruneRateLimits(db, nowMs);
  await setKv(db, "last_prune", { at: nowMs });
}
