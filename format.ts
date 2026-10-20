/** Display helpers shared by emails and the dashboard. Pure; never used for calculations. */

/** Price with sensible precision for the magnitude (BTC 2 dp, SOL 3-4 dp, XRP 4-6 dp). */
export function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  const dp = a >= 1000 ? 2 : a >= 100 ? 2 : a >= 1 ? 4 : 6;
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function fmtUsdt(n: number | null | undefined, dp = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function fmtSigned(n: number | null | undefined, dp = 4): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : "−"}${fmtUsdt(Math.abs(n), dp)}`;
}

export function fmtPct(n: number | null | undefined, dp = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(dp)}%`;
}

export function fmtQty(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toFixed(8).replace(/0+$/, "").replace(/\.$/, ".0");
}

export function baseOf(symbol: string): string {
  return symbol.replace(/USDT$/, "");
}

export function pairLabel(symbol: string): string {
  return `${baseOf(symbol)}/USDT`;
}
