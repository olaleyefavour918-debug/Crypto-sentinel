import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { runMonitor } from "@/lib/monitor";
import { ensureSetup } from "@/lib/migrations";
import { makeHarness, type Harness } from "./helpers/harness";

const ua = createECDH("prime256v1");
const auth = Buffer.alloc(16, 7);
const addSub = (h: Harness, id: string) => h.t.db.query("insert into push_subscriptions (endpoint, p256dh, auth) values ($1, $2, $3)", [`https://fcm.googleapis.com/fcm/send/${id}`, ua.getPublicKey().toString("base64url"), auth.toString("base64url")]);
const unsent = async (h: Harness) => (await h.q<{ n: number }>("select count(*)::int as n from paper_trades where event_type = 'BUY' and push_sent_at is null"))[0].n;

describe("push alerts are not lost on transient failure, and are never duplicated", () => {
  let h: Harness;
  const urls: string[] = [];
  let mode: "fail" | "ok" | "split" = "fail";
  const fetchFn = (async (url: string) => {
    urls.push(String(url));
    const ok = mode === "ok" || (mode === "split" && String(url).endsWith("good"));
    return new Response("", { status: ok ? 201 : 503 });
  }) as unknown as typeof fetch;
  const run = (advance = 0) => { h.ex.now += advance; return runMonitor({ ...h.deps(), push: { fetchFn } }); };
  before(async () => { ua.generateKeys(); h = await makeHarness(); await ensureSetup(h.t.db); await addSub(h, "device-1"); });
  after(async () => { await h.cleanup(); });

  it("when the push service is down, the alerts stay unsent and are retried on the next run", async () => {
    await run();
    assert.equal(await unsent(h), 5, "all 5 BUY alerts were released for retry");
    const after1 = urls.length;
    assert.ok(after1 >= 5);
    mode = "ok";
    await run(60_000);
    assert.equal(await unsent(h), 0, "delivered on the retry");
    const delivered = urls.length - after1;
    assert.equal(delivered, 5, "each alert delivered exactly once on the retry");
    await run(60_000);
    assert.equal(urls.length - after1, 5, "no duplicates on later runs");
  });
});

describe("partial delivery and age limit", () => {
  let h: Harness;
  const urls: string[] = [];
  let mode: "fail" | "split" = "split";
  const fetchFn = (async (url: string) => { urls.push(String(url)); return new Response("", { status: mode === "split" && String(url).endsWith("good") ? 201 : 503 }); }) as unknown as typeof fetch;
  const run = (advance = 0) => { h.ex.now += advance; return runMonitor({ ...h.deps(), push: { fetchFn } }); };
  before(async () => { ua.generateKeys(); h = await makeHarness(); await ensureSetup(h.t.db); await addSub(h, "good"); await addSub(h, "bad"); });
  after(async () => { await h.cleanup(); });

  it("an alert that reached at least one device is NOT retried (no duplicate on the device that got it)", async () => {
    await run();
    const n = urls.length;
    assert.equal(await unsent(h), 0);
    await run(60_000);
    assert.equal(urls.length, n, "nothing re-sent");
  });

  it("alerts that keep failing stop being retried after the one-hour freshness limit", async () => {
    // new trades would be needed; instead re-release one old trade and make everything fail
    mode = "fail";
    await h.t.db.query("update paper_trades set push_sent_at = null where id = (select min(id) from paper_trades)");
    await run(60_000);
    assert.equal(await unsent(h), 1, "released for retry while still fresh");
    const n = urls.length;
    await run(61 * 60_000);
    assert.equal(await unsent(h), 0, "too old: marked handled, not retried");
    const sentAfterLimit = urls.length;
    await run(60_000);
    assert.equal(urls.length, sentAfterLimit, "no further attempts");
    assert.ok(sentAfterLimit >= n);
  });
});

describe("push is not delayed by email, or by one slow device", () => {
  it("a slow mail server does not hold back the phone alert", async () => {
    ua.generateKeys();
    const h = await makeHarness();
    try {
      await ensureSetup(h.t.db);
      await addSub(h, "device-1");
      let open!: () => void;
      const gate = new Promise<void>((r) => { open = r; });
      const pushed: number[] = [];
      const pushFetch = (async () => { pushed.push(Date.now()); return new Response("", { status: 201 }); }) as unknown as typeof fetch;
      const d = h.deps();
      const slowEmail = (async (...a: Parameters<typeof fetch>) => { await gate; return (d.email!.fetchFn as typeof fetch)(...a); }) as typeof fetch;
      const running = runMonitor({ ...d, email: { ...d.email, fetchFn: slowEmail }, push: { fetchFn: pushFetch } });
      const t0 = Date.now();
      while (pushed.length < 5 && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 25));
      assert.equal(pushed.length, 5, "all 5 phone alerts were sent while the email send was still blocked");
      open();
      const r = await running;
      assert.notEqual(r.status, "failed");
    } finally { await h.cleanup(); }
  });

  it("devices are contacted in parallel: a hanging device does not delay another", async () => {
    ua.generateKeys();
    const h = await makeHarness();
    try {
      await ensureSetup(h.t.db);
      await addSub(h, "slow");
      await addSub(h, "fast");
      let open!: () => void;
      const gate = new Promise<void>((r) => { open = r; });
      const order: string[] = [];
      const fetchFn = (async (url: string) => { if (String(url).endsWith("slow")) { await gate; } order.push(String(url).split("/").pop() as string); return new Response("", { status: 201 }); }) as unknown as typeof fetch;
      const running = runMonitor({ ...h.deps(), push: { fetchFn } });
      const t0 = Date.now();
      while (!order.includes("fast") && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 25));
      assert.ok(order.includes("fast"), "the fast device was served while the slow one was still pending");
      open();
      await running;
    } finally { await h.cleanup(); }
  });
});
