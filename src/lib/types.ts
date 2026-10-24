/** A single OHLCV candle. `start` is the candle open time in epoch milliseconds (UTC). */
export interface Candle {
  start: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
}

export type Interval = "60" | "240";

export const INTERVAL_MS: Record<Interval, number> = {
  "60": 60 * 60 * 1000,
  "240": 4 * 60 * 60 * 1000,
};

export interface Ticker24h {
  symbol: string;
  lastPrice: number;
  /** 24h change as a percentage (e.g. 1.25 = +1.25%). */
  change24hPct: number;
  high24h: number;
  low24h: number;
  /** 24h volume in BTC. */
  volume24h: number;
  /** 24h turnover in USDT. */
  turnover24h: number;
  /** Exchange response timestamp, epoch ms. */
  serverTime: number;
}

export interface Settings {
  positionAmountUsdt: number;
  buyEmailEnabled: boolean;
  sellEmailEnabled: boolean;
  emailRecipient: string;
  stopLossPct: number;
  takeProfitPct: number;
  trendExitEnabled: boolean;
  /** Fee per side, in percent (0.1 = 0.1%). */
  feeRatePct: number;
  emaFast: number;
  emaSlow: number;
  rsiPeriod: number;
  rsiMin: number;
  rsiMax: number;
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
  atrPeriod: number;
  /** Maximum minutes after a 1h candle closes during which a new simulated entry may be opened. */
  entryWindowMinutes: number;
  /** LONG/SHORT analysis (separate from BUY/SELL). */
  directionalEnabled: boolean;
  directionalEmailEnabled: boolean;
  /** Assumed slippage per side, in percent, used only for the LONG/SHORT cost estimates. */
  slippagePct: number;
  /** Minimum estimated reward/risk (before costs) a LONG/SHORT setup needs; weaker setups stay NEUTRAL. */
  minRiskReward: number;
}

export interface TimeframeSnapshot {
  candleStart: number | null;
  close: number | null;
  emaFast: number | null;
  emaSlow: number | null;
  rsi: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  atr: number | null;
}

export interface Condition {
  id: string;
  label: string;
  /** false for both "failed" and "could not be evaluated"; see `evaluated`. */
  passed: boolean;
  /** false when the condition could not be evaluated because data checks failed first. */
  evaluated: boolean;
  detail: string;
}

export type EvaluationStatus = "SIGNAL" | "NO_SIGNAL" | "DATA_INVALID";

export interface BuyEvaluation {
  status: EvaluationStatus;
  evaluatedAt: number;
  h1CandleStart: number | null;
  h4CandleStart: number | null;
  conditions: Condition[];
  indicators: { h1: TimeframeSnapshot; h4: TimeframeSnapshot };
  summary: string;
}

export type ExitReason = "STOP_LOSS" | "TAKE_PROFIT" | "TREND_CHANGE";

export interface ExitDecision {
  exit: boolean;
  reason?: ExitReason;
  detail: string;
}

export interface OpenPositionLike {
  entryPrice: number;
  quantity: number;
  amountUsdt: number;
  openedAt: number;
  stopLossPct: number;
  takeProfitPct: number;
  trendExitEnabled: boolean;
}
