import { fmtPrice } from "@/lib/format";
import { MARK_PRICE_NOTE, SOURCE_LABEL, priceDiff, signalAgeMinutes, type PriceRef, type Validity } from "@/lib/priceaudit";
import { ageLabel, fmtUtc, fmtWat } from "@/lib/time";

const signed = (n: number, dp: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(dp)}`;

/**
 * Side-by-side price audit for one signal. The REFERENCE price (taken when the signal was generated) and the LATEST
 * price are always shown separately; the latest never overwrites the reference. Mark price is not available for Bybit
 * spot pairs, so the index price is shown as its own, labelled value.
 */
export default function PriceAudit({ generatedAt, reference, latest, latestAt, latestRef, now, validity, alertNote }: {
  generatedAt: number | null;
  reference: PriceRef | null;
  latest: number | null;
  latestAt: number | null;
  latestRef?: PriceRef | null;
  now: number;
  validity?: Validity;
  alertNote?: string;
}) {
  const diff = priceDiff(reference?.last ?? null, latest);
  const age = signalAgeMinutes(generatedAt, now);
  const fallback = reference !== null && reference.source !== "ticker_last";
  return (
    <details className="mt-2 rounded-lg border border-line-2 bg-white/[0.03] px-3 py-2 text-sm" data-testid="price-audit">
      <summary className="cursor-pointer select-none text-fg-dim">Price audit · Bybit spot</summary>
      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
        <div><dt className="text-xs text-fg-mute">Signal generated (UTC)</dt><dd className="num">{generatedAt !== null ? fmtUtc(generatedAt) : "—"}{generatedAt !== null ? <span className="block text-fg-mute">Nigeria time: {fmtWat(generatedAt)}</span> : null}{reference?.exchangeTime ? <span className="text-fg-mute"> · Bybit ticker time {fmtUtc(reference.exchangeTime).slice(11)}</span> : null}</dd></div>
        <div><dt className="text-xs text-fg-mute">Signal age</dt><dd className="num">{age === null ? "—" : `${age} min`}</dd></div>
        <div><dt className="text-xs text-fg-mute">Reference price (kept, never replaced)</dt><dd className="num">{reference ? `${fmtPrice(reference.last)} USDT` : "not recorded (signal predates price auditing)"}</dd></div>
        <div><dt className="text-xs text-fg-mute">Latest last-traded price</dt><dd className="num">{latest !== null ? `${fmtPrice(latest)} USDT` : "—"}{latestAt !== null ? <span className="text-fg-mute"> · checked {ageLabel(latestAt, now)}</span> : null}</dd></div>
        <div><dt className="text-xs text-fg-mute">Difference (latest − reference)</dt><dd className="num">{diff ? `${signed(diff.abs, 8).replace(/0+$/, "").replace(/\.$/, "")} USDT (${signed(diff.pct, 3)}%)` : "—"}</dd></div>
        <div><dt className="text-xs text-fg-mute">Validity</dt><dd>{validity ? validity.text : "—"}</dd></div>
        <div><dt className="text-xs text-fg-mute">Bybit index price (separate)</dt><dd className="num">{reference?.indexPrice != null ? `${fmtPrice(reference.indexPrice)} at signal` : "not in the response"}{latestRef?.indexPrice != null ? ` · ${fmtPrice(latestRef.indexPrice)} now` : ""}</dd></div>
        <div><dt className="text-xs text-fg-mute">Mark price</dt><dd className="text-fg-dim">{MARK_PRICE_NOTE}</dd></div>
        {reference && reference.bid !== null && reference.ask !== null && <div><dt className="text-xs text-fg-mute">Best bid / ask at signal</dt><dd className="num">{fmtPrice(reference.bid)} / {fmtPrice(reference.ask)}</dd></div>}
        {alertNote && <div><dt className="text-xs text-fg-mute">Alert</dt><dd>{alertNote}</dd></div>}
      </dl>
      <p className={`mt-2 text-xs ${fallback ? "text-warn" : "text-fg-mute"}`}>
        {reference ? `Reference source: ${SOURCE_LABEL[reference.source]}.` : "No price snapshot was stored for this signal."}
        {fallback ? " The live Bybit price was not available at that scan, so the reference is NOT a live last-traded price." : ""}
      </p>
    </details>
  );
}
