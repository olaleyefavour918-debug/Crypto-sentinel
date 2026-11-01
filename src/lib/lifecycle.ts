import { INTERVAL_MS } from "./types";
import { SETUP, type Cond, type SetupEval, type SetupLevels, type StrategyId } from "./setups";

/**
 * The status lifecycle of one setup (one coin + one strategy):
 *   WATCH      – conditions are developing (dashboard only)
 *   POTENTIAL  – all evidence present on the candle that is STILL FORMING (early, unconfirmed)
 *   CONFIRMED  – the same evidence holds on a CLOSED candle
 *   EXPIRED    – no longer valid (and why)
 *
 * Pure logic: given the previous state and one scan, returns the next state plus the events to record. The live
 * monitor and the back-test call exactly this function, so what is tested is what runs.
 * An unfinished candle can never produce CONFIRMED: `closed.full` is only ever read from an evaluation made on
 * closed candles, and SetupEval already forces `full=false` whenever a forming candle was included.
 */

export type SetupStatus = "WATCH" | "POTENTIAL" | "CONFIRMED" | "EXPIRED";
const H1 = INTERVAL_MS["60"];

export const LIFECYCLE = {
  /** Consecutive scans (5 min apart) the early evidence must persist before a POTENTIAL is raised. */
  potentialScans: 2,
  /** A fresh CONFIRMED may only be raised within this long after the candle closed (otherwise it is stale news). */
  confirmWindowMs: 30 * 60_000,
  validMs: SETUP.validCandles * H1,
  /** After a setup is invalidated by a breakdown or its stop, the same strategy stays quiet on that coin for this long. */
  cooldownMs: 6 * H1,
} as const;

export interface SetupState {
  symbol: string;
  strategy: StrategyId;
  status: SetupStatus;
  firstSeenAt: number;
  statusSince: number;
  /** Start of the 1H candle the signal belongs to. */
  signalCandleStart: number | null;
  /** Live price at the scan that raised the current status (POTENTIAL or CONFIRMED). */
  signalPrice: number | null;
  signalPriceAt: number | null;
  /** Close of the confirming candle (CONFIRMED only). */
  confirmCandleClose: number | null;
  potentialScans: number;
  /** How many times an early read disappeared before the candle closed. */
  repaints: number;
  /** Set when a POTENTIAL later became CONFIRMED (the conversion statistic). */
  convertedFromPotential: boolean;
  expireReason: string | null;
  expiredAt: number | null;
  levels: SetupLevels | null;
  variant: string | null;
  refs: SetupEval["refs"];
  lastPrice: number | null;
  lastScanAt: number;
  conditions: Cond[];
  reasons: string[];
}

export interface SetupEvent {
  kind: "WATCH" | "POTENTIAL" | "CONFIRMED" | "EXPIRED" | "REGRESSED";
  at: number;
  price: number | null;
  note: string;
}

export interface Scan {
  now: number;
  /** Live price (ticker), or the last close if the ticker is unavailable. */
  price: number | null;
  closed: SetupEval;
  /** Evaluation that includes the forming candle, or null when it is too early in the candle / not requested. */
  preview: SetupEval | null;
}

export interface StepResult {
  state: SetupState | null;
  events: SetupEvent[];
  /** Notification-worthy transitions in this step (the caller applies the user's settings and rate limits). */
  notify: Array<"POTENTIAL" | "CONFIRMED">;
}

function fresh(symbol: string, strategy: StrategyId, status: SetupStatus, scan: Scan, from: SetupEval): SetupState {
  return {
    symbol, strategy, status, firstSeenAt: scan.now, statusSince: scan.now,
    signalCandleStart: null, signalPrice: null, signalPriceAt: null, confirmCandleClose: null,
    potentialScans: 0, repaints: 0, convertedFromPotential: false, expireReason: null, expiredAt: null,
    levels: from.levels, variant: from.variant, refs: from.refs, lastPrice: scan.price, lastScanAt: scan.now,
    conditions: from.conditions, reasons: from.reasons,
  };
}

