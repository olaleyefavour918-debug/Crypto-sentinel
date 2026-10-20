import { baseOf, fmtPrice } from "@/lib/format";
import type { EvaluationRow } from "@/lib/store";
import { fmtUtc } from "@/lib/time";
import type { Condition, Settings, TimeframeSnapshot } from "@/lib/types";
import { evalBadge } from "@/lib/viewmodel";
import { Card, Empty, Pill } from "./ui";

const num = (v: number | null | undefined, dp = 2) => (v === null || v === undefined ? "—" : fmtPrice(Number(v.toFixed(dp))));

function Ind({ label, h1, h4 }: { label: string; h1: string; h4?: string }) {
  return (
    <tr className="border-t border-line">
      <th scope="row" className="py-1.5 pr-3 text-left font-normal text-fg-mute">{label}</th>
      <td className="num py-1.5 pr-3 text-right">{h1}</td>
      <td className="num py-1.5 text-right">{h4 ?? "—"}</td>
    </tr>
  );
}

export default function Signal({ symbol, evaluation, lastSignal, settings }: {
  symbol: string; evaluation: EvaluationRow | undefined; lastSignal: { evaluatedAt: number; summary: string } | undefined; settings: Settings;
}) {
  const b = evalBadge(evaluation?.status ?? null);
  const conditions = (evaluation?.conditions ?? []) as Condition[];
  const ind = (evaluation?.indicators ?? null) as { h1: TimeframeSnapshot; h4: TimeframeSnapshot } | null;
  const usable = evaluation && evaluation.status !== "DATA_INVALID" && ind;

  return (
    <Card title={`Signal monitor · ${baseOf(symbol)}/USDT`} right={<Pill tone={b.tone}>{b.label}</Pill>}>
      {!evaluation ? (
        <Empty>This coin has not been evaluated yet. The first evaluation happens on the next monitor run.</Empty>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <p className="text-sm text-fg-dim">{evaluation.summary}</p>
            <p className="mt-1 text-xs text-fg-mute">Evaluated {fmtUtc(evaluation.evaluatedAt)}{evaluation.h1CandleStart ? ` on the 1h candle opened ${fmtUtc(evaluation.h1CandleStart)}` : ""}.</p>
            <ul className="mt-4 space-y-2" aria-label="BUY conditions">
              {conditions.map((c) => (
                <li key={c.id} className="flex gap-2.5 text-sm">
                  <span
                    aria-label={!c.evaluated ? "not evaluated" : c.passed ? "passed" : "failed"}
                    className={`mt-0.5 inline-flex h-5 w-5 flex-none items-center justify-center rounded-full text-xs font-bold ${!c.evaluated ? "bg-white/10 text-fg-mute" : c.passed ? "bg-up/15 text-up" : "bg-down/15 text-down"}`}
                  >{!c.evaluated ? "–" : c.passed ? "✓" : "✕"}</span>
                  <span className="min-w-0">
                    <span className="block text-fg">{c.label}</span>
                    <span className="block text-xs text-fg-mute">{c.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-mute">Indicators used (closed candles)</h3>
            {usable ? (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-xs text-fg-mute"><th className="text-left font-normal" /><th className="pr-3 text-right font-normal">1h</th><th className="text-right font-normal">4h</th></tr></thead>
                  <tbody>
                    <Ind label={`EMA ${settings.emaFast}`} h1={num(ind.h1.emaFast)} h4={num(ind.h4.emaFast)} />
                    <Ind label={`EMA ${settings.emaSlow}`} h1={num(ind.h1.emaSlow)} h4={num(ind.h4.emaSlow)} />
                    <Ind label={`RSI ${settings.rsiPeriod}`} h1={num(ind.h1.rsi)} />
                    <Ind label="MACD" h1={num(ind.h1.macd, 4)} />
                    <Ind label="MACD signal" h1={num(ind.h1.macdSignal, 4)} />
                    <Ind label="MACD histogram" h1={num(ind.h1.macdHist, 4)} />
                    <Ind label={`ATR ${settings.atrPeriod}`} h1={num(ind.h1.atr)} />
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-2 text-sm text-fg-mute">Indicators are not shown because the data failed quality checks, so no signal can be produced.</p>
            )}
            <div className="mt-4 rounded-xl border border-line bg-ink-2/60 px-3 py-2.5 text-sm">
              <div className="text-xs font-semibold uppercase tracking-wider text-fg-mute">Most recent BUY-condition match</div>
              <div className="mt-1 text-fg-dim">{lastSignal ? `${fmtUtc(lastSignal.evaluatedAt)}` : "None recorded yet for this coin."}</div>
            </div>
          </div>
        </div>
      )}
      <p className="mt-4 border-t border-line pt-3 text-xs text-fg-mute">
        Educational rule check, not advice and not a prediction. A match means the listed conditions were true on the last closed candles; it does not mean the price will rise. You decide whether to act — this app never places real orders.
      </p>
    </Card>
  );
}
