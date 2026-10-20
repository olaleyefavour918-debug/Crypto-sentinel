/**
 * Minimal Postgres access layer. Production uses `pg` against DATABASE_URL (e.g. Neon via the Vercel
 * Marketplace). Tests can inject any object implementing `Db` (the test-suite uses PGlite or a local Postgres).
 * All SQL in this project is parameterised ($1, $2, …) — values are never concatenated into SQL text.
 */

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export interface Queryable {
  query<T = Row>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Runs one or more statements without parameters (used for migrations). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class DbNotConfiguredError extends Error {
  constructor() {
    super("No database is configured. Set DATABASE_URL (see README → Database).");
    this.name = "DbNotConfiguredError";
  }
}

export function connectionString(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.DATABASE_URL || env.POSTGRES_URL || env.POSTGRES_PRISMA_URL || env.POSTGRES_URL_NON_POOLING || null;
}

export function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string })?.code === "23505";
}

// ── pg adapter ───────────────────────────────────────────────────────────────
interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
  release(err?: unknown): void;
}
interface PgPoolLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

class PgDb implements Db {
  private poolPromise: Promise<PgPoolLike> | null = null;
  constructor(private url: string) {}

  private pool(): Promise<PgPoolLike> {
    if (!this.poolPromise) {
      this.poolPromise = (async () => {
        const mod = (await import("pg")) as unknown as { default?: { Pool: new (o: object) => PgPoolLike }; Pool?: new (o: object) => PgPoolLike };
        const Pool = (mod.default?.Pool ?? mod.Pool) as new (o: object) => PgPoolLike;
        return new Pool({
          connectionString: this.url,
          max: 3,
          idleTimeoutMillis: 10_000,
          connectionTimeoutMillis: 8_000,
          statement_timeout: 20_000,
        });
      })();
    }
    return this.poolPromise;
  }

  async query<T = Row>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const pool = await this.pool();
    const r = await pool.query(sql, params);
    return { rows: r.rows as T[], rowCount: r.rowCount ?? r.rows.length };
  }

  async exec(sql: string): Promise<void> {
    const pool = await this.pool();
    await pool.query(sql);
  }

  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const pool = await this.pool();
    const client = await pool.connect();
    const q: Queryable = {
      query: async <R = Row>(sql: string, params: unknown[] = []) => {
        const r = await client.query(sql, params);
        return { rows: r.rows as R[], rowCount: r.rowCount ?? r.rows.length };
      },
      exec: async (sql: string) => {
        await client.query(sql);
      },
    };
    try {
      await client.query("BEGIN");
      const out = await fn(q);
      await client.query("COMMIT");
      client.release();
      return out;
    } catch (e) {
      try {
        await client.query("ROLLBACK");
        client.release();
      } catch (rollbackErr) {
        client.release(rollbackErr);
      }
      throw e;
    }
  }

  async close(): Promise<void> {
    if (this.poolPromise) {
      const p = await this.poolPromise;
      this.poolPromise = null;
      await p.end();
    }
  }
}

let singleton: Db | null = null;

/** Returns the shared database handle, or throws DbNotConfiguredError when no connection string exists. */
export function getDb(): Db {
  if (singleton) return singleton;
  const url = connectionString();
  if (!url) throw new DbNotConfiguredError();
  singleton = new PgDb(url);
  return singleton;
}

/** Test hook: inject a database (or null to reset). */
export function setDb(db: Db | null) {
  singleton = db;
}

export function isDbConfigured(): boolean {
  return singleton !== null || connectionString() !== null;
}
