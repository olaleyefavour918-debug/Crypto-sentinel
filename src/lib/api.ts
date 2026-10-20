import { json } from "./auth";
import { DbNotConfiguredError, getDb, type Db } from "./db";
import { logger } from "./logger";
import { ensureSetup } from "./migrations";
import { sanitizeError } from "./bybit";

/** Resolves the database (running migrations once) or returns a ready-to-send error Response. */
export async function withDb(): Promise<{ db: Db; res?: undefined } | { db?: undefined; res: Response }> {
  try {
    const db = getDb();
    await ensureSetup(db);
    return { db };
  } catch (e) {
    return { res: dbErrorResponse(e) };
  }
}

export function dbErrorResponse(e: unknown): Response {
  if (e instanceof DbNotConfiguredError) {
    return json({ error: "database_not_configured", message: "No database is connected. Add a Postgres database (README → Database) and redeploy." }, 503);
  }
  logger.error("db.error", { error: sanitizeError(e) });
  return json({ error: "database_error", message: "The database could not be reached. Check the connection string and the database status." }, 503);
}

export function internalError(e: unknown): Response {
  logger.error("api.error", { error: sanitizeError(e) });
  return json({ error: "internal_error", message: "Something went wrong. See server logs." }, 500);
}

export async function readJson(req: Request, maxBytes = 16_384): Promise<unknown | undefined> {
  const text = await req.text();
  if (text.length > maxBytes) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
