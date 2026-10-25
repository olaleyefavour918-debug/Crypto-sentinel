import type { DirectionRow, SignalRow } from "./directional-run";
import { STANDING_LIMITATIONS, MAX_HOLD_BARS, type PerfStats } from "./directional";
import { baseOf, fmtPrice } from "./format";
import type { Asset, EvaluationRow, Position, TradeEvent } from "./store";
import { ageLabel, fmtUtcShort } from "./time";
import type { Condition, Settings } from "./types";

/**
 * Built-in, rule-based assistant. No AI model, no external service, nothing invented: every answer is assembled from
 * the data the app has actually stored (latest assessments, BUY conditions, positions, signals, performance).
 * When something is not available it says so.
 */

export interface AssistantContext {
  now: number;
  settings: Settings;
  assets: Asset[];
  directional: DirectionRow[];
  signals: SignalRow[];
  stats: PerfStats;
  evaluations: EvaluationRow[];
  positions: Position[];
  trades: TradeEvent[];
}

export interface AssistantAnswer {
  topic: string;
  answer: string;
  symbols: string[];
  /** Things the assistant wanted to say but had no data for. */
  missing: string[];
}

export const SIGNAL_GUIDE = [
  "BUY / SELL — the original spot paper-trading rules. BUY opens a simulated spot position when the 1h and 4h trend, RSI and MACD conditions line up; SELL closes that simulated position (stop, target or trend exit). SELL only ever means 'exit a spot holding'; it is NOT a short.",
  "LONG / SHORT — a separate directional analysis. LONG = conditions favour upward movement, SHORT = conditions favour downward movement. Each comes with reference entry, stop and target levels. They open no paper position and place no order; their outcomes are tracked only to measure performance.",
  "EARLY heads-up — an unconfirmed notice that a coin may be turning up before the strict BUY conditions are met. It opens no paper position and places no order, and many early turns fail, so it is only a prompt to look at the chart yourself. At most one per coin every 6 hours.",
  "NEUTRAL — conditions are unclear, contradictory or too weak (or reward/risk is poor after costs), so nothing is signalled.",
  "So a BUY is not automatically a futures LONG, and a SELL is not automatically a SHORT. You can see BUY and SHORT (or SELL and LONG) at the same time because they answer different questions.",
].join("\n");

const NAMES: Record<string, string> = { bitcoin: "BTC", ethereum: "ETH", ether: "ETH", solana: "SOL", ripple: "XRP", binance: "BNB" };

