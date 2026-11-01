import { computeSeries } from "@/lib/rules";
import { evaluateStrategy } from "@/lib/setups";
import { STRUCTURE, buildZones, findPivots, nearestSupport } from "@/lib/structure";
import type { Candle } from "@/lib/types";
import { H1, H4, barrier, fwd, priceAt, type Ctx, type HourRec } from "./ctx";
import { DayAcc, dayBoot, fmtBoot, fx, median, pct, quantile, table } from "./stats";
import { hoursOf, type Period } from "./sec-trend";

const ORDER = ["b1_support", "b2_approach", "b3_holding", "b4_h4_context", "b5_h4_momentum", "b6_rsi", "b7_macd", "b8_reversal", "b9_volume", "b10_levels", "b11_btc"];
const passOf = (h: HourRec, id: string) => !!h.bounce.conditions.find((c) => c.id === id)?.passed;

export function bounceSection(ctxs: Ctx[], P: Period): string[] {
  const L: string[] = [];
  const all = ctxs.flatMap((c) => hoursOf(c, P).map((h) => ({ c, h }))).filter(({ h }) => h.bounce.dataOk);
  const days = (P.endMs - P.startMs) / 86_400_000;
  L.push(`Closed-candle evaluations with usable data: ${all.length} (${ctxs.length} coins × about ${fx(days, 0)} days of hourly candles). Fully confirmed Support-Bounce hours: ${all.filter(({ h }) => h.bounce.full).length}; hours with an early-style 'potential' read: ${all.filter(({ h }) => h.bounce.potential).length}.`);
  L.push("");
  L.push("### 2a. Where the 11 conditions remove candidates");
  const marg = ORDER.map((id) => all.filter(({ h }) => passOf(h, id)).length);
  const sole = ORDER.map((id) => {
    const others = all.filter(({ h }) => ORDER.every((o) => o === id || passOf(h, o)));
    return { others: others.length, sole: others.filter(({ h }) => !passOf(h, id)).length };
  });
  let alive = all.filter(() => true);
  const funnel: Array<Array<string | number>> = [];
  for (let i = 0; i < ORDER.length; i++) {
    alive = alive.filter(({ h }) => passOf(h, ORDER[i]));
    funnel.push([ORDER[i], pct(marg[i], all.length), alive.length, sole[i].others, sole[i].sole]);
  }
  L.push(...table(["condition", "passes on its own", "still alive after this step (cumulative)", "hours where the other 10 pass", "…of which blocked ONLY by this"], funnel));
  const ind = ORDER.reduce((a, _id, i) => a * (marg[i] / Math.max(1, all.length)), 1) * all.length;
  L.push(`If the 11 conditions were independent the expected number of full signals would be ${fx(ind, 2)}; observed ${all.filter(({ h }) => h.bounce.full).length}. (Conditions are not independent, so this is only a yardstick.)`);
  const ctxHours = all.filter(({ h }) => h.bounce.context);
  L.push(`Hours where the context (support zone, touched, holding, 4H not falling) holds: ${ctxHours.length} (${pct(ctxHours.length, all.length, 2)}). Of those, RSI-recovery passes in ${pct(ctxHours.filter(({ h }) => passOf(h, "b6_rsi")).length, ctxHours.length)}, reversal candle in ${pct(ctxHours.filter(({ h }) => passOf(h, "b8_reversal")).length, ctxHours.length)}, volume in ${pct(ctxHours.filter(({ h }) => passOf(h, "b9_volume")).length, ctxHours.length)}, net reward/risk in ${pct(ctxHours.filter(({ h }) => passOf(h, "b10_levels")).length, ctxHours.length)}.`);
  L.push("");

  // 2b zone diagnostics
  L.push("### 2b. Support-zone detection");
  let nz = 0, est = 0, wide = 0, withSupport = 0, sampled = 0, maxW = 0;
  const dist: number[] = [], touches: number[] = [];
  for (const c of ctxs) {
    for (const h of hoursOf(c, P)) {
      if (h.p % 2 !== 0 || !h.bounce.dataOk || !h.snap.atr) continue;
      const w = c.h1.slice(Math.max(0, h.p + 1 - 200), h.p + 1);
      const piv = findPivots(w, STRUCTURE.pivotK1h, STRUCTURE.lookback1h);
      const zones = buildZones([...piv.highs, ...piv.lows], h.snap.atr);
      const price = w[w.length - 1].close;
      const sup = nearestSupport(zones, price, h.snap.atr);
      sampled++; nz += zones.length;
      for (const z of zones) { if (z.established) { est++; touches.push(z.touches); } const wd = (z.high - z.low) / h.snap.atr; if (wd > maxW) maxW = wd; if (wd > STRUCTURE.maxWidthAtr) wide++; }
      if (sup) { withSupport++; dist.push((price - sup.high) / h.snap.atr); }
    }
  }
  L.push(`Across ${sampled} sampled hours: ${fx(nz / sampled, 1)} zones per hour on average, ${fx(est / sampled, 1)} of them established (2+ touches). An established support zone exists below price in ${pct(withSupport, sampled)} of hours.`);
  L.push(`Distance from price down to the top of the NEAREST established support: median ${fx(median(dist))} ATR, 75th percentile ${fx(quantile(dist, 0.75))}, 90th ${fx(quantile(dist, 0.9))}. Condition b2 needs price within 1.5 ATR above the zone, so when the nearest zone is far away no nearer, weaker zone is ever considered.`);
  L.push(`Zones wider than the ${STRUCTURE.maxWidthAtr}-ATR limit that makes a zone 'too vague': ${wide} (widest seen ${fx(maxW, 2)} ATR). ${wide === 0 ? "That limit can never trigger, because clustering caps a zone at 0.5 ATR of pivots plus 0.5 ATR of padding = 1.0 ATR. It is a dead condition (harmless, but it documents a protection that does not exist)." : ""}`);
  L.push("");

  // 2c hindsight bounces
  L.push("### 2c. What blocks REAL bounces? (hindsight check, diagnostic only)");
  L.push("A 'real bounce' here = a 1H swing low that touched an established support zone (zones computed only from data before it) and was followed, within 24h, by +3 ATR before -1.5 ATR. Hindsight is optimistic, so this shows which conditions structurally filter out genuine bounces, not what the strategy should earn.");
  let opps = 0, anyFull = 0;
  const anyPass: Record<string, number> = Object.fromEntries(ORDER.map((id) => [id, 0]));
  const firstFail: Record<string, number> = {};
  let ctxPass = 0;
  for (const c of ctxs) {
    const byP = new Map(c.hours.map((h) => [h.p, h]));
    for (let q = 60; q < c.h1.length - 5; q++) {
      const ct = c.h1[q].start + H1;
      if (ct < P.startMs || ct > P.endMs - 30 * H1) continue;
      if (![1, 2, 3].every((j) => c.h1[q].low < c.h1[q - j].low && c.h1[q].low <= c.h1[q + j].low)) continue;
      const w = c.h1.slice(Math.max(0, q + 1 - 200), q + 1);
      const atr = computeSeries(w, c.settings).atr[w.length - 1];
      if (!atr) continue;
      const piv = findPivots(w, STRUCTURE.pivotK1h, STRUCTURE.lookback1h);
      const zones = buildZones([...piv.highs, ...piv.lows], atr).filter((z) => z.established);
      const low = c.h1[q].low;
      if (!zones.some((z) => low <= z.high + 0.25 * atr && low >= z.low - 0.5 * atr)) continue;
      const px = priceAt(c, ct);
      if (!px || barrier(c, ct, px + 3 * atr, px - 1.5 * atr, 24) !== "up") continue;
      opps++;
      const hs = [0, 1, 2, 3].map((k) => byP.get(q + k)).filter((h): h is HourRec => !!h && h.bounce.dataOk);
      if (!hs.length) continue;
      for (const id of ORDER) if (hs.some((h) => passOf(h, id))) anyPass[id]++;
      if (hs.some((h) => h.bounce.full)) anyFull++;
      if (hs.some((h) => h.bounce.context)) ctxPass++;
      const best = [...hs].sort((a, b) => b.bounce.conditions.filter((x) => x.passed).length - a.bounce.conditions.filter((x) => x.passed).length)[0];
      const ff = ORDER.find((id) => !passOf(best, id)) ?? "none";
      firstFail[ff] = (firstFail[ff] ?? 0) + 1;
    }
  }
  L.push(`Real support bounces found: ${opps}. The strategy would have confirmed ${anyFull} of them (${pct(anyFull, opps)}); the context conditions (zone, touched, holding, 4H) held at some point for ${ctxPass} (${pct(ctxPass, opps)}).`);
  L.push(...table(["condition", "passes at some point from the low to 3h later", "first condition failing on the best-scoring hour"], ORDER.map((id) => [id, pct(anyPass[id], opps), firstFail[id] ?? 0])));
  L.push("");

  // 2d correctness checks
  L.push("### 2d. Implementation checks (indexing, scale invariance)");
  let badIdx = 0, pivChecked = 0, tail = 0;
  for (const c of ctxs) {
    for (const h of c.hours.filter((x) => x.p % 25 === 0)) {
      const w = c.h1.slice(Math.max(0, h.p + 1 - 200), h.p + 1);
      const piv = findPivots(w, STRUCTURE.pivotK1h, STRUCTURE.lookback1h);
      for (const pv of [...piv.highs, ...piv.lows]) { pivChecked++; if (w[pv.index].start !== pv.start) badIdx++; if (pv.index > w.length - 1 - STRUCTURE.pivotK1h) tail++; }
    }
  }
  L.push(`Pivot index/time consistency: ${pivChecked} pivots checked, ${badIdx} with a mismatched candle time, ${tail} inside the newest ${STRUCTURE.pivotK1h} candles (those can never be pivots). ${badIdx + tail === 0 ? "No indexing error found." : "PROBLEM FOUND."}`);
  let diffs = 0, compared = 0;
  const scale = (a: Candle[]): Candle[] => a.map((x) => ({ ...x, open: x.open * 1000, high: x.high * 1000, low: x.low * 1000, close: x.close * 1000, turnover: x.turnover * 1000 }));
  for (const c of ctxs) {
    for (const h of c.hours.filter((x) => x.p % 50 === 0 && x.bounce.dataOk)) {
      let n4 = 0; while (n4 < c.h4.length && c.h4[n4].start + H4 <= h.ct) n4++;
      const base = { symbol: c.symbol, h1Closed: c.h1.slice(Math.max(0, h.p + 1 - 200), h.p + 1), h4Closed: c.h4.slice(Math.max(0, n4 - 200), n4), forming: null, now: h.ct, settings: c.settings, btcH4: null } as const;
      const scaled = { ...base, h1Closed: scale(base.h1Closed), h4Closed: scale(base.h4Closed) };
      for (const id of ["BOUNCE", "EXIT_WARNING"] as const) {
        const a = evaluateStrategy(id, base), b = evaluateStrategy(id, scaled);
        compared++;
        if (JSON.stringify(a.conditions.map((x) => x.passed)) !== JSON.stringify(b.conditions.map((x) => x.passed))) diffs++;
      }
    }
  }
  L.push(`Scale invariance (all prices x1000): ${compared} evaluations compared, ${diffs} differed in which conditions passed. ${diffs === 0 ? "No hidden absolute-price constants." : "PROBLEM FOUND: a threshold depends on the price level."}`);
  L.push("");

  // 2e coverage
  L.push("### 2e Coverage and what 30 signals would take");
  const fullHours = all.filter(({ h }) => h.bounce.full);
  const edges = fullHours.filter(({ c, h }) => { const prev = c.hours.find((x) => x.p === h.p - 1); return !prev || !prev.bounce.full; });
  const coinDays = ctxs.length * days;
  const rate = edges.length / coinDays;
  L.push(`Fresh confirmed bounces in closed-candle evaluation: ${edges.length} over ${fx(coinDays, 0)} coin-days = ${fx(rate * 100, 2)} per 100 coin-days. At that rate 30 signals need about ${rate > 0 ? fx(30 / rate, 0) : "an unbounded number of"} coin-days (${rate > 0 ? fx(30 / rate / ctxs.length, 0) : "n/a"} days with these ${ctxs.length} coins). 'Rule of three': with ${edges.length} observed, the true rate could plausibly be up to ${fx(((edges.length === 0 ? 3 : edges.length + 3) / coinDays) * 100, 2)} per 100 coin-days.`);
  const same = all.filter(({ h }) => h.bounce.potential).length;
  L.push(`Hours with a 'potential' read (either the reversal candle or the volume test is enough): ${same}.`);
  return L;
}

