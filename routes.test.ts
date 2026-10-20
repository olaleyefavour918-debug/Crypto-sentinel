import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import { POST as adminRun } from "@/app/api/admin/run/route";
import { DELETE as assetsDelete, PATCH as assetsPatch, POST as assetsPost } from "@/app/api/assets/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as cronGet, POST as cronPost } from "@/app/api/cron/monitor/route";
import { POST as emailTest } from "@/app/api/email/test/route";
import { GET as healthGet } from "@/app/api/health/route";
import { GET as marketGet } from "@/app/api/market/route";
import { PUT as settingsPut } from "@/app/api/settings/route";
import { GET as stateGet } from "@/app/api/state/route";
import { SESSION_COOKIE, signSession } from "@/lib/auth";
import { setDb } from "@/lib/db";
import { addAsset, loadSettings, MAX_ASSETS } from "@/lib/store";
import { bybitFetch, NOW, scaled, signalMarket } from "./helpers/fixtures";
import { makeHarness, type Harness } from "./helpers/harness";

const ORIGIN = "https://sentinel.example.com";
const ENV = { ADMIN_PASSWORD: "correct horse battery staple", CRON_SECRET: "0123456789abcdef0123456789abcdef", RESEND_API_KEY: "re_test_key_1234567890abcdef" } as const;
let ipSeq = 0;
let h: Harness;
let hosts: Set<string>;
const savedEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

function request(path: string, o: { method?: string; body?: unknown; raw?: string; cookie?: boolean | string; origin?: string | null; bearer?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": o.ip ?? `10.0.0.${++ipSeq}`, "x-forwarded-host": "sentinel.example.com", "x-forwarded-proto": "https" };
  if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  if (o.cookie) headers.cookie = typeof o.cookie === "string" ? o.cookie : `${SESSION_COOKIE}=${encodeURIComponent(signSession(process.env))}`;
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  const hasBody = o.body !== undefined || o.raw !== undefined;
  if (hasBody) headers["content-type"] = "application/json";
  return new Request(`${ORIGIN}${path}`, { method: o.method ?? "GET", headers, body: hasBody ? (o.raw ?? JSON.stringify(o.body)) : undefined });
}
const body = async (r: Response) => (await r.json()) as Record<string, any>;

before(async () => {
  for (const k of Object.keys(ENV)) savedEnv[k] = process.env[k];
  for (const k of ["BREVO_API_KEY", "EMAIL_FROM", "RESEND_WEBHOOK_SECRET", "DATABASE_URL", "POSTGRES_URL"]) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, ENV);
  mock.timers.enable({ apis: ["Date"], now: NOW }); // freeze the clock so candle windows are deterministic
  h = await makeHarness();
  setDb(h.t.db);
  hosts = new Set();
  const emailFn = h.deps().email!.fetchFn!;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    hosts.add(u.host);
    if (u.host === "api.bybit.com" || u.host === "api.bytick.com") return bybitFetch(h.ex, h.bybitOpts)(input, init);
    if (u.host === "api.resend.com") return emailFn(input, init);
    throw new Error(`unexpected outbound call to ${u.host}`);
  }) as typeof fetch;
});
after(async () => {
  globalThis.fetch = realFetch;
  mock.timers.reset();
  setDb(null);
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await h.cleanup();
});

describe("scheduler endpoint authentication", () => {
  it("is disabled (503) until CRON_SECRET is set and long enough", async () => {
    const saved = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    assert.equal((await cronGet(request("/api/cron/monitor", { bearer: "anything" }))).status, 503);
    process.env.CRON_SECRET = "short";
    assert.equal((await cronGet(request("/api/cron/monitor", { bearer: "short" }))).status, 503);
    process.env.CRON_SECRET = saved;
  });
  it("rejects missing, wrong and query-string credentials without doing any work", async () => {
    for (const r of [request("/api/cron/monitor"), request("/api/cron/monitor", { bearer: "wrong-secret-wrong-secret-0000" }), request(`/api/cron/monitor?secret=${ENV.CRON_SECRET}`), request("/api/cron/monitor", { cookie: true })]) {
      assert.equal((await cronGet(r)).status, 401);
    }
    assert.equal((await h.q("select 1 from job_runs")).length, 0, "no monitor run was started");
    assert.equal(h.calls.length, 0);
  });
});

