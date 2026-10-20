import tls from "node:tls";
import { randomUUID } from "node:crypto";

/**
 * Minimal built-in SMTP client (implicit TLS, e.g. smtp.gmail.com:465). No third-party email service and no
 * dependency. Credentials come from server-side env vars only. Certificates are always verified.
 * Supports AUTH PLAIN / LOGIN and sends a multipart/alternative (text + HTML) message.
 */

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

export interface SmtpMessage {
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type SmtpResult = { ok: true; messageId: string; response: string } | { ok: false; retryable: boolean; error: string };

export interface SmtpOptions {
  timeoutMs?: number;
  /** Extra TLS options (tests only: custom CA for a local fake server). Verification stays on. */
  tlsOptions?: tls.ConnectionOptions;
  now?: () => number;
}

const clean = (s: string) => s.replace(/[\r\n\0]+/g, " ").trim();
const ADDR_RE = /^[^\s<>@"]+@[^\s<>@"]+$/;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const b64Lines = (s: string) => (b64(s).match(/.{1,76}/g) ?? [""]).join("\r\n");
const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

export function buildMime(m: SmtpMessage, messageId: string, date: Date): string {
  const boundary = `cs_${randomUUID().replace(/-/g, "")}`;
  const fromName = clean(m.fromName).replace(/"/g, "");
  const domain = m.fromEmail.split("@")[1] ?? "localhost";
  const headers = [
    `From: ${fromName ? `${encodeHeader(fromName)} ` : ""}<${m.fromEmail}>`,
    `To: <${m.to}>`,
    `Subject: ${encodeHeader(clean(m.subject))}`,
    `Date: ${date.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${messageId}@${domain}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type: string, body: string) =>
    [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, "Content-Transfer-Encoding: base64", "", b64Lines(body)].join("\r\n");
  return [...headers, "", part("text/plain", m.text), part("text/html", m.html), `--${boundary}--`, ""].join("\r\n");
}

function dotStuff(data: string): string {
  return data.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
}

class SmtpError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

export async function sendSmtp(cfg: SmtpConfig, msg: SmtpMessage, opts: SmtpOptions = {}): Promise<SmtpResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const from = clean(msg.fromEmail);
  const to = clean(msg.to);
  if (!ADDR_RE.test(from) || !ADDR_RE.test(to)) return { ok: false, retryable: false, error: "smtp: invalid sender or recipient address." };
  const messageId = randomUUID();
  const mime = buildMime({ ...msg, fromEmail: from, to }, messageId, new Date(opts.now?.() ?? Date.now()));

  return new Promise<SmtpResult>((resolve) => {
    let settled = false;
    let buf = "";
    let waiter: ((r: { code: number; text: string }) => void) | null = null;
    const queue: Array<{ code: number; text: string }> = [];
    let lines: string[] = [];

    const socket = tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host, minVersion: "TLSv1.2", ...opts.tlsOptions });
    const finish = (r: SmtpResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, retryable: true, error: "smtp: timed out talking to the mail server." }), timeoutMs);

    const push = (reply: { code: number; text: string }) => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(reply);
      } else queue.push(reply);
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        lines.push(line);
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
          push({ code: Number(line.slice(0, 3)), text: lines.map((l) => l.slice(4)).join(" | ") });
          lines = [];
        }
      }
    });
    socket.on("error", (e: NodeJS.ErrnoException) => {
      const code = e.code ?? "";
      const certProblem = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME/i.test(code);
      finish({
        ok: false,
        retryable: !certProblem,
        error: certProblem ? `smtp: TLS certificate check failed (${code}).` : `smtp: connection error${code ? ` (${code})` : ""}.`,
      });
    });
    socket.on("close", () => finish({ ok: false, retryable: true, error: "smtp: connection closed unexpectedly." }));

    const next = () => new Promise<{ code: number; text: string }>((res) => (queue.length ? res(queue.shift()!) : (waiter = res)));
    const expect = async (ok: number[], what: string) => {
      const r = await next();
      if (!ok.includes(r.code)) {
        const retryable = r.code >= 400 && r.code < 500;
        let hint = "";
        if (r.code === 535 || r.code === 534) hint = " Hint: the username or app password was rejected. For Gmail use a 16-character App Password (needs 2-Step Verification), not your normal password.";
        throw new SmtpError(`smtp ${what}: ${r.code} ${r.text.slice(0, 160)}${hint}`, retryable);
      }
      return r;
    };
    const write = (s: string) => socket.write(s + "\r\n");

    (async () => {
      await new Promise<void>((res) => socket.once("secureConnect", () => res()));
      await expect([220], "greeting");
      write("EHLO crypto-sentinel.local");
      const ehlo = await expect([250], "EHLO");
      if (/AUTH[ =].*PLAIN/i.test(ehlo.text) || !/AUTH/i.test(ehlo.text)) {
        write(`AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.pass}`)}`);
        await expect([235], "AUTH");
      } else {
        write("AUTH LOGIN");
        await expect([334], "AUTH");
        write(b64(cfg.user));
        await expect([334], "AUTH");
        write(b64(cfg.pass));
        await expect([235], "AUTH");
      }
      write(`MAIL FROM:<${from}>`);
      await expect([250], "MAIL FROM");
      write(`RCPT TO:<${to}>`);
      await expect([250, 251], "RCPT TO");
      write("DATA");
      await expect([354], "DATA");
      socket.write(dotStuff(mime) + ".\r\n");
      const done = await expect([250], "message");
      write("QUIT");
      finish({ ok: true, messageId, response: done.text.slice(0, 160) });
    })().catch((e) => {
      if (e instanceof SmtpError) finish({ ok: false, retryable: e.retryable, error: e.message });
      else finish({ ok: false, retryable: true, error: "smtp: unexpected error." });
    });
  });
}