export function exitSection(ctxs: Ctx[], P: Period): string[] {
  const L: string[] = [];
  const all = ctxs.flatMap((c) => hoursOf(c, P).map((h) => ({ c, h }))).filter(({ h }) => h.exitW.dataOk);
  const ID = ["e1_resistance", "e2_rsi", "e3_macd", "e4_reversal", "e5_volume", "e6_false_breakout", "e7_lower_high", "e8_breakdown"];
  const pass = (h: HourRec, id: string) => !!h.exitW.conditions.find((c) => c.id === id)?.passed;
  const days = (P.endMs - P.startMs) / 86_400_000;
  const full = all.filter(({ h }) => h.exitW.full);
  L.push(`Closed-candle evaluations: ${all.length}. Confirmed warnings (any hour): ${full.length} = ${fx(full.length / (ctxs.length * days), 2)} per coin-day; potential: ${all.filter(({ h }) => h.exitW.potential).length}.`);
  L.push("");
  L.push("### 3a. How selective are the warning conditions?");
  const evid = (h: HourRec) => ["e2_rsi", "e3_macd", "e4_reversal", "e5_volume", "e6_false_breakout", "e7_lower_high"].filter((id) => pass(h, id)).length;
  L.push(...table(["condition", "passes (all hours)"], ID.map((id) => [id, pct(all.filter(({ h }) => pass(h, id)).length, all.length)])));
  const dist = [0, 1, 2, 3, 4, 5, 6].map((k) => `${k}: ${pct(all.filter(({ h }) => evid(h) === k).length, all.length)}`);
  L.push(`Evidence count among the six trigger conditions (a resistance warning needs 3 plus a reversal or false breakout): ${dist.join(" · ")}.`);
  const e4 = all.filter(({ h }) => pass(h, "e4_reversal"));
  const trivial = e4.filter(({ h }) => /close below the prior low/.test(h.exitW.conditions.find((c) => c.id === "e4_reversal")?.detail ?? "")).length;
  L.push(`Reversal evidence (e4) passes in ${e4.length} hours; in ${trivial} of them (${pct(trivial, e4.length, 0)}) only because a candle closed below the previous candle's low near the zone, which is true of any ordinary down candle.`);
  const bdOnly = full.filter(({ h }) => h.exitW.variant === "breakdown").length;
  L.push(`Confirmed warnings by variant: resistance ${full.length - bdOnly}, breakdown ${bdOnly}.`);
  const edge = full.filter(({ c, h }) => { const prev = c.hours.find((x) => x.p === h.p - 1); return !prev || !prev.exitW.full; });
  L.push(`Distinct runs (a warning that persists over consecutive hours counts once): ${edge.length}. Days that contain at least one warning: ${new Set(full.map(({ h }) => h.day)).size} of ${fx(days, 0)}.`);
  L.push("");

  L.push("### 3b. Does a warning predict a fall? (1.5 ATR down before 1.5 ATR up within 24h; ties and 'neither' count as NOT a fall)");
  const outcome = (c: Ctx, h: HourRec): "down" | "up" | "none" | null => { const px = priceAt(c, h.ct); return px && h.snap.atr ? barrier(c, h.ct, px + 1.5 * h.snap.atr, px - 1.5 * h.snap.atr, 24) : null; };
  const trendUp = (h: HourRec) => h.snap.emaFast !== null && h.snap.emaSlow !== null && h.snap.emaFast > h.snap.emaSlow;
  const sets: Array<[string, (h: HourRec) => boolean]> = [
    ["ALL hours", () => true],
    ["e1 at/below resistance zone", (h) => pass(h, "e1_resistance")],
    ["3+ trigger conditions (any location)", (h) => evid(h) >= 3],
    ["potential", (h) => h.exitW.potential],
    ["CONFIRMED", (h) => h.exitW.full],
    ["CONFIRMED, resistance variant", (h) => h.exitW.full && h.exitW.variant !== "breakdown"],
    ["CONFIRMED, breakdown variant", (h) => h.exitW.full && h.exitW.variant === "breakdown"],
    ...ID.slice(1).map((id) => [`only the single condition ${id}`, (h: HourRec) => pass(h, id)] as [string, (h: HourRec) => boolean]),
  ];
  const accs = sets.map(() => new DayAcc());
  const accUp = sets.map(() => new DayAcc());
  const stateAcc = { up: new DayAcc(), down: new DayAcc() };
  const stateFull = { up: new DayAcc(), down: new DayAcc() };
  for (const { c, h } of all) {
    if (h.ct > P.endMs - 25 * H1) continue;
    const o = outcome(c, h); if (o === null) continue;
    const v = o === "down" ? 1 : 0;
    sets.forEach(([, fn], i) => { if (fn(h)) { accs[i].add(h.day, v * 100); accUp[i].add(h.day, o === "up" ? 100 : 0); } });
    (trendUp(h) ? stateAcc.up : stateAcc.down).add(h.day, v * 100);
    if (h.exitW.full) (trendUp(h) ? stateFull.up : stateFull.down).add(h.day, v * 100);
  }
  L.push(...table(["group", "n", "P(fall first)", "P(rise first)", "fall minus ALL (day-resampled 95%)"], sets.map(([name], i) => [name, accs[i].n, fx(accs[i].mean, 1) + "%", fx(accUp[i].mean, 1) + "%", i === 0 ? "—" : fmtBoot(dayBoot(accs[i], accs[0]), 1, " pts")])));
  L.push(`Same hours split by market state (1h EMA20 vs EMA50), to remove drift: ALL in uptrend ${fx(stateAcc.up.mean, 1)}% (n=${stateAcc.up.n}), ALL in downtrend ${fx(stateAcc.down.mean, 1)}% (n=${stateAcc.down.n}); CONFIRMED in uptrend ${fx(stateFull.up.mean, 1)}% (n=${stateFull.up.n}), CONFIRMED in downtrend ${fx(stateFull.down.mean, 1)}% (n=${stateFull.down.n}).`);
  const matched = (name: string, fn: (h: HourRec) => boolean) => {
    const d = new DayAcc();
    for (const { c, h } of all) {
      if (h.ct > P.endMs - 25 * H1 || !fn(h)) continue;
      const o = outcome(c, h); if (o === null) continue;
      d.add(h.day, (o === "down" ? 100 : 0) - ((trendUp(h) ? stateAcc.up.mean : stateAcc.down.mean) ?? 0));
    }
    L.push(`${name} minus a baseline matched on market state (what remains after removing the effect of simply being in an up- or down-trend): ${fmtBoot(dayBoot(d), 1, " pts")}`);
  };
  matched("CONFIRMED", (h) => h.exitW.full);
  matched("potential", (h) => h.exitW.potential);
  const naive = accs[4];
  const p = (naive.mean ?? 0) / 100, b = (accs[0].mean ?? 0) / 100;
  const z = naive.n ? (p - b) / Math.sqrt((b * (1 - b)) / naive.n) : 0;
  L.push(`Evaluation method note: the earlier verdict treated the ${naive.n} confirmed hours as independent (z=${fx(z, 1)}). They are not: warnings persist for several hours and cluster in the same days across coins, so only ${naive.days.size} distinct days carry evidence. The day-resampled interval above is the honest uncertainty.`);
  L.push("");

  L.push("### 3c. Same question, different yardsticks (CONFIRMED vs ALL)");
  const yard: Array<[string, number, number]> = [["1.0 ATR / 12h", 1.0, 12], ["1.5 ATR / 24h", 1.5, 24], ["3 ATR / 48h", 3, 48]];
  const rows: Array<Array<string | number>> = [];
  for (const [name, k, hz] of yard) {
    const a = new DayAcc(), b2 = new DayAcc();
    for (const { c, h } of all) {
      if (h.ct > P.endMs - (hz + 1) * H1) continue;
      const px = priceAt(c, h.ct); if (!px || !h.snap.atr) continue;
      const o = barrier(c, h.ct, px + k * h.snap.atr, px - k * h.snap.atr, hz); if (o === null) continue;
      b2.add(h.day, o === "down" ? 100 : 0);
      if (h.exitW.full) a.add(h.day, o === "down" ? 100 : 0);
    }
    rows.push([name, a.n, fx(a.mean, 1) + "%", fx(b2.mean, 1) + "%", fmtBoot(dayBoot(a, b2), 1, " pts")]);
  }
  L.push(...table(["barrier / window", "n confirmed", "P(fall first | confirmed)", "P(fall first | any hour)", "difference"], rows));
  const fr: Array<Array<string | number>> = [];
  for (const hz of [1, 4, 12, 24]) {
    const a = new DayAcc(), a2 = new DayAcc(), b3 = new DayAcc();
    for (const { c, h } of all) {
      if (h.ct > P.endMs - (hz + 1) * H1) continue;
      const f = fwd(c, h.ct, hz); if (f === null) continue;
      b3.add(h.day, f * 100);
      if (h.exitW.full) a.add(h.day, f * 100);
      if (edge.some((e) => e.c === c && e.h === h)) a2.add(h.day, f * 100);
    }
    fr.push([`+${hz}h`, a.n, fx(a.mean, 3) + "%", fmtBoot(dayBoot(a, b3), 3, "%"), a2.n, fx(a2.mean, 3) + "%", fx(b3.mean, 3) + "%"]);
  }
  L.push("Average gross price change after a confirmed warning (a useful warning should be NEGATIVE and below the all-hours average):");
  L.push(...table(["horizon", "n (every confirmed hour)", "mean", "minus all-hours (95%)", "n (first hour of a run)", "mean", "all-hours mean"], fr));
  return L;
}
