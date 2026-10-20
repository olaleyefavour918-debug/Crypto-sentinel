import type { MarketView } from "@/lib/marketview";
import type { ConfigStatus, MonitorAssessment } from "@/lib/health";
import type { Account, Asset, EvaluationRow, JobRunRow, NotificationRow, Position, TradeEvent, TradeStats } from "@/lib/store";
import type { Settings } from "@/lib/types";

export interface AppState {
  now: number;
  config: ConfigStatus;
  settings: Settings;
  account: Account;
  assets: Asset[];
  positions: Position[];
  stats: TradeStats;
  trades: TradeEvent[];
  notifications: NotificationRow[];
  evaluations: EvaluationRow[];
  lastSignals: Array<{ symbol: string; evaluatedAt: number; h1CandleStart: number | null; summary: string }>;
  marketApi: { lastAttemptAt?: number; lastSuccessAt?: number | null; lastError?: string | null } | null;
  jobRuns: JobRunRow[];
  monitor: MonitorAssessment;
  email: { provider: string | null; configured: boolean; issue: string | null; deliveryConfirmation: boolean; recipient: string };
  database: string;
}

export type { MarketView };

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T;
}

/** Small fetch wrapper: always JSON, never throws, same-origin cookies, 15 s timeout. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method: init.method ?? "GET",
      headers: init.body === undefined ? undefined : { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data: data as T };
  } catch {
    return { ok: false, status: 0, data: { error: "network", message: "Could not reach the server." } as unknown as T };
  }
}

export function errorMessage(data: unknown, fallback = "Something went wrong."): string {
  const d = data as { message?: string; errors?: string[] } | null;
  if (d?.errors?.length) return d.errors.join(" ");
  return d?.message ?? fallback;
}