const bullets = (xs: string[]) => xs.map((x) => `• ${x}`).join("\n");
const sign = (n: number, dp = 2) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(dp)}`;
const trendWord = (t: string) => (t === "UP" ? "uptrend" : t === "DOWN" ? "downtrend" : t === "SIDEWAYS" ? "sideways / mixed" : "unknown");

function findSymbols(q: string, ctx: AssistantContext, hint?: string): string[] {
  const found = new Set<string>();
  const lower = q.toLowerCase();
  for (const a of ctx.assets) {
    if (new RegExp(`(^|[^a-z0-9])${a.base.toLowerCase()}(usdt)?([^a-z0-9]|$)`).test(lower)) found.add(a.symbol);
  }
  for (const [word, base] of Object.entries(NAMES)) {
    if (lower.includes(word)) {
      const a = ctx.assets.find((x) => x.base === base);
      if (a) found.add(a.symbol);
    }
  }
  if (!found.size && hint && ctx.assets.some((a) => a.symbol === hint)) found.add(hint);
  return [...found];
}

const dirOf = (ctx: AssistantContext, symbol: string) => ctx.directional.find((d) => d.symbol === symbol) ?? null;
const evalOf = (ctx: AssistantContext, symbol: string) => ctx.evaluations.find((e) => e.symbol === symbol) ?? null;

function directionalLine(d: DirectionRow, ctx: AssistantContext): string {
  const a = d.assessment;
  const base = baseOf(d.symbol);
  if (!a.dataOk) return `${base}: no assessment (${a.dataIssue ?? "data problem"}), checked ${ageLabel(d.evaluatedAt, ctx.now)}.`;
  return `${base}: ${a.direction} — 1h ${trendWord(a.h1Trend)}, 4h ${trendWord(a.h4Trend)}, reference ${fmtPrice(a.price)} (candle ${fmtUtcShort(a.candleStart)}), checked ${ageLabel(d.evaluatedAt, ctx.now)}.`;
}

function whyDirectional(want: "LONG" | "SHORT" | "NEUTRAL", symbols: string[], ctx: AssistantContext, missing: string[]): string {
  const parts: string[] = [];
  for (const s of symbols) {
    const base = baseOf(s);
    const d = dirOf(ctx, s);
    if (!d) { missing.push(`${base}: no LONG/SHORT assessment stored yet`); parts.push(`${base}: no assessment has been stored yet. The monitor evaluates it on its next run.`); continue; }
    const a = d.assessment;
    if (!a.dataOk) { parts.push(`${base}: the assessment could not be made — ${a.dataIssue}. With bad or missing data the system stays NEUTRAL instead of guessing.`); continue; }
    if (a.direction === "NEUTRAL") {
      const lines = [`${base} is NEUTRAL right now (1h ${trendWord(a.h1Trend)}, 4h ${trendWord(a.h4Trend)}). Scores: LONG ${a.longScore}/100, SHORT ${a.shortScore}/100. No signal is forced.`, ...a.notes.map((n) => `• ${n}`)];
      if (want !== "NEUTRAL") lines.unshift(`You asked about ${want}, but ${base} currently is not ${want}.`);
      parts.push(lines.join("\n"));
    } else {
      const lines = [`${base} is currently ${a.direction}${want !== "NEUTRAL" && want !== a.direction ? ` (not ${want} as you asked)` : ""}. Reasons:`, bullets(a.reasons)];
      if (a.levels) lines.push(`Reference levels: entry ${fmtPrice(a.levels.entry)}, stop ${fmtPrice(a.levels.stop)}, target ${fmtPrice(a.levels.takeProfit)}, reward/risk ${a.levels.riskReward.toFixed(2)} (${a.levels.netRiskReward.toFixed(2)} after estimated costs).`);
      parts.push(lines.join("\n"));
    }
  }
  return parts.join("\n\n");
}

function whyBuy(symbols: string[], ctx: AssistantContext, missing: string[]): string {
  const parts: string[] = [];
  for (const s of symbols) {
    const base = baseOf(s);
    const e = evalOf(ctx, s);
    if (!e) { missing.push(`${base}: no BUY-rule evaluation stored yet`); parts.push(`${base}: no BUY evaluation has been stored yet.`); continue; }
    const conds = (Array.isArray(e.conditions) ? e.conditions : []) as Condition[];
    const failed = conds.filter((c) => !c.passed);
    const open = ctx.positions.find((p) => p.symbol === s && p.status === "open");
    const head = e.status === "SIGNAL" ? `${base}: the BUY conditions ARE met (checked ${ageLabel(e.evaluatedAt, ctx.now)}).` : e.status === "DATA_INVALID" ? `${base}: BUY could not be evaluated because the data failed quality checks.` : `${base}: no BUY signal right now (checked ${ageLabel(e.evaluatedAt, ctx.now)}).`;
    const lines = [head, bullets(conds.map((c) => `${c.passed ? "✓" : "✗"} ${c.label} — ${c.detail}`))];
    if (e.status !== "SIGNAL" && failed.length) lines.push(`Not met: ${failed.map((c) => c.label).join("; ")}.`);
    if (open) lines.push(`A simulated spot position is open since ${fmtUtcShort(open.openedAt)} at ${fmtPrice(open.entryPrice)}; no new BUY can open while it is open.`);
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

function whySell(symbols: string[], ctx: AssistantContext): string {
  const parts: string[] = [];
  for (const s of symbols) {
    const base = baseOf(s);
    const open = ctx.positions.find((p) => p.symbol === s && p.status === "open");
    const lastSell = ctx.trades.find((t) => t.symbol === s && t.type === "SELL");
    const lines: string[] = [];
    if (open) {
      lines.push(`${base}: a simulated spot position is OPEN (entry ${fmtPrice(open.entryPrice)} at ${fmtUtcShort(open.openedAt)}). It sells when price falls ${open.stopLossPct}% below entry (${fmtPrice(open.entryPrice * (1 - open.stopLossPct / 100))}), rises ${open.takeProfitPct}% above (${fmtPrice(open.entryPrice * (1 + open.takeProfitPct / 100))})${open.trendExitEnabled ? ", or the 1h trend turns down" : ""}.`);
    } else lines.push(`${base}: no simulated spot position is open, so there is nothing to SELL right now.`);
    if (lastSell) lines.push(`Last SELL: ${fmtUtcShort(lastSell.occurredAt)} at ${fmtPrice(lastSell.price)} — ${lastSell.reason}${lastSell.netPnl !== null ? `; net ${sign(lastSell.netPnl, 4)} USDT` : ""}.`);
    else lines.push("No SELL has happened for this coin yet.");
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

function invalidation(symbols: string[], ctx: AssistantContext, missing: string[]): string {
  const parts: string[] = [];
  for (const s of symbols) {
    const base = baseOf(s);
    const d = dirOf(ctx, s);
    const open = ctx.signals.find((x) => x.symbol === s && x.status === "open");
    if (!d) { missing.push(`${base}: no assessment stored`); parts.push(`${base}: no assessment is stored yet, so I can't say what would invalidate anything.`); continue; }
    const a = d.assessment;
    if (a.direction !== "NEUTRAL" && a.dataOk) {
      parts.push(`${base} ${a.direction} setup would be invalidated if:\n${bullets(a.invalidations)}`);
    } else if (open) {
      parts.push(`${base}: the current assessment is NEUTRAL, but ${open.direction} signal #${open.id} (from ${fmtUtcShort(open.candleStart)}) is still being tracked. Its stop reference is ${fmtPrice(open.stop)} and target ${fmtPrice(open.takeProfit)}; it ends at either level or after ${MAX_HOLD_BARS} hourly candles.\nWhen it was raised, it was invalid if:\n${bullets(open.invalidations)}`);
    } else {
      parts.push(`${base} is ${a.dataOk ? "NEUTRAL" : "not assessable"}: there is no active setup to invalidate. A LONG or SHORT only appears when every condition agrees; right now ${a.notes[a.notes.length > 1 ? 1 : 0] ?? "conditions are unclear"}`);
    }
  }
  return parts.join("\n\n");
}

