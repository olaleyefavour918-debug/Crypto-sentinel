/**
 * Paper-trading arithmetic. Everything here is hypothetical: no order is ever sent anywhere.
 */

const round = (n: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
};

/** Prices are persisted with 10 decimals; rounding once at the source keeps computed and stored values identical. */
export function roundPrice(n: number): number {
  return Number(n.toFixed(10));
}

/** Simulated coin quantity = simulated position amount / reference entry price (8 decimals). */
export function simulatedQuantity(amountUsdt: number, entryPrice: number): number {
  if (!(amountUsdt > 0) || !(entryPrice > 0) || !Number.isFinite(amountUsdt) || !Number.isFinite(entryPrice)) {
    throw new RangeError("amount and entry price must be positive finite numbers");
  }
  return round(amountUsdt / entryPrice, 8);
}

/** Estimated entry fee, charged on the USDT amount spent. */
export function entryFee(amountUsdt: number, feeRatePct: number): number {
  return round((amountUsdt * feeRatePct) / 100, 8);
}

/** Estimated exit fee, charged on the USDT value of the BTC sold. */
export function exitFee(quantity: number, exitPrice: number, feeRatePct: number): number {
  return round((quantity * exitPrice * feeRatePct) / 100, 8);
}

export interface ClosedTradeMath {
  quantity: number;
  grossPnl: number;
  entryFee: number;
  exitFee: number;
  totalFees: number;
  netPnl: number;
  /** Net P/L as a percentage of the simulated amount. */
  netPct: number;
  exitValue: number;
}

export function computeClose(p: {
  amountUsdt: number;
  entryPrice: number;
  exitPrice: number;
  feeRatePct: number;
  /** Optionally reuse a stored quantity so closing exactly mirrors the entry. */
  quantity?: number;
}): ClosedTradeMath {
  const quantity = p.quantity ?? simulatedQuantity(p.amountUsdt, p.entryPrice);
  const exitValue = round(quantity * p.exitPrice, 8);
  const grossPnl = round(quantity * (p.exitPrice - p.entryPrice), 8);
  const eFee = entryFee(p.amountUsdt, p.feeRatePct);
  const xFee = exitFee(quantity, p.exitPrice, p.feeRatePct);
  const totalFees = round(eFee + xFee, 8);
  const netPnl = round(grossPnl - totalFees, 8);
  return {
    quantity,
    grossPnl,
    entryFee: eFee,
    exitFee: xFee,
    totalFees,
    netPnl,
    netPct: p.amountUsdt > 0 ? round((netPnl / p.amountUsdt) * 100, 4) : 0,
    exitValue,
  };
}

/** Hypothetical unrealized P/L if the position were closed at `currentPrice` (includes estimated exit fee). */
export function unrealized(p: {
  amountUsdt: number;
  entryPrice: number;
  quantity: number;
  feeRatePct: number;
  currentPrice: number;
}): ClosedTradeMath {
  return computeClose({
    amountUsdt: p.amountUsdt,
    entryPrice: p.entryPrice,
    exitPrice: p.currentPrice,
    feeRatePct: p.feeRatePct,
    quantity: p.quantity,
  });
}

/** Balance after closing: the reserved amount returns to cash together with the net P/L. */
export function balanceAfterClose(availableBalance: number, amountUsdt: number, netPnl: number): number {
  return round(availableBalance + amountUsdt + netPnl, 8);
}

/** Balance after opening: the position amount is reserved (entry fee is realised at close). */
export function balanceAfterOpen(availableBalance: number, amountUsdt: number): number {
  if (amountUsdt > availableBalance + 1e-9) throw new RangeError("insufficient simulated balance");
  return round(availableBalance - amountUsdt, 8);
}
