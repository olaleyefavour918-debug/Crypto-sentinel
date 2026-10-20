/** Structured JSON logging with secret redaction. One line per event; safe to ship to any log drain. */
const SENSITIVE_KEY = /(key|secret|password|token|authorization|cookie|database_url|connection)/i;
const LONG_TOKEN = /\b(re_[A-Za-z0-9_]{16,}|xkeysib-[A-Za-z0-9-]{16,}|whsec_[A-Za-z0-9+/=]{8,}|postgres(?:ql)?:\/\/[^\s"']+|[A-Fa-f0-9]{40,})\b/g;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return value.replace(LONG_TOKEN, "[redacted]").slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

type Level = "debug" | "info" | "warn" | "error";

export type LogSink = (line: string) => void;
let sink: LogSink = (line) => console.log(line);
export function setLogSink(s: LogSink | null) {
  sink = s ?? ((line) => console.log(line));
}

export function log(level: Level, event: string, fields: Record<string, unknown> = {}) {
  sink(JSON.stringify({ ts: new Date().toISOString(), level, app: "btc-sentinel", event, ...(redact(fields) as object) }));
}
export const logger = {
  debug: (e: string, f?: Record<string, unknown>) => log("debug", e, f),
  info: (e: string, f?: Record<string, unknown>) => log("info", e, f),
  warn: (e: string, f?: Record<string, unknown>) => log("warn", e, f),
  error: (e: string, f?: Record<string, unknown>) => log("error", e, f),
};
