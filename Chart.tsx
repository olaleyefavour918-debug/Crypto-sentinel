"use client";
import { useEffect, useRef } from "react";
import type { ChartPayload } from "@/lib/marketview";
import type { Marker } from "@/lib/viewmodel";

/** Candlestick chart of CLOSED candles with EMA overlays and simulated BUY/SELL markers (lightweight-charts v5). */
export default function Chart({ data, markers, label, fastLabel, slowLabel }: { data: ChartPayload; markers: Marker[]; label: string; fastLabel: string; slowLabel: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let cleanup: () => void = () => undefined;
    (async () => {
      const lc = await import("lightweight-charts");
      if (disposed || !ref.current) return;
      const chart = lc.createChart(ref.current, {
        autoSize: true,
        layout: { background: { type: lc.ColorType.Solid, color: "transparent" }, textColor: "#aab3cf", fontFamily: "Inter, system-ui, sans-serif" },
        grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
        rightPriceScale: { borderColor: "#1f2a4a" },
        timeScale: { borderColor: "#1f2a4a", timeVisible: true, secondsVisible: false },
        crosshair: { mode: 1 },
      });
      const candles = chart.addSeries(lc.CandlestickSeries, {
        upColor: "#2ebd85", downColor: "#f6465d", wickUpColor: "#2ebd85", wickDownColor: "#f6465d", borderVisible: false,
      });
      candles.setData(data.candles as never);
      const fast = chart.addSeries(lc.LineSeries, { color: "#7aa2ff", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      fast.setData(data.emaFast as never);
      const slow = chart.addSeries(lc.LineSeries, { color: "#f0b429", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      slow.setData(data.emaSlow as never);
      if (markers.length) {
        lc.createSeriesMarkers(
          candles,
          markers.map((m) => ({
            time: m.time,
            position: m.kind === "BUY" ? "belowBar" : "aboveBar",
            color: m.kind === "BUY" ? "#2ebd85" : "#f6465d",
            shape: m.kind === "BUY" ? "arrowUp" : "arrowDown",
            text: m.kind === "BUY" ? "Paper BUY" : "Paper SELL",
          })) as never,
        );
      }
      chart.timeScale().fitContent();
      cleanup = () => chart.remove();
    })().catch(() => undefined);
    return () => {
      disposed = true;
      cleanup();
    };
  }, [data, markers]);

  return (
    <div>
      <div ref={ref} role="img" aria-label={`${label} candlestick chart of closed candles`} className="h-64 w-full sm:h-72" />
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-mute">
        <span><span className="mr-1 inline-block h-0.5 w-3 bg-accent align-middle" />{fastLabel}</span>
        <span><span className="mr-1 inline-block h-0.5 w-3 bg-warn align-middle" />{slowLabel}</span>
        <span>▲ ▼ simulated BUY / SELL</span>
        <span>closed candles only</span>
      </div>
    </div>
  );
}
