import { clientIp, json, requireAdminMutation } from "@/lib/auth";
import { internalError, withDb } from "@/lib/api";
import { answerQuestion } from "@/lib/assistant";
import { directionalSummary } from "@/lib/directional-run";
import { rateLimit } from "@/lib/ratelimit";
import { latestEvaluations, listAssets, listOpenPositions, listTrades, loadSettings } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Built-in rule-based assistant: answers only from stored application data. */
export async function POST(req: Request) {
  const denied = requireAdminMutation(req);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => null)) as { question?: unknown; symbol?: unknown } | null;
    const question = typeof body?.question === "string" ? body.question.trim() : "";
    if (!question || question.length > 300) return json({ error: "invalid_question", message: "Ask a question of up to 300 characters." }, 400);
    const symbol = typeof body?.symbol === "string" ? body.symbol.toUpperCase().slice(0, 20) : undefined;
    const got = await withDb();
    if (got.res) return got.res;
    const rl = await rateLimit(got.db, `assistant:${clientIp(req)}`, 30, 60_000);
    if (!rl.allowed) return json({ error: "rate_limited", message: "Please slow down a little." }, 429, { "retry-after": String(rl.retryAfterSec) });
    const [settings, assets, dir, evaluations, positions, trades] = await Promise.all([
      loadSettings(got.db), listAssets(got.db), directionalSummary(got.db), latestEvaluations(got.db), listOpenPositions(got.db), listTrades(got.db, 40),
    ]);
    const out = answerQuestion(question, { now: Date.now(), settings, assets, directional: dir.assessments, signals: dir.signals, stats: dir.stats, evaluations, positions, trades }, symbol);
    return json(out);
  } catch (e) {
    return internalError(e);
  }
}
