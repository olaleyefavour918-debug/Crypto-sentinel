import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { Tone } from "@/lib/viewmodel";

const toneClass: Record<Tone, string> = {
  good: "bg-up/10 text-up border-up/30",
  warn: "bg-warn/10 text-warn border-warn/30",
  bad: "bg-down/10 text-down border-down/30",
  neutral: "bg-white/5 text-fg-dim border-line-2",
};
const dotClass: Record<Tone, string> = { good: "bg-up", warn: "bg-warn", bad: "bg-down", neutral: "bg-fg-mute" };

export function Pill({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${toneClass[tone]}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dotClass[tone]}`} />
      {children}
    </span>
  );
}

export function Card({ title, right, children, id, className = "" }: { title?: ReactNode; right?: ReactNode; children: ReactNode; id?: string; className?: string }) {
  return (
    <section id={id} className={`rounded-2xl border border-line bg-panel/80 shadow-card backdrop-blur-sm ${className}`}>
      {(title || right) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 sm:px-5">
          <h2 className="text-sm font-semibold tracking-wide text-fg">{title}</h2>
          {right}
        </header>
      )}
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "up" | "down" }) {
  return (
    <div className="min-w-0">
      <div className="text-xs uppercase tracking-wider text-fg-mute">{label}</div>
      <div className={`num mt-1 truncate text-lg font-semibold sm:text-xl ${tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-fg"}`}>{value}</div>
      {sub && <div className="num mt-0.5 text-xs text-fg-mute">{sub}</div>}
    </div>
  );
}

export function Btn({ variant = "ghost", className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const base = "inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 min-h-[40px]";
  const v =
    variant === "primary" ? "bg-accent text-ink hover:bg-accent/90"
    : variant === "danger" ? "border border-down/40 text-down hover:bg-down/10"
    : "border border-line-2 text-fg-dim hover:bg-white/5 hover:text-fg";
  return <button type="button" className={`${base} ${v} ${className}`} {...rest} />;
}

export function Notice({ tone, title, children }: { tone: Tone; title: string; children?: ReactNode }) {
  const border = tone === "bad" ? "border-down/40 bg-down/5" : tone === "warn" ? "border-warn/40 bg-warn/5" : tone === "good" ? "border-up/40 bg-up/5" : "border-line-2 bg-white/5";
  return (
    <div role={tone === "bad" ? "alert" : "status"} className={`rounded-xl border px-4 py-3 text-sm ${border}`}>
      <div className="font-medium text-fg">{title}</div>
      {children && <div className="mt-1 text-fg-dim">{children}</div>}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-lg bg-white/5 ${className}`} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-line-2 px-4 py-8 text-center text-sm text-fg-mute">{children}</div>;
}
