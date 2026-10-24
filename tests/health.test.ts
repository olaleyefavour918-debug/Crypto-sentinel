import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessMonitor, configStatus } from "@/lib/health";
import type { JobRunRow } from "@/lib/store";
import { NOW } from "./helpers/fixtures";

const run = (minAgo: number, status = "success"): JobRunRow => ({ id: 1, startedAt: NOW - minAgo * 60_000, finishedAt: NOW - minAgo * 60_000 + 1000, status, triggerSource: "cron", durationMs: 1000, message: null });
const S = { entryWindowMinutes: 30 };

describe("monitor health assessment", () => {
  it("never_run when nothing has happened (does NOT claim monitoring is active)", () => {
    const a = assessMonitor([], NOW, S);
    assert.equal(a.state, "never_run");
    assert.equal(a.lastSuccessAt, null);
  });
  it("active for a one-minute cadence", () => {
    const a = assessMonitor([0, 1, 2, 3, 4].map((m) => run(m)), NOW, S);
    assert.equal(a.state, "active");
    assert.equal(a.cadenceMinutes, 1);
    assert.equal(a.catchesEntries, true);
  });
  it("stopped when runs stop arriving", () => {
    const a = assessMonitor([30, 31, 32, 33, 34].map((m) => run(m)), NOW, S);
    assert.equal(a.state, "stopped");
    assert.match(a.message, /stopped/i);
  });
  it("failing when the newest run could not get market data", () => {
    const a = assessMonitor([run(0, "failed"), run(1), run(2), run(3)], NOW, S);
    assert.equal(a.state, "failing");
    assert.notEqual(a.lastSuccessAt, null);
  });
  it("slow when the cadence is too coarse to catch hourly signals", () => {
    const a = assessMonitor([20, 50, 80, 110].map((m) => run(m)), NOW + 0, S);
    assert.equal(a.state, "slow");
    assert.equal(a.catchesEntries, false);
  });
  it("active once a fixed scheduler has produced recent runs, even if older runs were hours apart", () => {
    const a = assessMonitor([0, 5, 10, 15, 20, 25, 240, 480, 720].map((m) => run(m)), NOW, S);
    assert.equal(a.state, "active");
    assert.equal(a.cadenceMinutes, 5);
    assert.equal(a.catchesEntries, true);
  });
  it("daily-only scheduling is reported as stopped between runs", () => {
    const a = assessMonitor([run(600), run(600 + 1440), run(600 + 2880)], NOW, S);
    assert.equal(a.state, "stopped");
  });
  it("ignores skipped_locked runs when judging liveness", () => {
    const a = assessMonitor([run(0, "skipped_locked"), run(1, "skipped_locked")], NOW, S);
    assert.equal(a.state, "never_run");
  });
});

describe("configuration status exposes booleans only", () => {
  it("reports what is set, never the values", () => {
    const c = configStatus({ DATABASE_URL: "postgres://u:supersecret@h/db", ADMIN_PASSWORD: "pw", CRON_SECRET: "0123456789abcdef0123", RESEND_API_KEY: "re_xxxxxxxxxxxxxxxxxxxx" });
    assert.deepEqual([c.database, c.adminPassword, c.cronSecret, c.emailProvider, c.emailConfigured], [true, true, true, "resend", true]);
    assert.ok(!JSON.stringify(c).includes("supersecret"));
    assert.ok(!JSON.stringify(c).includes("re_xxxx"));
  });
  it("flags a missing/short cron secret and a missing email provider", () => {
    const c = configStatus({ CRON_SECRET: "short" });
    assert.deepEqual([c.database, c.cronSecret, c.emailConfigured], [false, false, false]);
    assert.match(c.emailIssue ?? "", /No email provider/);
  });
  it("Brevo without EMAIL_FROM is reported as misconfigured", () => {
    const c = configStatus({ BREVO_API_KEY: "xkeysib-abcdefghijklmnop" });
    assert.equal(c.emailConfigured, false);
    assert.match(c.emailIssue ?? "", /EMAIL_FROM/);
  });
});
