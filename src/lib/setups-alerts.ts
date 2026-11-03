import { priceAuditRows, type EmailMessage } from "./email";
import { fmtPrice, pairLabel } from "./format";
import { validityText, type SetupState } from "./lifecycle";
import { STRATEGY_LABEL, type StrategyId } from "./setups";
import { priceDiff, signalAgeMinutes, type PriceRef } from "./priceaudit";
import { ageLabel, fmtUtc } from "./time";

/**
 * Text for setup alerts. Every alert states: coin, strategy, status (and whether it is confirmed), signal time and
 * price, the latest price, timeframe, the reasons with numbers, age, validity/expiry, and that nothing is guaranteed.
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const SETUP_DISCLAIMER =
  "Educational analysis only. No real order was placed and none will be. This is not a prediction, a recommendation or financial advice, and nothing here is guaranteed: setups regularly fail.";

export function statusLabel(strategy: StrategyId, kind: "POTENTIAL" | "CONFIRMED" | "WATCH" | "EXPIRED"): string {
  if (kind === "POTENTIAL") return strategy === "EXIT_WARNING" ? "POTENTIAL EXIT WARNING (early, unconfirmed)" : "POTENTIAL BUY (early, unconfirmed)";
  if (kind === "CONFIRMED") return strategy === "EXIT_WARNING" ? "CONFIRMED EXIT WARNING" : "CONFIRMED BUY SETUP";
  return kind;
}

export function confirmationText(kind: "POTENTIAL" | "CONFIRMED"): string {
  return kind === "CONFIRMED"
    ? "CONFIRMED: the required conditions hold on a CLOSED 1H candle."
    : "NOT CONFIRMED: this is based on the 1H candle that is still forming. It can disappear before the candle closes.";
}

export interface SetupAlert {
  symbol: string;
  strategy: StrategyId;
  kind: "POTENTIAL" | "CONFIRMED";
  state: SetupState;
  now: number;
  latestPrice: number | null;
  /** Immutable price snapshot of this signal (source, exchange time, index price, bid/ask). */
  ref?: PriceRef | null;
}

