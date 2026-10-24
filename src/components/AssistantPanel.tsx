"use client";
import { useState, type FormEvent } from "react";
import { api, errorMessage } from "./api";
import { Btn, Card } from "./ui";

interface Turn { q: string; a: string; ok: boolean }

const SUGGESTIONS = [
  "Give me a summary",
  "What is the difference between BUY and LONG?",
  "Why is ETH neutral?",
  "What would invalidate BTC?",
  "What are the stop and target levels?",
  "How has it performed?",
];

export default function AssistantPanel({ selected }: { selected: string | null }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);

  async function ask(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setQ("");
    const r = await api<{ answer?: string }>("/api/assistant", { method: "POST", body: { question: text, symbol: selected ?? undefined } });
    setBusy(false);
    setTurns((t) => [{ q: text, a: r.ok && r.data.answer ? r.data.answer : errorMessage(r.data, "The assistant could not answer."), ok: r.ok }, ...t].slice(0, 8));
  }

  return (
    <Card id="assistant" title="Assistant (built-in, rule-based)">
      <p className="text-sm text-fg-dim">Answers come only from your app’s stored data — no AI service, no guessing. If something isn’t available it will say so.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => <Btn key={s} className="!min-h-[34px] !px-2.5 !py-1 !text-xs" disabled={busy} onClick={() => ask(s)}>{s}</Btn>)}
      </div>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); void ask(q); }} className="mt-3 flex gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={300} placeholder="Ask e.g. why is SOL short?" aria-label="Ask the assistant" className="min-w-0 flex-1 rounded-lg border border-line-2 bg-ink px-3 py-2 text-sm outline-none focus:border-accent" />
        <Btn variant="primary" type="submit" disabled={busy || !q.trim()}>{busy ? "…" : "Ask"}</Btn>
      </form>
      <div className="mt-4 space-y-4">
        {turns.map((t, i) => (
          <div key={`${i}-${t.q}`} className="rounded-xl border border-line-2 p-3">
            <div className="text-xs font-semibold text-accent">You: {t.q}</div>
            <div className={`mt-2 whitespace-pre-wrap text-sm ${t.ok ? "text-fg-dim" : "text-down"}`}>{t.a}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}
