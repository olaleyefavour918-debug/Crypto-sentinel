import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { runMonitor } from "@/lib/monitor";
import { ensureSetup } from "@/lib/migrations";
import { encryptPayload, getVapid, pushToAll, validEndpoint, validKeys, vapidAuthHeader, type PushPayload } from "@/lib/webpush";
import { NOW } from "./helpers/fixtures";
import { makeHarness, type Harness } from "./helpers/harness";

const u = (s: string) => Buffer.from(s, "base64url");

describe("web push encryption (RFC 8291)", () => {
  it("reproduces the RFC 8291 Appendix A example byte for byte", () => {
    const body = encryptPayload(
      Buffer.from("When I grow up, I want to be a watermelon"),
      u("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
      u("BTBZMqHH6r4Tts7J_aSIgg"),
      { asPrivate: u("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), salt: u("DGv6ra1nlYgDCS1FRnbzlw") },
    );
    const expected =
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
      "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
      "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";
    assert.equal(body.toString("base64url"), expected);
  });

  it("VAPID header carries a valid ES256 signature for the stored public key", async () => {
    const h = await makeHarness();
    try {
      const keys = await getVapid(h.t.db);
      assert.equal((await getVapid(h.t.db)).publicKey, keys.publicKey, "keys are generated once and reused");
      const header = vapidAuthHeader(keys, "https://fcm.googleapis.com/fcm/send/abc", NOW);
      const m = header.match(/^vapid t=([^,]+), k=(.+)$/)!;
      const [head, claims, sig] = m[1].split(".");
      assert.equal(m[2], keys.publicKey);
      assert.equal(JSON.parse(u(claims).toString()).aud, "https://fcm.googleapis.com");
      const pub = createPublicKey({ key: { kty: "EC", crv: "P-256", x: keys.privateJwk.x, y: keys.privateJwk.y }, format: "jwk" });
      assert.equal(verify("sha256", Buffer.from(`${head}.${claims}`), { key: pub, dsaEncoding: "ieee-p1363" }, u(sig)), true);
    } finally { await h.cleanup(); }
  });

  it("only accepts https subscriptions on known push-service hosts with well-formed keys", () => {
    assert.equal(validEndpoint("https://fcm.googleapis.com/fcm/send/x"), true);
    assert.equal(validEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x"), true);
    assert.equal(validEndpoint("https://web.push.apple.com/x"), true);
    for (const bad of ["http://fcm.googleapis.com/x", "https://evil.example.com/x", "https://169.254.169.254/x", "https://googleapis.com.evil.com/x", "nonsense"]) assert.equal(validEndpoint(bad), false, bad);
    const k = createECDH("prime256v1"); k.generateKeys();
    assert.equal(validKeys(k.getPublicKey().toString("base64url"), Buffer.alloc(16, 1).toString("base64url")), true);
    assert.equal(validKeys("abc", "def"), false);
  });
});

/** Browser-side decryption (RFC 8291 §4) used to prove the delivered bytes are readable by the subscriber. */
function decrypt(body: Buffer, uaPriv: ReturnType<typeof createECDH>, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const cipher = body.subarray(21 + idlen);
  const secret = uaPriv.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync("sha256", secret, authSecret, Buffer.concat([Buffer.from("WebPush: info\0"), uaPriv.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, "padding delimiter");
  return plain.subarray(0, plain.length - 1).toString("utf8");
}

describe("push notifications on BUY / SELL", () => {
  let h: Harness;
  const ua = createECDH("prime256v1");
  const auth = Buffer.alloc(16, 7);
  const calls: Array<{ url: string; headers: Record<string, string>; body: Buffer }> = [];
  let status = 201;
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Uint8Array) });
    return new Response("", { status });
  }) as unknown as typeof fetch;
  const run = (advance = 0) => { h.ex.now += advance; return runMonitor({ ...h.deps(), push: { fetchFn } }); };
  const payloads = () => calls.map((c) => JSON.parse(decrypt(c.body, ua, auth)) as PushPayload);

  before(async () => {
    ua.generateKeys();
    h = await makeHarness();
    await ensureSetup(h.t.db);
    await h.t.db.query("insert into push_subscriptions (endpoint, p256dh, auth) values ($1, $2, $3)", [
      "https://fcm.googleapis.com/fcm/send/device-1", ua.getPublicKey().toString("base64url"), auth.toString("base64url"),
    ]);
  });
  after(async () => { await h.cleanup(); });

  it("sends one encrypted, VAPID-signed notification per new BUY, readable by the subscribed device", async () => {
    await run();
    const buys = (await h.q<{ n: number }>("select count(*)::int as n from paper_trades where event_type = 'BUY'"))[0].n;
    assert.equal(buys, 5);
    assert.equal(calls.length, 5);
    const p = payloads();
    assert.ok(p.every((x) => /^BUY signal · [A-Z]+\/USDT$/.test(x.title)));
    assert.ok(p.every((x) => /No real order was placed/.test(x.body)));
    assert.deepEqual(new Set(p.map((x) => x.title)).size, 5);
    assert.ok(calls.every((c) => c.headers["content-encoding"] === "aes128gcm" && /^vapid t=.+, k=.+$/.test(c.headers.authorization) && c.url === "https://fcm.googleapis.com/fcm/send/device-1"));
  });

  it("does not push the same trade twice on later runs", async () => {
    const before = calls.length;
    await run(60_000);
    await run(60_000);
    assert.equal(calls.length, before);
  });

  it("an expired subscription (410) is removed and the monitor run still succeeds", async () => {
    status = 410;
    h.setMarket(h.ex.now + 3600_000 * 3, "down", true);
    h.ex.now += 0;
    const r = await run(3600_000);
    assert.notEqual(r.status, "failed");
    // force a pushable event
    await h.t.db.query("update paper_trades set push_sent_at = null where id = (select max(id) from paper_trades)");
    await pushToAll(h.t.db, { title: "t", body: "b", tag: "t", url: "/" }, { fetchFn });
    const left = (await h.q<{ n: number }>("select count(*)::int as n from push_subscriptions"))[0].n;
    assert.equal(left, 0);
  });
});
