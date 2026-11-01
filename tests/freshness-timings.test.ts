import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { SETUP_STALE_MS, setupFreshness } from "@/lib/freshness";
import { makeHarness, type Harness } from "./helpers/harness";

describe("setup freshness", () => {
  it("a live setup is stale only after 15 minutes without a re-check; expired setups are never flagged", () => {
    assert.equal(setupFreshness(1_000_000, 1_000_000 + SETUP_STALE_MS, "CONFIRMED").stale, false);
    assert.equal(setupFreshness(1_000_000, 1_000_000 + SETUP_STALE_MS + 1, "CONFIRMED").stale, true);
    assert.equal(setupFreshness(1_000_000, 1_000_000 + 10 * SETUP_STALE_MS, "EXPIRED").stale, false);
    assert.equal(setupFreshness(2_000_000, 1_000_000, "POTENTIAL").ageMs, 0, "a clock skew never gives a negative age");
  });
});

describe("monitor stage timings (latency measurement)", () => {
  let h: Harness;
  before(async () => { h = await makeHarness(); });
  after(async () => { await h.cleanup(); });
  it("every run records where its time went, in the result and in job_runs.details", async () => {
    const r = await h.run();
    const t = r.timings!;
    assert.ok(t, "timings present");
    for (const k of ["tickersMs", "klinesMs", "evaluateMs", "emailMs", "pushMs", "totalMs"] as const) assert.ok(Number.isFinite(t[k]) && t[k] >= 0, k);
    assert.ok(t.totalMs >= t.tickersMs + t.klinesMs + t.evaluateMs, "total covers the stages");
    const rows = await h.q<{ details: { timings?: { totalMs: number } } }>("select details from job_runs order by id desc limit 1");
    assert.equal(typeof rows[0].details.timings?.totalMs, "number");
  });
});