function levels(symbols: string[], ctx: AssistantContext, missing: string[]): string {
  const parts: string[] = [];
  for (const s of symbols) {
    const base = baseOf(s);
    const d = dirOf(ctx, s);
    if (!d) { missing.push(`${base}: no assessment stored`); parts.push(`${base}: no assessment stored yet.`); continue; }
    const a = d.assessment;
    if (a.levels && a.direction !== "NEUTRAL") {
      const lv = a.levels;
      parts.push(`${base} ${a.direction}: entry reference ${fmtPrice(lv.entry)} (last closed 1h candle), stop ${fmtPrice(lv.stop)} (${lv.riskPct.toFixed(2)}%), target ${fmtPrice(lv.takeProfit)} (${lv.rewardPct.toFixed(2)}%, ${lv.targetBasis === "swing" ? "capped by nearby support/resistance" : "2 × risk"}), reward/risk ${lv.riskReward.toFixed(2)}, about ${lv.netRiskReward.toFixed(2)} after estimated costs.${a.support !== null ? ` Nearest support ${fmtPrice(a.support)}.` : " No clear support found."}${a.resistance !== null ? ` Nearest resistance ${fmtPrice(a.resistance)}.` : " No clear resistance found."}`);
    } else {
      parts.push(`${base} is ${a.direction}, so there are no entry/stop/target levels — they are produced only for an active LONG or SHORT.${a.support !== null || a.resistance !== null ? ` For reference, nearest support ${a.support !== null ? fmtPrice(a.support) : "n/a"}, resistance ${a.resistance !== null ? fmtPrice(a.resistance) : "n/a"}.` : ""}`);
    }
  }
  return parts.join("\n\n");
}

function trends(symbols: string[], ctx: AssistantContext, missing: string[]): string {
  return symbols.map((s) => {
    const d = dirOf(ctx, s);
    if (!d) { missing.push(`${baseOf(s)}: no assessment stored`); return `${baseOf(s)}: no assessment stored yet.`; }
    const a = d.assessment;
    if (!a.dataOk) return `${baseOf(s)}: trends unavailable — ${a.dataIssue}.`;
    const h4 = a.checks.find((c) => c.id === "h4_trend");
    const h1 = a.checks.find((c) => c.id === "h1_ema");
    return `${baseOf(s)}: 1h ${trendWord(a.h1Trend)}, 4h ${trendWord(a.h4Trend)}.\n${bullets([h1?.detail ?? "", h4?.detail ?? ""].filter(Boolean))}`;
  }).join("\n\n");
}

