import type { Db, Queryable, Row } from "./db";
import type { EmailMessage } from "./email";
import { fmtPrice, pairLabel } from "./format";
import { checkContinuity, computeSeries, expectedLastClosedStart, requiredCandles } from "./rules";
import { fmtUtc, toMs } from "./time";
import { INTERVAL_MS, type Candle, type Settings } from "./types";

/**
 * EARLY, UNCONFIRMED heads-up: "this coin may be turning up". It is deliberately separate from the strict BUY signal.
 * It opens NO paper position, places NO order and is never counted in performance. The strict BUY rule still decides
 * what the paper account does; this only tells the person to go and look at the chart.
 */
export const EARLY = {
  cooldownMs: 6 * 3600_000,
  reclaimWithin: 3,
  rsiMin: 42,
  rsiMax: 62,
  minRiseAtr: 0.8,
  maxRiseAtr: 4,
  maxStretchAtr: 1.5,
  minVolumeRatio: 1,
  lowLookback: 24,
} as const;

export interface EarlyResult {
  triggered: boolean;
  /** Human-readable pass/fail checks (also used to explain why nothing fired). */
  checks: Array<{ id: string; label: string; passed: boolean; detail: string }>;
  price: number | null;
  candleStart: number | null;
  reasons: string[];
}

const none = (why: string): EarlyResult => ({ triggered: false, checks: [{ id: "data", label: "Market data usable", passed: false, detail: why }], price: null, candleStart: null, reasons: [] });

