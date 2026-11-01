import { rng } from "@/lib/setups-backtest";

export const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
export const quantile = (xs: number[], q: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
};
export const fx = (x: number | null | undefined, d = 2): string => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : x.toFixed(d));
export const pct = (num: number, den: number, d = 1): string => (den > 0 ? `${((num / den) * 100).toFixed(d)}%` : "n/a");

/** Phi coefficient (correlation of two yes/no series). */
export function phi(a: boolean[], b: boolean[]): number | null {
  let n11 = 0, n10 = 0, n01 = 0, n00 = 0;
  for (let i = 0; i < a.length; i++) { if (a[i] && b[i]) n11++; else if (a[i]) n10++; else if (b[i]) n01++; else n00++; }
  const d = Math.sqrt((n11 + n10) * (n01 + n00) * (n11 + n01) * (n10 + n00));
  return d > 0 ? (n11 * n00 - n10 * n01) / d : null;
}

/** Per-day sums so a bootstrap can resample whole days (hours inside a day are strongly correlated, and so are coins). */
export class DayAcc {
  readonly days = new Map<number, { s: number; n: number }>();
  add(day: number, v: number): void {
    const d = this.days.get(day);
    if (d) { d.s += v; d.n++; } else this.days.set(day, { s: v, n: 1 });
  }
  get n(): number { let n = 0; for (const d of this.days.values()) n += d.n; return n; }
  get mean(): number | null { let s = 0, n = 0; for (const d of this.days.values()) { s += d.s; n += d.n; } return n ? s / n : null; }
}

export interface Boot { est: number | null; lo: number | null; hi: number | null; nDays: number; n: number }

/** Mean of `a` (or of a − b when b is given) with a 95% interval from resampling whole days. */
export function dayBoot(a: DayAcc, b?: DayAcc, B = 600, seed = 99): Boot {
  const days = [...new Set([...a.days.keys(), ...(b ? [...b.days.keys()] : [])])].sort((x, y) => x - y);
  const est = b ? (a.mean !== null && b.mean !== null ? a.mean - b.mean : null) : a.mean;
  if (days.length < 5 || est === null) return { est, lo: null, hi: null, nDays: days.length, n: a.n };
  const r = rng(seed);
  const out: number[] = [];
  for (let k = 0; k < B; k++) {
    let sa = 0, na = 0, sb = 0, nb = 0;
    for (let i = 0; i < days.length; i++) {
      const d = days[Math.floor(r() * days.length)];
      const x = a.days.get(d); if (x) { sa += x.s; na += x.n; }
      if (b) { const y = b.days.get(d); if (y) { sb += y.s; nb += y.n; } }
    }
    if (na === 0 || (b && nb === 0)) continue;
    out.push(b ? sa / na - sb / nb : sa / na);
  }
  out.sort((x, y) => x - y);
  return { est, lo: out.length ? out[Math.floor(0.025 * out.length)] : null, hi: out.length ? out[Math.min(out.length - 1, Math.floor(0.975 * out.length))] : null, nDays: days.length, n: a.n };
}

export const fmtBoot = (b: Boot, d = 2, unit = ""): string => `${fx(b.est, d)}${unit} [${fx(b.lo, d)}, ${fx(b.hi, d)}] n=${b.n}, days=${b.nDays}`;

export function table(head: string[], rows: Array<Array<string | number>>): string[] {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)));
  const line = (r: Array<string | number>) => "| " + r.map((c, i) => String(c ?? "").padEnd(w[i])).join(" | ") + " |";
  return [line(head), "|" + w.map((x) => "-".repeat(x + 2)).join("|") + "|", ...rows.map(line)];
}
