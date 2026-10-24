import type { Queryable, Row } from "./db";
import type { DirectionalAssessment } from "./directional";
import { MAX_HOLD_BARS } from "./directional";
import { fmtPrice, pairLabel } from "./format";
import { fmtUtc } from "./time";
import type { Settings } from "./types";
import type { EmailMessage } from "./email";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const trendWord = (t: string) => (t === "UP" ? "uptrend" : t === "DOWN" ? "downtrend" : t === "SIDEWAYS" ? "sideways / mixed" : "unknown");

export const SIGNAL_TYPE_NOTE =
  "This is the LONG/SHORT directional analysis. It is separate from the BUY/SELL spot paper-trading alerts: a SELL there only closes a simulated spot position and is never a SHORT. " +
  "LONG/SHORT setups open no paper position and place no order; their outcomes are only tracked to measure how the rules would have fared.";

export const NO_TRADE_NOTICE =
  "NO REAL TRADE WAS EXECUTED. Levels are analytical reference estimates, not predictions, guarantees or financial advice. Figures include estimated fees/slippage only; real fills, funding, leverage and liquidity can differ.";

export function buildDirectionalEmail(d: { symbol: string; direction: "LONG" | "SHORT"; assessment: DirectionalAssessment; evaluatedAt: number; spotContext?: string }): EmailMessage {
  const a = d.assessment;
  const lv = a.levels!;
  const pair = pairLabel(d.symbol);
  const p = fmtPrice;
  const rows: Array<[string, string]> = [
    ["Direction", `${d.direction} (analysis)`],
    ["Pair", `${pair} (Bybit spot data)`],
    ["Reference price", `${p(a.price)} USDT (close of the 1h candle that started ${fmtUtc(a.candleStart)})`],
    ["Evaluated", fmtUtc(d.evaluatedAt)],
    ["Entry reference", `${p(lv.entry)} USDT`],
    ["Stop-loss reference", `${p(lv.stop)} USDT (${lv.riskPct.toFixed(2)}% ${d.direction === "LONG" ? "below" : "above"}, 1.5 × ATR)`],
    ["Take-profit reference", `${p(lv.takeProfit)} USDT (${lv.rewardPct.toFixed(2)}% ${d.direction === "LONG" ? "above" : "below"}, ${lv.targetBasis === "swing" ? "capped at the nearest support/resistance" : "2 × risk"})`],
    ["Estimated reward/risk", `${lv.riskReward.toFixed(2)} (about ${lv.netRiskReward.toFixed(2)} after estimated costs)`],
    ["1h trend", trendWord(a.h1Trend)],
    ["4h trend (confirmation)", trendWord(a.h4Trend)],
    ["Estimated round-trip costs", `${a.costs.roundTripPct.toFixed(2)}% (fees ${a.costs.feePerSidePct}% + slippage ${a.costs.slippagePerSidePct}% per side)`],
  ];
  const subject = `[Crypto Sentinel] ${d.direction} analysis · ${pair} @ ${p(a.price)} · R/R ${lv.riskReward.toFixed(1)}`;
  const context = d.spotContext ? `Current BUY/SELL (spot paper) state for ${pair}: ${d.spotContext}` : "";
  const text = [
    `CRYPTO SENTINEL — ${d.direction} ANALYSIS · ${pair}`,
    "",
    SIGNAL_TYPE_NOTE,
    ...(context ? ["", context] : []),
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    "",
    "Why this setup appeared:",
    ...a.reasons.map((r) => `  • ${r}`),
    "",
    "What would invalidate it:",
    ...a.invalidations.map((r) => `  • ${r}`),
    "",
    `Limitations: ${a.limitations.join(" ")}`,
    "",
    NO_TRADE_NOTICE,
  ].join("\n");

  const accent = d.direction === "LONG" ? "#2ebd85" : "#f6465d";
  const tr = (k: string, v: string) => `<tr><td style="padding:6px 12px 6px 0;color:#6b7694;font-size:13px;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0;color:#0b1020;font-size:14px;font-weight:500">${esc(v)}</td></tr>`;
  const li = (items: string[]) => `<ul style="margin:6px 0 0;padding-left:18px;color:#26304d;font-size:13px;line-height:1.5">${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
  const html = `<!doctype html><html><body style="margin:0;background:#f3f5fa;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:24px 16px"><div style="background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e7f3">
<div style="background:#0a0f1e;padding:16px 20px"><span style="color:#7aa2ff;font-weight:700">◆</span> <span style="color:#e7ebf7;font-weight:600">Crypto Sentinel</span> <span style="color:#7482a6;font-size:12px">· directional analysis</span></div>
<div style="padding:20px">
<div style="display:inline-block;padding:4px 10px;border-radius:999px;background:${accent};color:#fff;font-size:12px;font-weight:700">${esc(pair)} · ${d.direction} ANALYSIS</div>
<p style="margin:14px 0 0;padding:10px;border-radius:8px;background:#eef3ff;border:1px solid #cfdcff;color:#26304d;font-size:13px;line-height:1.5">${esc(SIGNAL_TYPE_NOTE)}</p>
${context ? `<p style="margin:10px 0 0;color:#26304d;font-size:13px">${esc(context)}</p>` : ""}
<table role="presentation" style="margin-top:10px;border-collapse:collapse;width:100%">${rows.map(([k, v]) => tr(k, v)).join("")}</table>
<h3 style="margin:18px 0 0;font-size:13px;color:#6b7694;text-transform:uppercase;letter-spacing:.6px">Why this setup appeared</h3>${li(a.reasons)}
<h3 style="margin:18px 0 0;font-size:13px;color:#6b7694;text-transform:uppercase;letter-spacing:.6px">What would invalidate it</h3>${li(a.invalidations)}
<h3 style="margin:18px 0 0;font-size:13px;color:#6b7694;text-transform:uppercase;letter-spacing:.6px">Limitations</h3>${li(a.limitations)}
<p style="margin:20px 0 0;padding:12px;border-radius:8px;background:#fff7e6;border:1px solid #ffe2a8;color:#7a5200;font-size:13px;line-height:1.5"><strong>No real trade was executed.</strong> ${esc(NO_TRADE_NOTICE.replace("NO REAL TRADE WAS EXECUTED. ", ""))} Setup expires after ${MAX_HOLD_BARS} hourly candles.</p>
</div></div></div></body></html>`;
  return { subject, text, html };
}

/** Inserts a notification row INSIDE the caller's transaction. A repeated signal id is a no-op. */
export async function queueDirectionalEmail(
  q: Queryable,
  p: { signalId: number; kind: "LONG" | "SHORT"; settings: Settings; message: EmailMessage },
): Promise<{ queued: boolean; skipped: boolean }> {
  const enabled = p.settings.directionalEmailEnabled;
  const r = await q.query<Row>(
    `insert into email_notifications (dedupe_key, kind, signal_id, recipient, subject, text_body, html_body, status, last_error)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (dedupe_key) do nothing returning id`,
    [`signal:${p.signalId}`, p.kind, p.signalId, p.settings.emailRecipient, p.message.subject, p.message.text, p.message.html, enabled ? "queued" : "skipped", enabled ? null : "LONG/SHORT email alerts are turned off in settings"],
  );
  return { queued: r.rows.length > 0 && enabled, skipped: r.rows.length > 0 && !enabled };
}