describe("login & sessions", () => {
  it("rejects a wrong password, then accepts the right one with a hardened cookie", async () => {
    const ip = "198.51.100.7";
    assert.equal((await login(request("/api/auth/login", { method: "POST", body: { password: "nope" }, ip }))).status, 401);
    const ok = await login(request("/api/auth/login", { method: "POST", body: { password: ENV.ADMIN_PASSWORD }, ip }));
    assert.equal(ok.status, 200);
    const c = ok.headers.get("set-cookie") ?? "";
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Strict/);
    assert.match(c, /Secure/);
    assert.match(c, /Max-Age=\d+/);
    const token = decodeURIComponent(c.split(";")[0].split("=").slice(1).join("="));
    assert.equal((await stateGet(request("/api/state", { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` }))).status, 200);
  });
  it("throttles brute force (8 tries / 5 min per address) with Retry-After", async () => {
    const ip = "203.0.113.50";
    const codes: number[] = [];
    let last: Response | null = null;
    for (let i = 0; i < 10; i++) { last = await login(request("/api/auth/login", { method: "POST", body: { password: `guess-${i}` }, ip })); codes.push(last.status); }
    assert.deepEqual(codes.slice(0, 8), Array(8).fill(401));
    assert.deepEqual(codes.slice(8), [429, 429]);
    assert.ok(Number(last!.headers.get("retry-after")) > 0);
    // even the correct password is refused while throttled
    assert.equal((await login(request("/api/auth/login", { method: "POST", body: { password: ENV.ADMIN_PASSWORD }, ip }))).status, 429);
  });
  it("refuses cross-site login attempts and malformed bodies", async () => {
    assert.equal((await login(request("/api/auth/login", { method: "POST", body: { password: ENV.ADMIN_PASSWORD }, origin: "https://evil.example" }))).status, 403);
    assert.equal((await login(request("/api/auth/login", { method: "POST", raw: "{not json" }))).status, 401);
  });
  it("forged, tampered and expired session cookies are rejected", async () => {
    const good = signSession(process.env);
    const [payload, sig] = good.split(".");
    const forged = `${Buffer.from(JSON.stringify({ v: 1, exp: NOW + 1e9, jti: "x" })).toString("base64url")}.${sig}`;
    const expired = signSession(process.env, NOW - 30 * 24 * 3600_000);
    for (const c of [forged, `${payload}.AAAA`, expired, "garbage", ""]) {
      assert.equal((await stateGet(request("/api/state", { cookie: `${SESSION_COOKIE}=${encodeURIComponent(c)}` }))).status, 401, `cookie ${c.slice(0, 12)}…`);
    }
  });
  it("logout clears the cookie", async () => {
    const r = await logout(request("/api/auth/logout", { method: "POST", body: {} }));
    assert.match(r.headers.get("set-cookie") ?? "", /Max-Age=0/);
  });
  it("with no ADMIN_PASSWORD configured the app fails closed and lists only booleans", async () => {
    const saved = process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_PASSWORD;
    const r = await stateGet(request("/api/state", { cookie: `${SESSION_COOKIE}=whatever` }));
    assert.equal(r.status, 503);
    const b = await body(r);
    assert.equal(b.error, "setup_required");
    assert.equal(b.config.adminPassword, false);
    assert.equal((await login(request("/api/auth/login", { method: "POST", body: { password: "" } }))).status, 503);
    process.env.ADMIN_PASSWORD = saved;
  });
});

describe("every sensitive endpoint requires a signed-in admin (and same-origin for changes)", () => {
  const mutations: Array<[string, (r: Request) => Promise<Response>, string, unknown]> = [
    ["PUT /api/settings", settingsPut, "PUT", { positionAmountUsdt: 5 }],
    ["POST /api/assets", assetsPost, "POST", { base: "DOGE" }],
    ["PATCH /api/assets", assetsPatch, "PATCH", { symbol: "BTCUSDT", enabled: false }],
    ["DELETE /api/assets", assetsDelete, "DELETE", { symbol: "BTCUSDT" }],
    ["POST /api/email/test", emailTest, "POST", {}],
    ["POST /api/admin/run", adminRun, "POST", {}],
  ];
  const path = (name: string) => name.split(" ")[1];

  it("401 without a session — nothing is changed", async () => {
    for (const [name, fn, method, b] of mutations) assert.equal((await fn(request(path(name), { method, body: b }))).status, 401, name);
    assert.equal((await stateGet(request("/api/state"))).status, 401);
    assert.equal((await marketGet(request("/api/market?symbol=BTCUSDT"))).status, 401);
    assert.equal((await h.q("select 1 from assets")).length, 5);
    assert.equal(Number((await h.q<{ s: any }>("select (settings->>'positionAmountUsdt')::numeric as s from app_settings"))[0].s), 10);
  });
  it("403 for a signed-in browser request coming from another site (CSRF)", async () => {
    for (const [name, fn, method, b] of mutations) assert.equal((await fn(request(path(name), { method, body: b, cookie: true, origin: "https://evil.example" }))).status, 403, name);
    assert.equal(h.calls.length, 0, "no email was sent by a cross-site request");
  });
  it("responses are never cacheable and the public health probe leaks no configuration", async () => {
    const r = await healthGet();
    assert.equal(r.headers.get("cache-control"), "no-store");
    const text = JSON.stringify(await body(r));
    for (const secret of Object.values(ENV)) assert.ok(!text.includes(secret));
  });
});

describe("monitor endpoint end to end (real handler, mocked network)", () => {
  it("authorised call evaluates all five coins, opens ONE paper position each and queues + sends ONE email each", async () => {
    const r = await cronGet(request("/api/cron/monitor", { bearer: ENV.CRON_SECRET }));
    const b = await body(r);
    assert.equal(r.status, 200, JSON.stringify(b));
    assert.equal(b.status, "success");
    assert.equal((await h.q("select 1 from paper_positions where status = 'open'")).length, 5);
    assert.equal(h.calls.length, 5);
    assert.ok(!JSON.stringify(b).includes(ENV.CRON_SECRET));
  });
  it("a second call (POST works too) adds nothing: no duplicate entries, no duplicate emails", async () => {
    const r = await cronPost(request("/api/cron/monitor", { method: "POST", bearer: ENV.CRON_SECRET }));
    assert.equal(r.status, 200);
    assert.equal((await h.q("select 1 from paper_positions")).length, 5);
    assert.equal((await h.q("select 1 from paper_trades")).length, 5);
    assert.equal(h.calls.length, 5);
  });
  it("the dashboard state exposes everything the UI needs and none of the secrets", async () => {
    const r = await stateGet(request("/api/state", { cookie: true }));
    const text = await r.text();
    const s = JSON.parse(text);
    assert.equal(r.status, 200);
    assert.equal(s.assets.length, 5);
    assert.equal(s.positions.length, 5);
    assert.equal(s.trades.length, 5);
    assert.equal(s.evaluations.length, 5);
    assert.equal(s.monitor.state, "active");
    assert.equal(s.email.recipient, "olaleyevictor206@gmail.com");
    assert.equal(s.email.configured, true);
    assert.equal(s.config.cronSecret, true);
    assert.ok(s.notifications.every((n: any) => n.status === "accepted"));
    for (const secret of Object.values(ENV)) assert.ok(!text.includes(secret), "a secret leaked into /api/state");
    assert.ok(!/postgres(ql)?:\/\//.test(text));
  });
  it("manual 'Run check now' uses the same locked pass and is rate limited", async () => {
    const ip = "192.0.2.77";
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await adminRun(request("/api/admin/run", { method: "POST", body: {}, cookie: true, ip }))).status);
    assert.deepEqual(codes.slice(0, 6), Array(6).fill(200));
    assert.deepEqual(codes.slice(6), [429, 429]);
    assert.equal((await h.q("select 1 from paper_positions")).length, 5);
  });
  it("the public health probe reports the monitor honestly", async () => {
    const r = await healthGet();
    const b = await body(r);
    assert.equal(r.status, 200);
    assert.equal(b.database, "ok");
    assert.equal(b.monitor.state, "active");
  });
});

describe("settings API", () => {
  const put = (b: unknown, extra: object = {}) => settingsPut(request("/api/settings", { method: "PUT", body: b, cookie: true, ...extra }));
  it("saves valid changes (partial updates allowed) and the monitor uses them", async () => {
    const r = await put({ positionAmountUsdt: 12.5, takeProfitPct: 5, buyEmailEnabled: false });
    assert.equal(r.status, 200);
    const s = await loadSettings(h.t.db);
    assert.equal(s.positionAmountUsdt, 12.5);
    assert.equal(s.takeProfitPct, 5);
    assert.equal(s.buyEmailEnabled, false);
    assert.equal(s.stopLossPct, 2, "untouched values are preserved");
    await put({ positionAmountUsdt: 10, takeProfitPct: 4, buyEmailEnabled: true });
  });
  it("rejects invalid input with specific errors and stores nothing", async () => {
    for (const bad of [{ stopLossPct: -1 }, { positionAmountUsdt: "10" }, { emaFast: 60, emaSlow: 50 }, { emailRecipient: "not-an-email" }, { sellEmailEnabled: "yes" }, { rsiMin: 70, rsiMax: 60 }, { hackerField: 1 }, [1, 2], "str"]) {
      const r = await put(bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal((await put({}, {})).status, 200, "an empty update is a harmless no-op");
    const r = await settingsPut(request("/api/settings", { method: "PUT", raw: "{oops", cookie: true }));
    assert.equal(r.status, 400);
    const s = await loadSettings(h.t.db);
    assert.equal(s.stopLossPct, 2);
    assert.equal(s.emailRecipient, "olaleyevictor206@gmail.com");
  });
});

describe("coin management API (add / pause / remove from the website)", () => {
  const post = (b: unknown) => assetsPost(request("/api/assets", { method: "POST", body: b, cookie: true }));
  const patch = (b: unknown) => assetsPatch(request("/api/assets", { method: "PATCH", body: b, cookie: true }));
  const del = (b: unknown) => assetsDelete(request("/api/assets", { method: "DELETE", body: b, cookie: true }));
  const symbols = async () => (await h.q<{ symbol: string }>("select symbol from assets order by symbol")).map((r) => r.symbol);

  it("adds a coin only after Bybit confirms it is a trading USDT spot pair, and starts monitoring it", async () => {
    const h1 = scaled(signalMarket(NOW).h1, 0.00002), h4 = scaled(signalMarket(NOW).h4, 0.00002);
    h.ex.symbols.DOGEUSDT = { h1, h4, lastPrice: h1[h1.length - 1].close };
    const r = await post({ base: "doge" });
    assert.equal(r.status, 201);
    assert.ok((await symbols()).includes("DOGEUSDT"));
    assert.equal((await post({ base: "DOGE/USDT" })).status, 409, "already in the list");
    await cronGet(request("/api/cron/monitor", { bearer: ENV.CRON_SECRET }));
    assert.equal((await h.q("select 1 from signal_evaluations where symbol = 'DOGEUSDT'")).length, 1, "next run evaluates it with no code change");
  });
  it("refuses unknown, non-trading and malformed tickers", async () => {
    assert.equal((await post({ base: "FOOBAR" })).status, 404);
    h.ex.listed = { ...Object.fromEntries(Object.keys(h.ex.symbols).map((k) => [k, { status: "Trading" }])), HALTUSDT: { status: "Closed" } };
    assert.equal((await post({ base: "HALT" })).status, 409);
    h.ex.listed = undefined;
    for (const bad of [{ base: "" }, { base: "DO GE" }, { base: "A" }, { base: "X'; DROP TABLE assets;--" }, { base: 5 }, {}, "x"]) assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
    assert.ok(!(await symbols()).some((s) => /FOOBAR|HALT|DROP/.test(s)));
    assert.equal((await h.q("select 1 from assets")).length, 6);
  });
  it("adds nothing when Bybit cannot be reached (never guesses)", async () => {
    h.bybitOpts.httpStatus = 500;
    const r = await post({ base: "ADA" });
    h.bybitOpts.httpStatus = undefined;
    assert.equal(r.status, 502);
    assert.ok(!(await symbols()).includes("ADAUSDT"));
  });
  it("enforces the maximum number of coins", async () => {
    let i = 0;
    while ((await symbols()).length < MAX_ASSETS) await addAsset(h.t.db, `FILL${i}USDT`, `FILL${i++}`);
    h.ex.symbols.EXTRAUSDT = h.ex.symbols.BTCUSDT;
    assert.equal((await post({ base: "EXTRA" })).status, 400);
    await h.q("delete from assets where symbol like 'FILL%'");
  });
  it("pauses and resumes a coin", async () => {
    assert.equal((await patch({ symbol: "SOLUSDT", enabled: false })).status, 200);
    assert.equal((await h.q<{ enabled: boolean }>("select enabled from assets where symbol='SOLUSDT'"))[0].enabled, false);
    assert.equal((await patch({ symbol: "SOLUSDT", enabled: true })).status, 200);
    assert.equal((await patch({ symbol: "NOPEUSDT", enabled: true })).status, 404);
    assert.equal((await patch({ symbol: "SOLUSDT", enabled: "x" })).status, 400);
  });
  it("will not remove a coin while its simulated position is open, but will afterwards (history kept)", async () => {
    const r = await del({ symbol: "BTCUSDT" });
    assert.equal(r.status, 409);
    assert.match((await body(r)).message, /open simulated position/);
    h.ex.symbols.BTCUSDT.lastPrice *= 1.05; // take-profit (4%) reached
    h.ex.now += 60_000;
    await cronGet(request("/api/cron/monitor", { bearer: ENV.CRON_SECRET }));
    assert.equal((await h.q("select 1 from paper_positions where symbol='BTCUSDT' and status='closed'")).length, 1);
    assert.equal((await del({ symbol: "BTCUSDT" })).status, 200);
    assert.ok(!(await symbols()).includes("BTCUSDT"));
    assert.equal((await h.q("select 1 from paper_trades where symbol='BTCUSDT'")).length, 2, "BUY and SELL history is kept");
    assert.equal((await del({ symbol: "BTCUSDT" })).status, 404);
    assert.equal((await del({ symbol: "btc; drop" })).status, 400);
  });
});

describe("test-email endpoint", () => {
  it("sends a test to the configured recipient and reports 'accepted'", async () => {
    const before = h.calls.length;
    const r = await emailTest(request("/api/email/test", { method: "POST", body: {}, cookie: true, ip: "192.0.2.201" }));
    const b = await body(r);
    assert.equal(r.status, 200);
    assert.equal(b.status, "accepted");
    assert.equal(h.calls.length, before + 1);
    assert.deepEqual(h.calls[h.calls.length - 1].body.to, ["olaleyevictor206@gmail.com"]);
  });
  it("reports a provider failure honestly (HTTP 502 + reason) and rate-limits repeated tests", async () => {
    h.emailReplies[0] = () => ({ status: 403, body: { message: "You can only send testing emails to your own email address" } });
    const ip = "192.0.2.202";
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await emailTest(request("/api/email/test", { method: "POST", body: {}, cookie: true, ip }))).status);
    h.emailReplies.length = 0;
    assert.deepEqual(codes, [502, 502, 502, 429, 429]);
  });
});

describe("live market endpoint", () => {
  const get = (symbol: string) => marketGet(request(`/api/market?symbol=${symbol}`, { cookie: true }));
  it("serves validated live data for a monitored coin only (not an open proxy)", async () => {
    const r = await get("ETHUSDT");
    const b = await body(r);
    assert.equal(r.status, 200);
    assert.equal(b.ok, true);
    assert.equal(b.source, "live");
    assert.ok(b.h1.candles.length > 100 && b.h4.candles.length > 100);
    assert.ok(b.h1.emaFast.length > 0);
    assert.equal(b.h1.stale, false);
    assert.equal((await get("BTCUSDT")).status, 404, "BTC was removed in an earlier test");
    assert.equal((await get("ZZZUSDT")).status, 404, "well-formed but not in the user's list");
    assert.equal((await get("NOTAMONITOREDCOINUSDT")).status, 400, "over-long symbols are rejected as malformed");
    assert.equal((await get("bad symbol!")).status, 400);
  });
  it("on an exchange outage it returns an error and NO invented prices", async () => {
    h.bybitOpts.httpStatus = 503;
    const r = await get("SOLUSDT");
    h.bybitOpts.httpStatus = undefined;
    const b = await body(r);
    assert.equal(r.status, 502);
    assert.equal(b.ok, false);
    assert.equal(b.ticker, undefined);
    assert.equal(b.h1, undefined);
  });
});

describe("network surface", () => {
  it("the app only ever talked to Bybit's public API (api.bybit.com, plus its official alternate api.bytick.com used on retries) and the email provider", () => {
    const allowed = new Set(["api.bybit.com", "api.bytick.com", "api.resend.com"]);
    for (const host of hosts) assert.ok(allowed.has(host), `unexpected host contacted: ${host}`);
    assert.ok(hosts.has("api.bybit.com") && hosts.has("api.resend.com"));
  });
});