/** Why an active CONFIRMED setup is no longer valid, or null. */
export function invalidation(s: SetupState, scan: Scan): string | null {
  const p = scan.price;
  if (s.strategy === "BOUNCE") {
    if (p !== null && s.levels) {
      if (p <= s.levels.stop) return "stop level reached";
      if (p >= s.levels.target) return "target reached";
    }
    if (scan.closed.dataOk && scan.closed.conditions.find((c) => c.id === "b3_holding" && !c.passed)) return "support broke down";
  } else if (s.strategy === "EXIT_WARNING") {
    const z = s.refs;
    if (p !== null && z.atr !== null) {
      if (s.variant === "breakdown" && z.zoneLow !== null && p > z.zoneLow) return "support was regained";
      if (s.variant !== "breakdown" && z.zoneHigh !== null && p > z.zoneHigh + 0.25 * z.atr) return "price moved above the resistance zone";
    }
  } else if (scan.closed.dataOk && !scan.closed.context) {
    return "the trend conditions no longer hold";
  }
  return null;
}

export function step(prev: SetupState | null, symbol: string, strategy: StrategyId, scan: Scan): StepResult {
  const events: SetupEvent[] = [];
  const notify: StepResult["notify"] = [];
  const { closed, preview, now } = scan;
  const closedStart = closed.candleStart;
  // After an invalidation by stop/breakdown the strategy stays quiet on this coin for a while, and the same candle is never signalled twice.
  const cooling = !!prev && prev.status === "EXPIRED" && prev.expiredAt !== null && now - prev.expiredAt < LIFECYCLE.cooldownMs && (prev.expireReason === "stop level reached" || prev.expireReason === "support broke down");
  const usedCandle = prev && prev.status === "EXPIRED" ? prev.signalCandleStart : null;
  const confirmNow =
    closed.dataOk && closed.full && closedStart !== null && closedStart !== usedCandle && now - (closedStart + H1) <= LIFECYCLE.confirmWindowMs && !cooling;
  const potentialNow = !!preview && preview.dataOk && preview.potential && !cooling && preview.candleStart !== usedCandle;
  const watchNow = !cooling && ((closed.dataOk && closed.context) || (!!preview && preview.dataOk && preview.context));

  // Nothing active yet.
  if (!prev || prev.status === "EXPIRED") {
    if (confirmNow) {
      const st = fresh(symbol, strategy, "CONFIRMED", scan, closed);
      st.signalCandleStart = closedStart;
      st.signalPrice = scan.price ?? closed.price;
      st.signalPriceAt = now;
      st.confirmCandleClose = closed.price;
      events.push({ kind: "CONFIRMED", at: now, price: st.signalPrice, note: "All conditions hold on the closed candle." });
      notify.push("CONFIRMED");
      return { state: st, events, notify };
    }
    if (potentialNow || watchNow) {
      const src = potentialNow ? (preview as SetupEval) : closed.context ? closed : (preview as SetupEval);
      const st = fresh(symbol, strategy, "WATCH", scan, src);
      st.potentialScans = potentialNow ? 1 : 0;
      events.push({ kind: "WATCH", at: now, price: scan.price, note: "Conditions are developing." });
      return { state: st, events, notify };
    }
    return { state: null, events, notify };
  }

  const s: SetupState = { ...prev, lastPrice: scan.price, lastScanAt: now };

  if (s.status === "WATCH") {
    if (confirmNow) return becomeConfirmed(s, closed, scan, events, notify);
    if (potentialNow) {
      s.potentialScans += 1;
      s.conditions = (preview as SetupEval).conditions; s.reasons = (preview as SetupEval).reasons; s.levels = (preview as SetupEval).levels; s.refs = (preview as SetupEval).refs; s.variant = (preview as SetupEval).variant;
      if (s.potentialScans >= LIFECYCLE.potentialScans) {
        s.status = "POTENTIAL";
        s.statusSince = now;
        s.signalCandleStart = (preview as SetupEval).candleStart;
        s.signalPrice = scan.price ?? (preview as SetupEval).price;
        s.signalPriceAt = now;
        events.push({ kind: "POTENTIAL", at: now, price: s.signalPrice, note: "Early read: the evidence is present on the candle that is still forming. Not confirmed." });
        notify.push("POTENTIAL");
      }
      return { state: s, events, notify };
    }
    if (watchNow) {
      const src = closed.context ? closed : (preview as SetupEval);
      s.potentialScans = 0; s.conditions = src.conditions; s.reasons = src.reasons; s.levels = src.levels; s.refs = src.refs; s.variant = src.variant;
      return { state: s, events, notify };
    }
    return expire(s, now, scan.price, "the conditions are no longer present", events, notify);
  }

  if (s.status === "POTENTIAL") {
    if (confirmNow) {
      s.convertedFromPotential = true;
      return becomeConfirmed(s, closed, scan, events, notify);
    }
    const candleClosed = closedStart !== null && s.signalCandleStart !== null && closedStart >= s.signalCandleStart;
    if (candleClosed) {
      s.repaints += 1;
      return expire(s, now, scan.price, "the early read did not hold when the candle closed", events, notify);
    }
    if (potentialNow) {
      const p = preview as SetupEval;
      s.conditions = p.conditions; s.reasons = p.reasons; s.levels = p.levels; s.refs = p.refs;
      return { state: s, events, notify };
    }
    s.repaints += 1;
    if (watchNow) {
      s.status = "WATCH"; s.statusSince = now; s.potentialScans = 0;
      events.push({ kind: "REGRESSED", at: now, price: scan.price, note: "The early read faded before the candle closed (back to WATCH)." });
      return { state: s, events, notify };
    }
    return expire(s, now, scan.price, "the early read faded before the candle closed", events, notify);
  }

  // CONFIRMED
  const age = s.signalCandleStart === null ? 0 : now - (s.signalCandleStart + H1);
  const why = invalidation(s, scan);
  if (why) return expire(s, now, scan.price, why, events, notify);
  if (age > LIFECYCLE.validMs) return expire(s, now, scan.price, "the validity window ended", events, notify);
  return { state: s, events, notify };
}