function performance(ctx: AssistantContext, symbols: string[], explicit: boolean): string {
  const st = ctx.stats;
  const open = ctx.signals.filter((s) => s.status === "open").length;
  const b = explicit && symbols.length === 1 ? st.bySymbol[symbols[0]] ?? null : null;
  const label = b ? baseOf(symbols[0]) : "all coins";
  const x = b ?? st;
  if (!x.count) {
    return `No LONG/SHORT signals have been resolved yet${explicit && symbols.length === 1 ? ` for ${label}` : ""}, so there is no performance to report. ${open} signal(s) are still open. I won't estimate results I don't have.\n\n${bullets(st.caveats)}`;
  }
  return [
    `LONG/SHORT forward-tracked results (${label}, estimated fees and slippage included):`,
    bullets([
      `${x.count} resolved signal(s): ${x.wins} winning, ${x.losses} not winning${x.winRatePct !== null ? ` (${x.winRatePct.toFixed(0)}% win rate)` : ""}`,
      `Average net per signal ${x.avgNetPct !== null ? sign(x.avgNetPct) : "n/a"}%, cumulative ${sign(x.totalNetPct)}%`,
      `Average R multiple ${x.avgR !== null ? x.avgR.toFixed(2) : "n/a"}, profit factor ${x.profitFactor !== null ? x.profitFactor.toFixed(2) : "n/a"}`,
      `Maximum drawdown of the cumulative result: ${x.maxDrawdownPct.toFixed(2)} percentage points`,
      `Exits: ${Object.entries(st.byExit).map(([k, v]) => `${k} ${v}`).join(", ")}; still open: ${open}`,
    ]),
    "",
    "Caveats:",
    bullets(st.caveats),
  ].join("\n");
}

