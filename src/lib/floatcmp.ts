/**
 * Float-safe comparisons for values that are COMPUTED from prices (wick vs body, "top 40% of the range", ...).
 *
 * Why: prices are decimal numbers stored as binary floats. A candle whose upper wick is mathematically exactly twice
 * its body can come out as 1.9999999999999998× or 2.0000000000000004× depending on the price LEVEL, so the same chart
 * shape could pass at one price scale and fail at another. The tolerance is relative to the price magnitude and is
 * 1e-9 of it, i.e. far below one exchange tick (even BTC's 0.1 tick at 100,000 is 1e-6 of price), so it can only
 * absorb floating-point noise and never turns a real one-tick difference into a tie.
 *
 * Semantics are unchanged for every non-tie: a ">=" still means ">=", and an exact decimal tie still counts as a tie.
 */
export const REL_TOL = 1e-9;

const tol = (scale: number): number => REL_TOL * Math.abs(scale);

/** a >= b, treating differences below floating-point noise (relative to `scale`, normally the price) as equal. */
export const geq = (a: number, b: number, scale: number): boolean => a >= b - tol(scale);
/** a <= b, same tolerance. */
export const leq = (a: number, b: number, scale: number): boolean => a <= b + tol(scale);
