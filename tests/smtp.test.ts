import assert from "node:assert/strict";
import tls from "node:tls";
import { afterEach, describe, it } from "node:test";
import { emailConfig, sendViaProvider, buildTestEmail } from "@/lib/email";
import { sendSmtp } from "@/lib/smtp";
import { TEST_CERT, TEST_KEY } from "./helpers/smtp-cert";

interface Fake { port: number; received: { from?: string; to?: string; data?: string; auth?: string }; close: () => void }
const open: Fake[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

/** Fake TLS SMTP server. `rejectAuth` → 535, `rcpt` → custom RCPT reply, `silent` → never greets. */
async function fakeServer(o: { rejectAuth?: boolean; rcpt?: string; silent?: boolean; ehlo?: string } = {}): Promise<Fake> {
  const received: Fake["received"] = {};
  const sockets = new Set<tls.TLSSocket>();
  const server = tls.createServer({ key: TEST_KEY, cert: TEST_CERT }, (s) => {
    sockets.add(s);
    s.on("error", () => undefined);
    s.setEncoding("utf8");
    if (o.silent) return;
    let inData = false;
    let data = "";
    let buf = "";
    let loginStep = 0;
    s.write("220 fake ESMTP\r\n");
    s.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") { inData = false; received.data = data; s.write("250 2.0.0 OK queued as FAKE123\r\n"); }
          else data += (line.startsWith("..") ? line.slice(1) : line) + "\r\n";
          continue;
        }
        if (loginStep > 0) {
          loginStep++;
          if (loginStep === 3) { s.write(o.rejectAuth ? "535 5.7.8 Username and Password not accepted\r\n" : "235 2.7.0 Accepted\r\n"); loginStep = 0; }
          else s.write("334 UGFzc3dvcmQ6\r\n");
          continue;
        }
        if (line.startsWith("EHLO")) s.write(`250-fake\r\n250-SIZE 100\r\n250 ${o.ehlo ?? "AUTH LOGIN PLAIN"}\r\n`);
        else if (line.startsWith("AUTH PLAIN")) { received.auth = Buffer.from(line.slice(11), "base64").toString(); s.write(o.rejectAuth ? "535 5.7.8 Username and Password not accepted\r\n" : "235 2.7.0 Accepted\r\n"); }
        else if (line === "AUTH LOGIN") { loginStep = 1; s.write("334 VXNlcm5hbWU6\r\n"); }
        else if (line.startsWith("MAIL FROM:")) { received.from = line.slice(10); s.write("250 OK\r\n"); }
        else if (line.startsWith("RCPT TO:")) { received.to = line.slice(8); s.write(`${o.rcpt ?? "250 OK"}\r\n`); }
        else if (line === "DATA") { inData = true; s.write("354 go\r\n"); }
        else if (line === "QUIT") s.end("221 bye\r\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const f: Fake = { port: (server.address() as { port: number }).port, received, close: () => { for (const s of sockets) s.destroy(); server.close(); } };
  open.push(f);
  return f;
}

const tlsOptions = { ca: TEST_CERT, host: "127.0.0.1", servername: "localhost" };
const cfg = (f: Fake) => ({ host: "127.0.0.1", port: f.port, user: "olaleyevictor206@gmail.com", pass: "abcd efgh ijkl mnop" });
const msg = { fromName: "Crypto Sentinel", fromEmail: "olaleyevictor206@gmail.com", to: "olaleyevictor206@gmail.com", subject: "[Crypto Sentinel] BUY · ETH/USDT — ◆", text: "line1\r\n.dotline\r\nCafé ✓", html: "<p>hi</p>" };

describe("built-in SMTP sender", () => {
  it("authenticates, sends a correct MIME message over TLS and reports acceptance", async () => {
    const f = await fakeServer();
    const r = await sendSmtp(cfg(f), msg, { tlsOptions });
    assert.equal(r.ok, true);
    assert.equal(f.received.auth, "\0olaleyevictor206@gmail.com\0abcd efgh ijkl mnop");
    assert.equal(f.received.from, "<olaleyevictor206@gmail.com>");
    assert.equal(f.received.to, "<olaleyevictor206@gmail.com>");
    const d = f.received.data!;
    assert.match(d, /^From: Crypto Sentinel <olaleyevictor206@gmail\.com>/m);
    assert.match(d, /^Subject: =\?UTF-8\?B\?/m);
    assert.match(d, /^Content-Type: multipart\/alternative; boundary=/m);
    const textB64 = d.split("Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n")[1].split("\r\n--")[0].replace(/\r\n/g, "");
    assert.equal(Buffer.from(textB64, "base64").toString("utf8"), msg.text);
    assert.ok(d.includes("text/html"));
  });

  it("falls back to AUTH LOGIN when the server does not offer PLAIN", async () => {
    const f = await fakeServer({ ehlo: "AUTH LOGIN" });
    const r = await sendSmtp(cfg(f), msg, { tlsOptions });
    assert.equal(r.ok, true);
  });

  it("wrong app password → permanent failure with a helpful hint and no secret in the error", async () => {
    const f = await fakeServer({ rejectAuth: true });
    const r = await sendSmtp(cfg(f), msg, { tlsOptions });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.retryable, false);
      assert.match(r.error, /App Password/);
      assert.ok(!r.error.includes("abcd efgh"));
    }
  });

  it("4xx from the server is retryable, 5xx is not", async () => {
    const a = await sendSmtp(cfg(await fakeServer({ rcpt: "451 try later" })), msg, { tlsOptions });
    assert.equal(a.ok, false);
    if (!a.ok) assert.equal(a.retryable, true);
    const b = await sendSmtp(cfg(await fakeServer({ rcpt: "550 no such user" })), msg, { tlsOptions });
    assert.equal(b.ok, false);
    if (!b.ok) assert.equal(b.retryable, false);
  });

  it("times out when the server never greets", async () => {
    const f = await fakeServer({ silent: true });
    const r = await sendSmtp(cfg(f), msg, { tlsOptions, timeoutMs: 300 });
    assert.equal(r.ok, false);
    if (!r.ok) { assert.equal(r.retryable, true); assert.match(r.error, /timed out/); }
  });

  it("refuses an untrusted certificate (verification is never disabled)", async () => {
    const f = await fakeServer();
    const r = await sendSmtp(cfg(f), msg, { tlsOptions: { host: "127.0.0.1", servername: "localhost" } });
    assert.equal(r.ok, false);
    if (!r.ok) { assert.equal(r.retryable, false); assert.match(r.error, /certificate/i); }
  });

  it("rejects header-injection attempts in addresses", async () => {
    const f = await fakeServer();
    const r = await sendSmtp(cfg(f), { ...msg, to: "a@b.com\r\nBcc: x@y.com" }, { tlsOptions });
    assert.equal(r.ok, false);
    assert.equal(f.received.to, undefined);
  });
});

describe("SMTP as an email provider", () => {
  it("is configured from SMTP_USER + SMTP_PASS, defaults the sender to the user, and takes priority over Resend", () => {
    const c = emailConfig({ SMTP_USER: "me@gmail.com", SMTP_PASS: "x", RESEND_API_KEY: "re_1" });
    assert.equal(c.provider, "smtp");
    assert.equal(c.configured, true);
    assert.match(c.from, /<me@gmail\.com>/);
  });
  it("half-configured SMTP is reported as not configured", () => {
    const c = emailConfig({ SMTP_USER: "me@gmail.com" });
    assert.equal(c.configured, false);
    assert.match(c.issue ?? "", /SMTP_PASS/);
  });
  it("sendViaProvider uses SMTP end to end (no fetch call is made)", async () => {
    const f = await fakeServer();
    const env = { SMTP_USER: "olaleyevictor206@gmail.com", SMTP_PASS: "pw", SMTP_HOST: "127.0.0.1", SMTP_PORT: String(f.port) };
    let fetched = 0;
    const r = await sendViaProvider(emailConfig(env), buildTestEmail(Date.now()), "olaleyevictor206@gmail.com", "k", { env, smtp: { tlsOptions }, fetchFn: (async () => { fetched++; return new Response("{}"); }) as typeof fetch });
    assert.equal(r.ok, true);
    assert.equal(fetched, 0);
    assert.match(f.received.data ?? "", /Test email|=\?UTF-8\?B\?/);
  });
});
