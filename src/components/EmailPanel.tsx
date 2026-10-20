"use client";
import { useState } from "react";
import { fmtUtcShort } from "@/lib/time";
import type { NotificationRow } from "@/lib/store";
import { notificationLabel } from "@/lib/viewmodel";
import type { AppState } from "./api";
import { api, errorMessage } from "./api";
import { Btn, Card, Empty, Notice, Pill } from "./ui";

export default function EmailPanel({ email, notifications, onChanged }: { email: AppState["email"]; notifications: NotificationRow[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function sendTest() {
    setBusy(true);
    setResult(null);
    const r = await api<{ message?: string }>("/api/email/test", { method: "POST", body: {} });
    setBusy(false);
    setResult({ ok: r.ok, text: errorMessage(r.data, r.ok ? "Test email accepted." : "Test email failed.") });
    onChanged();
  }

  return (
    <Card
      id="email"
      title="Email notifications"
      right={email.configured ? <Pill tone="good">Provider connected · {email.provider}</Pill> : <Pill tone="bad">Not configured</Pill>}
    >
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div><dt className="text-xs uppercase tracking-wider text-fg-mute">Alerts go to</dt><dd className="mt-1 break-all font-medium">{email.recipient}</dd></div>
        <div><dt className="text-xs uppercase tracking-wider text-fg-mute">Delivery confirmation</dt><dd className="mt-1">{email.deliveryConfirmation ? "Enabled (provider webhook)" : "Not enabled — you will see “accepted by provider”, not “delivered”"}</dd></div>
        <div className="sm:text-right"><Btn variant="primary" onClick={sendTest} disabled={busy || !email.configured}>{busy ? "Sending…" : "Send test email"}</Btn></div>
      </dl>
      {!email.configured && (
        <div className="mt-4"><Notice tone="bad" title="Emails cannot be sent yet">{email.issue ?? "No email sender is set up."} Add the key in your hosting environment variables and redeploy. BUY/SELL alerts are still recorded and will be sent once a provider is connected (alerts older than 24 h are not sent).</Notice></div>
      )}
      {result && <div className="mt-4"><Notice tone={result.ok ? "good" : "bad"} title={result.ok ? "Test email handed to the provider" : "Test email failed"}>{result.text}</Notice></div>}

      <h3 className="mt-6 text-xs font-semibold uppercase tracking-wider text-fg-mute">Recent notifications</h3>
      {notifications.length === 0 ? (
        <div className="mt-2"><Empty>No emails yet. BUY and SELL alerts appear here with their delivery status.</Empty></div>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {notifications.map((n) => {
            const l = notificationLabel(n.status);
            return (
              <li key={n.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-medium">{n.subject}</div>
                  <div className="text-xs text-fg-mute">{fmtUtcShort(n.createdAt)} · {n.kind} · attempts {n.attempts}</div>
                  {n.lastError && <div className="mt-0.5 break-words text-xs text-down">{n.lastError}</div>}
                </div>
                <Pill tone={l.tone} title={l.explain}>{l.label}</Pill>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-3 text-xs text-fg-mute">“Accepted by provider” means the email service took the message. Only the provider’s confirmation can show “Delivered”; check your inbox and spam folder either way.</p>
    </Card>
  );
}