export function answerQuestion(question: string, ctx: AssistantContext, hintSymbol?: string): AssistantAnswer {
  const q = question.trim().slice(0, 300);
  const lower = q.toLowerCase();
  const missing: string[] = [];
  const explicitSymbols = findSymbols(q, ctx, undefined);
  const symbols = explicitSymbols.length ? explicitSymbols : hintSymbol && ctx.assets.some((a) => a.symbol === hintSymbol) ? [hintSymbol] : ctx.assets.filter((a) => a.enabled).map((a) => a.symbol);
  const done = (topic: string, answer: string): AssistantAnswer => ({ topic, answer, symbols, missing });

  if (!q) return done("help", helpText());
  if (/\b(help|what can you|what do you|how do you work|hello|hi|hey)\b/.test(lower) && lower.length < 40) return done("help", helpText());

  if (/(invalid|wrong|fail|cancel|void|break|no longer|what would (change|kill))/.test(lower)) return done("invalidation", invalidation(symbols, ctx, missing));

  if (/\bwhy\b|how come|reason|what (caused|triggered)|explain (the )?(signal|alert) (for|on|of)/.test(lower)) {
    if (/\bneutral\b|no signal|nothing|unclear|not (signal|trading)|nothing happening|quiet/.test(lower)) return done("why_neutral", whyDirectional("NEUTRAL", symbols, ctx, missing));
    if (/\blong\b/.test(lower)) return done("why_long", whyDirectional("LONG", symbols, ctx, missing));
    if (/\bshort\b/.test(lower)) return done("why_short", whyDirectional("SHORT", symbols, ctx, missing));
    if (/\bsell\b|\bclose[ds]?\b|\bexit/.test(lower)) return done("why_sell", whySell(symbols, ctx));
    if (/\bbuy\b|\bbought\b|\bentry\b|\bentered\b/.test(lower)) return done("why_buy", whyBuy(symbols, ctx, missing));
    return done("why_overview", `${symbols.map((s) => whyDirectional("NEUTRAL", [s], ctx, missing)).join("\n\n")}\n\n${whyBuy(symbols, ctx, missing)}`);
  }

  if (/(differen|versus|\bvs\b|meaning|what (is|does|are)|explain|signal types?|mean\b)/.test(lower) && /(buy|sell|long|short|neutral|signal)/.test(lower)) return done("guide", SIGNAL_GUIDE);

  if (/(stop[- ]?loss|take[- ]?profit|target|entry|level|support|resist|risk.?reward|\br\/r\b)/.test(lower)) return done("levels", levels(symbols, ctx, missing));
  if (/(trend|4h|1h|timeframe|ema)/.test(lower)) return done("trend", trends(symbols, ctx, missing));
  if (/(perform|win ?rate|drawdown|result|profit|backtest|track record|how (well|good)|accuracy|loss(es)?)/.test(lower)) return done("performance", performance(ctx, symbols, explicitSymbols.length > 0));
  if (/(fee|cost|slippage|limit|reliab|accura|trust|data source|disclaimer|guarantee|risk)/.test(lower)) {
    return done("limits", [
      `Estimated costs used: fees ${ctx.settings.feeRatePct}% per side and slippage ${ctx.settings.slippagePct}% per side (round trip ≈ ${(2 * (ctx.settings.feeRatePct + ctx.settings.slippagePct)).toFixed(2)}%). Setups whose reward does not clearly beat these costs stay NEUTRAL.`,
      "",
      "Limitations:",
      bullets(STANDING_LIMITATIONS),
    ].join("\n"));
  }
  if (/(status|monitor|running|last (check|run)|working|health|email|notif|alert|push)/.test(lower)) {
    const lines = ctx.assets.map((a) => `${a.base}: ${a.enabled ? "monitored" : "paused"}, last check ${ageLabel(a.lastCheckedAt, ctx.now)}${a.lastError ? `, last problem: ${a.lastError}` : ""}`);
    return done("status", [
      bullets(lines),
      "",
      `BUY/SELL emails ${ctx.settings.buyEmailEnabled && ctx.settings.sellEmailEnabled ? "on" : "partly off"}, LONG/SHORT analysis ${ctx.settings.directionalEnabled ? "on" : "off"}, LONG/SHORT emails ${ctx.settings.directionalEmailEnabled ? "on" : "off"}, recipient ${ctx.settings.emailRecipient}.`,
      "For delivery details open the Email card; I can only see what the app has stored.",
    ].join("\n"));
  }
  if (/(position|holding|open trade|paper)/.test(lower)) {
    const open = ctx.positions.filter((p) => p.status === "open");
    return done("positions", open.length ? bullets(open.map((p) => `${baseOf(p.symbol)}: entry ${fmtPrice(p.entryPrice)} at ${fmtUtcShort(p.openedAt)}, ${p.amountUsdt} USDT simulated`)) : "No simulated spot positions are open right now.");
  }
  if (/(summary|overview|everything|all coins|what('| i)?s (going on|happening)|market|now|current|signals?)/.test(lower) || explicitSymbols.length) {
    const lines = symbols.map((s) => {
      const d = dirOf(ctx, s);
      const e = evalOf(ctx, s);
      const open = ctx.positions.find((p) => p.symbol === s && p.status === "open");
      return `${d ? directionalLine(d, ctx) : `${baseOf(s)}: no LONG/SHORT assessment stored yet.`}\n   BUY/SELL: ${open ? "simulated position open" : e ? (e.status === "SIGNAL" ? "BUY conditions met" : e.status === "DATA_INVALID" ? "data invalid" : "no BUY signal") : "no evaluation stored yet"}.`;
    });
    const openSignals = ctx.signals.filter((x) => x.status === "open");
    return done("summary", [
      lines.join("\n"),
      "",
      openSignals.length ? `Tracked LONG/SHORT signals still open: ${openSignals.map((x) => `${baseOf(x.symbol)} ${x.direction}`).join(", ")}.` : "No LONG/SHORT signal is currently open.",
      "Ask “why is ETH neutral?”, “what would invalidate BTC?”, “what is the difference between BUY and LONG?” or “how has it performed?” for details.",
    ].join("\n"));
  }
  return done("unknown", `I can't answer that from the data I have. I'm a rule-based helper, not an AI model, so I only answer from what Crypto Sentinel has stored.\n\n${helpText()}`);
}

export function helpText(): string {
  return [
    "I can answer from the app's own data:",
    bullets([
      "Why a coin shows LONG, SHORT, NEUTRAL, BUY or SELL (e.g. “why is ETH neutral?”)",
      "What would invalidate a setup (e.g. “what would invalidate BTC long?”)",
      "Entry, stop-loss, take-profit and reward/risk levels",
      "1h and 4h trends",
      "The difference between BUY/SELL and LONG/SHORT",
      "Performance, fees, slippage and limitations",
      "Monitor and notification status",
    ]),
    "I never guess: if something isn't stored yet I'll say so.",
  ].join("\n");
}
