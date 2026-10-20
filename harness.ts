import { runMonitor, type MonitorDeps } from "@/lib/monitor";
import type { Row } from "@/lib/db";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { saveSettings } from "@/lib/store";
import type { Settings } from "@/lib/types";
import { NOW, RESEND_ENV, bybitFetch, defaultExchange, downMarket, emailFetch, scaled, signalMarket, type BybitMockOptions, type EmailCall, type MockExchange } from "./fixtures";
import { makeTestDb, type TestDb } from "./db";

export const PRICE_LEVEL: Record<string, number> = { BTCUSDT: 1, ETHUSDT: 0.05, SOLUSDT: 0.0028, XRPUSDT: 0.00001, BNBUSDT: 0.0105 };

export interface Harness {
  t: TestDb;
  ex: MockExchange;
  calls: EmailCall[];
  bybitOpts: BybitMockOptions;
  emailReplies: Array<(call: EmailCall, n: number) => { status: number; body: unknown }>;
  run(trigger?: "cron" | "manual", advanceMs?: number): ReturnType<typeof runMonitor>;
  deps(): MonitorDeps;
  q<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  setMarket(now: number, kind: "signal" | "down", keepPrices?: boolean): void;
  setSettings(patch: Partial<Settings>): Promise<void>;
  cleanup(): Promise<void>;
}

let counter = 0;

export async function makeHarness(opts: { email?: Record<string, string | undefined> } = {}): Promise<Harness> {
  const t = await makeTestDb();
  const ex = defaultExchange(NOW);
  const calls: EmailCall[] = [];
  const bybitOpts: BybitMockOptions = {};
  const defaultReply = () => ({ status: 200, body: { id: `msg_${++counter}` } });
  const emailReplies: Harness["emailReplies"] = [];
  const emailFn = emailFetch([(call, n) => (emailReplies[0] ?? defaultReply)(call, n)], calls);
  const env = opts.email ?? RESEND_ENV;

  const deps = (): MonitorDeps => ({
    db: t.db,
    now: () => ex.now,
    bybit: { fetchFn: bybitFetch(ex, bybitOpts), sleep: async () => undefined, random: () => 0 },
    email: { env, fetchFn: emailFn, now: () => ex.now },
  });

  return {
    t, ex, calls, bybitOpts, emailReplies,
    deps,
    run: (trigger = "cron", advanceMs = 0) => {
      ex.now += advanceMs;
      return runMonitor({ ...deps(), trigger });
    },
    q: async <T = Row>(sql: string, params?: unknown[]) => (await t.db.query<T>(sql, params)).rows,
    setMarket(now, kind, keepPrices = true) {
      const base = kind === "signal" ? signalMarket(now) : downMarket(now);
      ex.now = now;
      for (const [sym, k] of Object.entries(PRICE_LEVEL)) {
        if (!ex.symbols[sym]) continue;
        const h1 = scaled(base.h1, k);
        ex.symbols[sym].h1 = h1;
        ex.symbols[sym].h4 = scaled(base.h4, k);
        if (!keepPrices) ex.symbols[sym].lastPrice = h1[h1.length - 1].close;
      }
    },
    async setSettings(patch) {
      await saveSettings(t.db, { ...DEFAULT_SETTINGS, ...patch });
    },
    cleanup: () => t.cleanup(),
  };
}