export function detectEarly(input: { h1: Candle[]; h4: Candle[]; now: number; settings: Settings }): EarlyResult {
  const { h1, h4, now, settings: s } = input;
  const need = requiredCandles(s);
  const H1 = INTERVAL_MS["60"];
  const H4 = INTERVAL_MS["240"];
  if (h1.length < need || h4.length < need) return none("Not enough completed candles.");
  if (!checkContinuity(h1, H1, need).ok || !checkContinuity(h4, H4, need).ok) return none("Gap in the candle data.");
  const last = h1[h1.length - 1];
  if (last.start < expectedLastClosedStart(now, H1) || h4[h4.length - 1].start < expectedLastClosedStart(now, H4)) return none("Market data is stale.");

  const i = h1.length - 1;
  const s1 = computeSeries(h1, s);
  const s4 = computeSeries(h4, s);
  const fast = s1.emaFast, hist = s1.macdHist, rsi = s1.rsi, atr = s1.atr[i];
  const closes = h1.map((c) => c.close);
  const j = h4.length - 1;
  if (atr === null || !(atr > 0) || fast[i] === null || hist[i] === null || hist[i - 1] === null || hist[i - 3] === null || rsi[i] === null || rsi[i - 3] === null || s4.macdHist[j] === null || s4.macdHist[j - 1] === null) {
    return none("An indicator could not be computed.");
  }

  // Fresh reclaim: the close is above EMA fast now, and one of the last few closes was at/below it.
  const above = closes[i] > (fast[i] as number);
  let recentBelow = false;
  for (let k = 1; k <= EARLY.reclaimWithin; k++) {
    const f = fast[i - k];
    if (f !== null && closes[i - k] <= f) recentBelow = true;
  }
  const lowest = Math.min(...h1.slice(-EARLY.lowLookback).map((c) => c.low));
  const rise = (last.close - lowest) / atr;
  const stretch = (last.close - (fast[i] as number)) / atr;
  const prev = h1.slice(-21, -1);
  const avgVol = prev.reduce((a, c) => a + c.volume, 0) / prev.length;
  const volRatio = avgVol > 0 ? last.volume / avgVol : 0;
  const r = rsi[i] as number;

  const checks = [
    { id: "reclaim", label: `Price just closed back above EMA${s.emaFast} (after being at/below it in the last ${EARLY.reclaimWithin} candles)`, passed: above && recentBelow, detail: `Close ${fmtPrice(last.close)} vs EMA${s.emaFast} ${fmtPrice(fast[i])}` },
    { id: "macd_turning", label: "1h MACD momentum is turning up", passed: (hist[i] as number) > (hist[i - 1] as number) && (hist[i] as number) > (hist[i - 3] as number), detail: `Histogram ${(hist[i] as number).toPrecision(3)} (was ${(hist[i - 3] as number).toPrecision(3)} three candles ago)` },
    { id: "rsi_rising", label: `1h RSI between ${EARLY.rsiMin} and ${EARLY.rsiMax} and rising`, passed: r >= EARLY.rsiMin && r <= EARLY.rsiMax && r > (rsi[i - 3] as number), detail: `RSI ${r.toFixed(1)} (was ${(rsi[i - 3] as number).toFixed(1)} three candles ago)` },
    { id: "early_stage", label: `Bounce is real but still early (${EARLY.minRiseAtr}–${EARLY.maxRiseAtr}× ATR above the ${EARLY.lowLookback}h low)`, passed: rise >= EARLY.minRiseAtr && rise <= EARLY.maxRiseAtr, detail: `${rise.toFixed(1)}× ATR above ${fmtPrice(lowest)}` },
    { id: "not_stretched", label: `Not stretched (within ${EARLY.maxStretchAtr}× ATR of EMA${s.emaFast})`, passed: stretch <= EARLY.maxStretchAtr, detail: `${stretch.toFixed(2)}× ATR` },
    { id: "volume", label: "Volume at least average (buyers are present)", passed: volRatio >= EARLY.minVolumeRatio, detail: `${volRatio.toFixed(2)}× average` },
    { id: "h4_turning", label: "4h MACD momentum is also turning up", passed: (s4.macdHist[j] as number) > (s4.macdHist[j - 1] as number), detail: `4h histogram ${(s4.macdHist[j] as number).toPrecision(3)} (was ${(s4.macdHist[j - 1] as number).toPrecision(3)})` },
  ];
  const triggered = checks.every((c) => c.passed);
  return {
    triggered,
    checks,
    price: last.close,
    candleStart: last.start,
    reasons: checks.filter((c) => c.passed).map((c) => `${c.label} — ${c.detail}`),
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const EARLY_NOTE =
  "EARLY HEADS-UP — UNCONFIRMED. The coin may be turning up, but the strict BUY conditions are NOT met yet, so the app has NOT opened a paper trade and placed no order. Many early turns fail. Look at the chart yourself before doing anything.";

export function buildEarlyEmail(d: { symbol: string; result: EarlyResult; evaluatedAt: number }): EmailMessage {
  const pair = pairLabel(d.symbol);
  const price = fmtPrice(d.result.price);
  const subject = `[Crypto Sentinel] EARLY heads-up (unconfirmed) · ${pair} @ ${price}`;
  const text = [
    `CRYPTO SENTINEL — EARLY HEADS-UP · ${pair}`,
    "",
    EARLY_NOTE,
    "",
    `Reference price: ${price} USDT (close of the 1h candle that started ${fmtUtc(d.result.candleStart)})`,
    `Evaluated: ${fmtUtc(d.evaluatedAt)}`,
    "",
    "Why it was flagged:",
    ...d.result.reasons.map((r) => `  • ${r}`),
    "",
    "It can fail if price falls back under the EMA or the next 1h candle closes weak. This is not a prediction, a recommendation or financial advice.",
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f3f5fa;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:24px 16px"><div style="background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e7f3">
<div style="background:#0a0f1e;padding:16px 20px"><span style="color:#7aa2ff;font-weight:700">◆</span> <span style="color:#e7ebf7;font-weight:600">Crypto Sentinel</span> <span style="color:#7482a6;font-size:12px">· early heads-up</span></div>
<div style="padding:20px">
<div style="display:inline-block;padding:4px 10px;border-radius:999px;background:#f0b90b;color:#1a1400;font-size:12px;font-weight:700">${esc(pair)} · EARLY · UNCONFIRMED</div>
<p style="margin:14px 0 0;padding:10px;border-radius:8px;background:#fff7e6;border:1px solid #ffe2a8;color:#7a5200;font-size:13px;line-height:1.5">${esc(EARLY_NOTE)}</p>
<p style="margin:14px 0 0;color:#0b1020;font-size:15px;font-weight:600">Reference price ${esc(price)} USDT</p>
<p style="margin:4px 0 0;color:#6b7694;font-size:12px">1h candle ${esc(fmtUtc(d.result.candleStart))} · evaluated ${esc(fmtUtc(d.evaluatedAt))}</p>
<h3 style="margin:18px 0 0;font-size:13px;color:#6b7694;text-transform:uppercase;letter-spacing:.6px">Why it was flagged</h3>
<ul style="margin:6px 0 0;padding-left:18px;color:#26304d;font-size:13px;line-height:1.5">${d.result.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
<p style="margin:18px 0 0;color:#26304d;font-size:13px;line-height:1.5">It can fail if price falls back under the EMA or the next 1h candle closes weak. This is not a prediction, a recommendation or financial advice.</p>
</div></div></div></body></html>`;
  return { subject, text, html };
}

export interface EarlyInput {
  symbol: string;
  enabled: boolean;
  settings: Settings;
  h1Closed: Candle[];
  h4Closed: Candle[];
  nowMs: number;
  /** True when the strict BUY is already met or a paper position is open for this coin (then an early heads-up adds nothing). */
  buyHandled: boolean;
}

/** Evaluates one coin and, if it qualifies (once per candle, once per cooldown window), stores the alert and queues the email. */
export async function processEarly(db: Db, input: EarlyInput): Promise<string[]> {
  const { symbol, settings, nowMs } = input;
  if (!settings.earlyAlertsEnabled || !input.enabled || input.buyHandled) return [];
  const res = detectEarly({ h1: input.h1Closed, h4: input.h4Closed, now: nowMs, settings });
  if (!res.triggered || res.candleStart === null || res.price === null) return [];
  const H1 = INTERVAL_MS["60"];
  if (nowMs - (res.candleStart + H1) > settings.entryWindowMinutes * 60_000) return []; // too old to be a heads-up
  const message = buildEarlyEmail({ symbol, result: res, evaluatedAt: nowMs });
  const base = symbol.replace(/USDT$/, "");
  return db.tx(async (q) => {
    await q.query("select pg_advisory_xact_lock(hashtext($1))", [`early:${symbol}`]);
    const recent = await q.query<Row>("select 1 from early_alerts where symbol = $1 and created_at > now() - ($2::int * interval '1 millisecond')", [symbol, EARLY.cooldownMs]);
    if (recent.rows.length > 0) return [];
    const ins = await q.query<Row>(
      "insert into early_alerts (symbol, candle_start, price, payload) values ($1, $2::timestamptz, $3, $4::jsonb) on conflict do nothing returning id",
      [symbol, new Date(res.candleStart as number).toISOString(), res.price, JSON.stringify(res)],
    );
    if (!ins.rows[0]) return [];
    const id = Number(ins.rows[0].id);
    await q.query(
      `insert into email_notifications (dedupe_key, kind, recipient, subject, text_body, html_body, status)
       values ($1, 'EARLY', $2, $3, $4, $5, 'queued') on conflict (dedupe_key) do nothing`,
      [`early:${id}`, settings.emailRecipient, message.subject, message.text, message.html],
    );
    return [`${base}: EARLY heads-up (unconfirmed, no paper trade) at ${fmtPrice(res.price)}`];
  });
}

export interface EarlyRow { id: number; symbol: string; candleStart: number; price: number; createdAt: number }

export async function listEarly(q: Queryable, limit = 10): Promise<EarlyRow[]> {
  const r = await q.query<Row>("select id, symbol, candle_start, price, created_at from early_alerts order by id desc limit $1", [limit]);
  return r.rows.map((x) => ({ id: Number(x.id), symbol: String(x.symbol), candleStart: toMs(x.candle_start) as number, price: Number(x.price), createdAt: toMs(x.created_at) as number }));
}