function becomeConfirmed(s: SetupState, closed: SetupEval, scan: Scan, events: SetupEvent[], notify: StepResult["notify"]): StepResult {
  s.status = "CONFIRMED";
  s.statusSince = scan.now;
  s.signalCandleStart = closed.candleStart;
  s.signalPrice = scan.price ?? closed.price;
  s.signalPriceAt = scan.now;
  s.confirmCandleClose = closed.price;
  s.conditions = closed.conditions; s.reasons = closed.reasons; s.levels = closed.levels; s.refs = closed.refs; s.variant = closed.variant;
  events.push({ kind: "CONFIRMED", at: scan.now, price: s.signalPrice, note: s.convertedFromPotential ? "The early read was confirmed when the candle closed." : "All conditions hold on the closed candle." });
  notify.push("CONFIRMED");
  return { state: s, events, notify };
}

function expire(s: SetupState, now: number, price: number | null, reason: string, events: SetupEvent[], notify: StepResult["notify"]): StepResult {
  s.status = "EXPIRED";
  s.statusSince = now;
  s.expiredAt = now;
  s.expireReason = reason;
  events.push({ kind: "EXPIRED", at: now, price, note: `Expired: ${reason}.` });
  return { state: s, events, notify };
}

/** Human description of the current validity, for the dashboard and alerts. */
export function validityText(s: Pick<SetupState, "status" | "signalCandleStart" | "expireReason">, now: number): string {
  if (s.status === "EXPIRED") return `EXPIRED — ${s.expireReason ?? "no longer valid"}`;
  if (s.status === "WATCH") return "Not a signal yet";
  if (s.signalCandleStart === null) return "—";
  const endsAt = s.signalCandleStart + H1 + LIFECYCLE.validMs;
  if (s.status === "POTENTIAL") return "Unconfirmed until the 1H candle closes";
  const left = endsAt - now;
  if (left <= 0) return "EXPIRED — validity window ended";
  const h = Math.floor(left / 3600_000), m = Math.round((left % 3600_000) / 60_000);
  return `Current — valid for about ${h}h ${m}m more, unless invalidated`;
}
