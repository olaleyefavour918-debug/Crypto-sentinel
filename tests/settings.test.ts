import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_RECIPIENT, DEFAULT_SETTINGS, STARTING_BALANCE_USDT, normalizeStoredSettings, validateSettings } from "@/lib/settings";

describe("settings", () => {
  it("defaults match the brief", () => {
    assert.equal(DEFAULT_RECIPIENT, "olaleyevictor206@gmail.com");
    assert.equal(DEFAULT_SETTINGS.emailRecipient, DEFAULT_RECIPIENT);
    assert.equal(STARTING_BALANCE_USDT, 65.5);
    assert.equal(DEFAULT_SETTINGS.positionAmountUsdt, 10);
    assert.equal(DEFAULT_SETTINGS.stopLossPct, 2);
    assert.equal(DEFAULT_SETTINGS.takeProfitPct, 4);
    assert.deepEqual([DEFAULT_SETTINGS.emaFast, DEFAULT_SETTINGS.emaSlow, DEFAULT_SETTINGS.rsiPeriod, DEFAULT_SETTINGS.atrPeriod], [20, 50, 14, 14]);
    assert.deepEqual([DEFAULT_SETTINGS.macdFast, DEFAULT_SETTINGS.macdSlow, DEFAULT_SETTINGS.macdSignal], [12, 26, 9]);
    assert.deepEqual([DEFAULT_SETTINGS.rsiMin, DEFAULT_SETTINGS.rsiMax], [50, 65]);
    assert.equal(DEFAULT_SETTINGS.buyEmailEnabled && DEFAULT_SETTINGS.sellEmailEnabled, true);
  });
  it("accepts a valid partial update and leaves the rest alone", () => {
    const r = validateSettings({ positionAmountUsdt: 25, trendExitEnabled: true }, DEFAULT_SETTINGS);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.value.positionAmountUsdt, 25);
      assert.equal(r.value.trendExitEnabled, true);
      assert.equal(r.value.stopLossPct, 2);
    }
  });
  it("rejects unknown keys, wrong types, out-of-range values and inconsistent indicator pairs", () => {
    const bad = (input: unknown) => { const r = validateSettings(input, DEFAULT_SETTINGS); assert.equal(r.ok, false); return r.ok ? [] : r.errors; };
    assert.match(bad({ apiKey: "x" })[0], /Unknown setting/);
    assert.match(bad({ positionAmountUsdt: "10" })[0], /number/);
    assert.match(bad({ positionAmountUsdt: 0 })[0], /between/);
    assert.match(bad({ positionAmountUsdt: NaN })[0], /number/);
    assert.match(bad({ emaFast: 20.5 })[0], /whole/);
    assert.match(bad({ buyEmailEnabled: "yes" })[0], /true or false/);
    assert.match(bad({ emaFast: 60 })[0], /emaFast must be smaller/);
    assert.match(bad({ rsiMin: 70 })[0], /rsiMin must be smaller/);
    assert.match(bad({ macdFast: 30 })[0], /macdFast must be smaller/);
    assert.match(bad({ emailRecipient: "not-an-email" })[0], /valid email/);
    assert.match(bad({ emailRecipient: "a@b.co\r\nBcc: evil@x.com" })[0], /valid email/);
    assert.equal(bad(null).length, 1);
    assert.equal(bad([1]).length, 1);
  });
  it("stored garbage falls back per key instead of discarding everything", () => {
    const s = normalizeStoredSettings({ positionAmountUsdt: 42, stopLossPct: "oops", emaFast: 999 });
    assert.equal(s.positionAmountUsdt, 42);
    assert.equal(s.stopLossPct, 2);
    assert.equal(s.emaFast, 20);
    assert.deepEqual(normalizeStoredSettings(null), DEFAULT_SETTINGS);
  });
});
