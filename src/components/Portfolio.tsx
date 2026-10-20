import { baseOf, fmtPct, fmtPrice, fmtQty, fmtSigned, fmtUsdt } from "@/lib/format";
import type { Account, Asset, Position, TradeEvent, TradeStats } from "@/lib/store";
import { ageLabel, fmtUtcShort } from "@/lib/time";
import { notificationLabel, portfolioView, type Tone } from "@/lib/viewmodel";
import { Card, Empty, Notice, Pill, Stat } from "./ui";

const pnlTone = (n: number | null): "up" | "down" | undefined => (n === null || n === 0 ? undefined : n > 0 ? "up" : "down");

export function Portfolio({ account, positions, assets, stats, now, feeRatePct }: {
  account: Account; positions: Position[]; assets: Asset[]; stats: TradeStats; now: number; feeRatePct: number;
}) {
  const v = portfolioView(account, positions, assets, stats.netTotal, now, feeRatePct);
  return (
    <Card title="Paper-trading portfolio" right={<Pill tone="neutral">Simulated · no real funds</Pill>}>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Starting balance" value={`${fmtUsdt(account.startingBalance)} USDT`} />
        <Stat label="Available" value={`${fmtUsdt(account.availableBalance)} USDT`} />
        <Stat label="In open positions" value={`${fmtUsdt(v.reserved)} USDT`} sub={`${positions.length} open`} />
        <Stat label="Unrealized P/L" value={v.rows.some((r) => r.unrealizedNet !== null) ? `${fmtSigned(v.unrealizedNet, 4)}` : "—"} tone={pnlTone(v.unrealizedNet)} sub="net of est. exit fee" />
        <Stat label="Realized net P/L" value={`${fmtSigned(stats.netTotal, 4)}`} tone={pnlTone(stats.netTotal)} sub={`${stats.closedCount} closed · ${stats.wins} wins`} />
        <Stat label="Simulated equity" value={`${fmtUsdt(v.equity)} USDT`} />
      </div>

      {v.stalePrices && positions.length > 0 && (
        <div className="mt-4"><Notice tone="warn" title="Some prices are stale or missing">Unrealized P/L is hidden for those positions until the monitor refreshes the price.</Notice></div>
      )}

      <h3 className="mt-6 text-xs font-semibold uppercase tracking-wider text-fg-mute">Open simulated positions</h3>
      {v.rows.length === 0 ? (
        <div className="mt-2"><Empty>No open positions. The monitor keeps watching every selected coin for the next BUY conditions.</Empty></div>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="text-left text-xs text-fg-mute">
                <th className="py-2 pr-3 font-normal">Coin</th><th className="pr-3 text-right font-normal">Entry</th><th className="pr-3 text-right font-normal">Current</th>
                <th className="pr-3 text-right font-normal">Quantity</th><th className="pr-3 text-right font-normal">Amount</th>
                <th className="pr-3 text-right font-normal">Stop / target</th><th className="text-right font-normal">Unrealized net</th>
              </tr>
            </thead>
            <tbody>
              {v.rows.map(({ position: p, price, priceAgeMs, unrealizedNet, unrealizedPct }) => (
                <tr key={p.id} className="border-t border-line">
                  <td className="py-2.5 pr-3 font-medium">{baseOf(p.symbol)}<span className="block text-xs font-normal text-fg-mute">opened {fmtUtcShort(p.openedAt)}</span></td>
                  <td className="num pr-3 text-right">{fmtPrice(p.entryPrice)}</td>
                  <td className="num pr-3 text-right">{fmtPrice(price)}{priceAgeMs !== null && <span className="block text-xs text-fg-mute">{ageLabel(now - priceAgeMs, now)}</span>}</td>
                  <td className="num pr-3 text-right">{fmtQty(p.quantity)}</td>
                  <td className="num pr-3 text-right">{fmtUsdt(p.amountUsdt)}</td>
                  <td className="num pr-3 text-right text-xs text-fg-dim">{fmtPrice(p.entryPrice * (1 - p.stopLossPct / 100))}<br />{fmtPrice(p.entryPrice * (1 + p.takeProfitPct / 100))}</td>
                  <td className={`num text-right font-medium ${unrealizedNet === null ? "text-fg-mute" : unrealizedNet >= 0 ? "text-up" : "text-down"}`}>
                    {unrealizedNet === null ? "—" : fmtSigned(unrealizedNet, 4)}
                    {unrealizedPct !== null && <span className="block text-xs">{fmtPct(unrealizedPct)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-fg-mute">Hypothetical figures using reference prices and an assumed {feeRatePct}% fee per side. They ignore slippage and are not actual exchange fills or a guide to future results.</p>
    </Card>
  );
}

const toneText: Record<Tone, string> = { good: "text-up", warn: "text-warn", bad: "text-down", neutral: "text-fg-mute" };

export function TradeHistory({ trades }: { trades: TradeEvent[] }) {
  return (
    <Card title="Trade history" right={<span className="text-xs text-fg-mute">latest {trades.length}</span>}>
      {trades.length === 0 ? (
        <Empty>No simulated trades yet. Entries and exits appear here as soon as the monitor records them.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="text-left text-xs text-fg-mute">
                <th className="py-2 pr-3 font-normal">Time (UTC)</th><th className="pr-3 font-normal">Coin</th><th className="pr-3 font-normal">Event</th>
                <th className="pr-3 text-right font-normal">Price</th><th className="pr-3 text-right font-normal">Gross</th><th className="pr-3 text-right font-normal">Fees</th>
                <th className="pr-3 text-right font-normal">Net P/L</th><th className="font-normal">Email</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => {
                const n = t.notificationStatus ? notificationLabel(t.notificationStatus) : null;
                const fees = t.type === "SELL" ? (t.entryFee ?? 0) + (t.exitFee ?? 0) : null;
                return (
                  <tr key={t.id} className="border-t border-line align-top">
                    <td className="num whitespace-nowrap py-2.5 pr-3">{fmtUtcShort(t.occurredAt)}</td>
                    <td className="pr-3 font-medium">{baseOf(t.symbol)}</td>
                    <td className="pr-3">
                      <Pill tone={t.type === "BUY" ? "good" : "neutral"}>{t.type === "BUY" ? "Paper BUY" : "Paper SELL"}</Pill>
                      <details className="mt-1 max-w-[260px] text-xs text-fg-mute"><summary className="cursor-pointer select-none">Reason</summary><p className="mt-1 whitespace-pre-wrap break-words">{t.reason}</p></details>
                    </td>
                    <td className="num pr-3 text-right">{fmtPrice(t.price)}</td>
                    <td className="num pr-3 text-right">{t.grossPnl === null ? "—" : fmtSigned(t.grossPnl)}</td>
                    <td className="num pr-3 text-right">{fees === null ? "—" : fmtUsdt(fees, 4)}</td>
                    <td className={`num pr-3 text-right font-medium ${t.netPnl === null ? "text-fg-mute" : t.netPnl >= 0 ? "text-up" : "text-down"}`}>{t.netPnl === null ? "—" : fmtSigned(t.netPnl)}</td>
                    <td className={`text-xs ${n ? toneText[n.tone] : "text-fg-mute"}`} title={n?.explain}>{n ? n.label : "—"}{t.notificationError && <span className="block max-w-[180px] truncate text-down" title={t.notificationError}>{t.notificationError}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