export function buildSetupEmail(a: SetupAlert): EmailMessage {
  const pair = pairLabel(a.symbol);
  const s = a.state;
  const label = statusLabel(a.strategy, a.kind);
  const strat = STRATEGY_LABEL[a.strategy];
  const sp = s.signalPrice;
  const move = sp !== null && a.latestPrice !== null && sp > 0 ? ((a.latestPrice - sp) / sp) * 100 : null;
  const subject = `[Crypto Sentinel] ${label} · ${strat} · ${pair} @ ${fmtPrice(sp)}`;
  const rows: Array<[string, string]> = [
    ["Coin", `${pair} (Bybit spot data)`],
    ["Strategy", strat],
    ["Status", label],
    ["Confirmation", confirmationText(a.kind)],
    ["Timeframe", "1H setup, 4H context (the market is rescanned continuously; see the Health panel for the observed rate)"],
    ["Signal time (UTC)", fmtUtc(s.signalPriceAt)],
    ["Signal price", `${fmtPrice(sp)} USDT`],
    ["Latest price", `${fmtPrice(a.latestPrice)} USDT${move === null ? "" : ` (${move >= 0 ? "+" : "−"}${Math.abs(move).toFixed(2)}% since the signal)`}`],
    ["Price difference since the signal", (() => { const d = priceDiff(sp, a.latestPrice); return d === null ? "n/a" : `${d.abs >= 0 ? "+" : "−"}${fmtPrice(Math.abs(d.abs))} USDT (${d.pct >= 0 ? "+" : "−"}${Math.abs(d.pct).toFixed(3)}%); the reference price is kept, never replaced`; })()],
    ["Signal age", `${ageLabel(s.signalPriceAt, a.now)} (${signalAgeMinutes(s.signalPriceAt, a.now) ?? "n/a"} min)`],
    ...priceAuditRows(a.ref),
    ["Validity", validityText(s, a.now)],
  ];
  if (s.levels) {
    rows.push(["Stop reference", `${fmtPrice(s.levels.stop)} USDT (${s.levels.riskPct.toFixed(2)}% away)`]);
    rows.push(["Target reference", `${fmtPrice(s.levels.target)} USDT (${s.levels.targetBasis === "resistance" ? "next resistance" : "2 × risk"})`]);
    rows.push(["Net reward/risk (after costs)", s.levels.netRiskReward.toFixed(2)]);
  }
  const intro = a.strategy === "EXIT_WARNING"
    ? "EXIT WARNING: bearish conditions are developing. If you hold this coin you may want to review it. This is NOT a short signal and it did not change any paper trade."
    : a.strategy === "BOUNCE"
      ? "SUPPORT-BOUNCE: price is at an established support area with signs of recovery. This setup is tracked separately and did NOT open a paper trade."
      : "TREND BUY (early read): the trend-following BUY conditions appear to be met on the unfinished candle.";
  const text = [
    `CRYPTO SENTINEL — ${label} · ${strat} · ${pair}`,
    "",
    intro,
    "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    "",
    "Why (conditions that passed):",
    ...s.reasons.map((r) => `  • ${r}`),
    "",
    SETUP_DISCLAIMER,
  ].join("\n");
  const accent = a.kind === "CONFIRMED" ? (a.strategy === "EXIT_WARNING" ? "#f6465d" : "#2ebd85") : "#f0b90b";
  const tr = (k: string, v: string) => `<tr><td style="padding:6px 12px 6px 0;color:#6b7694;font-size:13px;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0;color:#0b1020;font-size:14px;font-weight:500">${esc(v)}</td></tr>`;
  const html = `<!doctype html><html><body style="margin:0;background:#f3f5fa;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:24px 16px"><div style="background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e7f3">
<div style="background:#0a0f1e;padding:16px 20px"><span style="color:#7aa2ff;font-weight:700">◆</span> <span style="color:#e7ebf7;font-weight:600">Crypto Sentinel</span> <span style="color:#7482a6;font-size:12px">· ${esc(strat)}</span></div>
<div style="padding:20px">
<div style="display:inline-block;padding:4px 10px;border-radius:999px;background:${accent};color:${a.kind === "CONFIRMED" ? "#fff" : "#1a1400"};font-size:12px;font-weight:700">${esc(pair)} · ${esc(label)}</div>
<p style="margin:14px 0 0;padding:10px;border-radius:8px;background:#eef3ff;border:1px solid #cfdcff;color:#26304d;font-size:13px;line-height:1.5">${esc(intro)}</p>
<table role="presentation" style="margin-top:10px;border-collapse:collapse;width:100%">${rows.map(([k, v]) => tr(k, v)).join("")}</table>
<h3 style="margin:18px 0 0;font-size:13px;color:#6b7694;text-transform:uppercase;letter-spacing:.6px">Why this alert appeared</h3>
<ul style="margin:6px 0 0;padding-left:18px;color:#26304d;font-size:13px;line-height:1.5">${s.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
<p style="margin:20px 0 0;padding:12px;border-radius:8px;background:#fff7e6;border:1px solid #ffe2a8;color:#7a5200;font-size:13px;line-height:1.5">${esc(SETUP_DISCLAIMER)}</p>
</div></div></div></body></html>`;
  return { subject, text, html };
}

export function setupPushPayload(a: { symbol: string; strategy: StrategyId; kind: "POTENTIAL" | "CONFIRMED"; signalPrice: number | null; latestPrice: number | null; at: number; now: number }) {
  const pair = pairLabel(a.symbol);
  const early = a.kind === "POTENTIAL";
  const title = `${early ? "EARLY · unconfirmed" : "CONFIRMED"} · ${STRATEGY_LABEL[a.strategy]} · ${pair}`;
  const body = `${early ? "Candle still open. " : "Closed-candle conditions met. "}Signal ${fmtPrice(a.signalPrice)} at ${new Date(a.at).toISOString().slice(11, 19)} UTC · latest ${fmtPrice(a.latestPrice)} · ${ageLabel(a.at, a.now)}. Analysis only, no order placed, not guaranteed.`;
  return { title, body, tag: `setup-${a.symbol}-${a.strategy}-${a.kind}`, url: "/" };
}
