import type { Queryable, Row } from "./db";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

/**
 * Fixed-window rate limiter backed by Postgres, so limits hold across serverless instances.
 * Callers should FAIL CLOSED (deny) if this throws for sensitive endpoints.
 */
export async function rateLimit(
  q: Queryable,
  bucket: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const r = await q.query<Row>(
    `insert into rate_limits (bucket, window_start, hits) values ($1, $2::timestamptz, 1)
     on conflict (bucket, window_start) do update set hits = rate_limits.hits + 1
     returning hits`,
    [bucket, new Date(windowStart).toISOString()],
  );
  const hits = Number(r.rows[0].hits);
  const retryAfterSec = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
  return { allowed: hits <= limit, remaining: Math.max(0, limit - hits), retryAfterSec };
}

export async function pruneRateLimits(q: Queryable, now: number = Date.now()): Promise<void> {
  await q.query("delete from rate_limits where window_start < $1::timestamptz", [new Date(now - 24 * 3600_000).toISOString()]);
}
