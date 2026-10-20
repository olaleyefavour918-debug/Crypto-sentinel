import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Db, Queryable, QueryResult, Row } from "@/lib/db";
import { ensureSetup } from "@/lib/migrations";

/**
 * Test database factory.
 *  • TEST_PSQL_URL set → real PostgreSQL through persistent `psql` sessions (several parallel connections, so
 *    transactions, row locks, unique constraints and the job lease behave exactly as in production).
 *  • otherwise → PGlite (real Postgres compiled to WASM; `npm i` installs it as a devDependency).
 * Every test file gets its own schema, so files can run in parallel.
 */
export interface TestDb {
  db: Db;
  /** A brand-new connection pool/session set on the same data (simulates a function restart). PGlite returns the same instance. */
  reopen(): Promise<Db>;
  kind: "psql" | "pglite";
  cleanup(): Promise<void>;
}

// ── psql adapter ─────────────────────────────────────────────────────────────
function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number parameter");
    return String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function interpolate(sql: string, params: unknown[]): string {
  return sql.replace(/\$(\d+)/g, (_, d) => {
    const i = Number(d) - 1;
    if (i >= params.length) throw new Error(`missing parameter $${d}`);
    return literal(params[i]);
  });
}

class PsqlSession {
  private proc: ChildProcessWithoutNullStreams;
  private out = "";
  private err = "";
  private waiter: (() => void) | null = null;
  private seq = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(url: string, schema: string) {
    this.proc = spawn("psql", ["-X", "-q", "-A", "-t", "-P", "pager=off", "-v", "ON_ERROR_STOP=0", url], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.on("data", (d) => { this.out += d.toString(); this.waiter?.(); });
    this.proc.stderr.on("data", (d) => { this.err += d.toString(); this.waiter?.(); });
    void this.raw(`set search_path to "${schema}", public; set timezone to 'UTC'`);
  }

  raw(sql: string): Promise<{ stdout: string; stderr: string }> {
    const run = async () => {
      const id = `@@END${++this.seq}_${randomBytes(4).toString("hex")}@@`;
      this.out = "";
      this.err = "";
      const done = new Promise<void>((resolve) => {
        this.waiter = () => { if (this.out.includes(id) && this.err.includes(id)) resolve(); };
      });
      this.proc.stdin.write(`${sql.trim().replace(/;?$/, ";")}\n\\echo ${id}\n\\warn ${id}\n`);
      await done;
      this.waiter = null;
      return { stdout: this.out.split(id)[0].trim(), stderr: this.err.split(id)[0].trim() };
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  async query<T = Row>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const text = interpolate(sql, params).trim().replace(/;+\s*$/, "");
    const control = /^(begin|commit|rollback|set|create|drop|alter|select pg_advisory)/i.test(text);
    const returnsRows = /^(select|with)\b/i.test(text) || /\breturning\b/i.test(text);
    const wrapped = !control && returnsRows ? `with __q as (${text}) select coalesce(json_agg(row_to_json(__q)), '[]'::json) from __q` : text;
    const { stdout, stderr } = await this.raw(wrapped);
    if (/ERROR:/.test(stderr)) {
      const e = new Error(stderr.split("\n").find((l) => l.includes("ERROR:"))?.replace(/^.*ERROR:\s*/, "") ?? "psql error") as Error & { code?: string };
      if (/duplicate key value violates unique constraint/.test(stderr)) e.code = "23505";
      else if (/violates check constraint/.test(stderr)) e.code = "23514";
      else if (/violates foreign key/.test(stderr)) e.code = "23503";
      throw e;
    }
    if (!wrapped.startsWith("with __q")) return { rows: [], rowCount: 0 };
    const rows = JSON.parse(stdout || "[]") as T[];
    return { rows, rowCount: rows.length };
  }

  async exec(sql: string): Promise<void> {
    const { stderr } = await this.raw(sql);
    if (/ERROR:/.test(stderr)) throw new Error(stderr);
  }

  close() {
    this.proc.stdin.end("\\q\n");
  }
}

class PsqlDb implements Db {
  private free: PsqlSession[] = [];
  private all: PsqlSession[] = [];
  private waiters: Array<(s: PsqlSession) => void> = [];
  constructor(private url: string, private schema: string, private max = 6) {}

  private async acquire(): Promise<PsqlSession> {
    const s = this.free.pop();
    if (s) return s;
    if (this.all.length < this.max) {
      const n = new PsqlSession(this.url, this.schema);
      this.all.push(n);
      return n;
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  private release(s: PsqlSession) {
    const w = this.waiters.shift();
    if (w) w(s);
    else this.free.push(s);
  }
  async query<T = Row>(sql: string, params?: unknown[]) {
    const s = await this.acquire();
    try { return await s.query<T>(sql, params); } finally { this.release(s); }
  }
  async exec(sql: string) {
    const s = await this.acquire();
    try { await s.exec(sql); } finally { this.release(s); }
  }
  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const s = await this.acquire();
    try {
      await s.query("begin");
      const out = await fn({ query: (sql, p) => s.query(sql, p), exec: (sql) => s.exec(sql) });
      await s.query("commit");
      return out;
    } catch (e) {
      await s.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      this.release(s);
    }
  }
  async close() {
    for (const s of this.all) s.close();
  }
}

async function psqlAdmin(url: string, sql: string) {
  await new Promise<void>((resolve, reject) => {
    const p = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", url, "-c", sql]);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err))));
  });
}

export async function makeTestDb(): Promise<TestDb> {
  const url = process.env.TEST_PSQL_URL;
  if (url) {
    const schema = `t_${randomBytes(6).toString("hex")}`;
    await psqlAdmin(url, `create schema "${schema}"`);
    const db = new PsqlDb(url, schema);
    await ensureSetup(db);
    const reopened: PsqlDb[] = [];
    return {
      db,
      kind: "psql",
      reopen: async () => {
        const extra = new PsqlDb(url, schema);
        reopened.push(extra);
        return extra;
      },
      cleanup: async () => {
        // close every handle (including ones opened by reopen()) BEFORE dropping the schema, otherwise a
        // lingering psql child keeps the test process alive and can block the DROP.
        for (const extra of reopened) await extra.close();
        await db.close();
        await psqlAdmin(url, `drop schema "${schema}" cascade`).catch(() => undefined);
      },
    };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite();
  const mk = (c: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>; exec: (s: string) => Promise<unknown> }): Queryable => ({
    query: async <T = Row>(sql: string, params?: unknown[]) => {
      const r = await c.query(sql, params);
      return { rows: r.rows as T[], rowCount: r.affectedRows ?? r.rows.length };
    },
    exec: async (sql: string) => void (await c.exec(sql)),
  });
  const base = mk(pg as never);
  const db: Db = {
    ...base,
    tx: (fn) => pg.transaction((tx: unknown) => fn(mk(tx as never))),
    close: () => pg.close(),
  };
  await ensureSetup(db);
  return { db, kind: "pglite", reopen: async () => db, cleanup: () => db.close() };
}
