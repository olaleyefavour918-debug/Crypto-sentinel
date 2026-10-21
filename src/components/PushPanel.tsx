"use client";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "./api";
import { Btn, Card, Notice, Pill } from "./ui";

type Phase = "checking" | "unsupported" | "denied" | "off" | "on";

const toKey = (b64u: string) => {
  const pad = "=".repeat((4 - (b64u.length % 4)) % 4);
  const raw = atob((b64u + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

export default function PushPanel() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [devices, setDevices] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setPhase("unsupported");
      return;
    }
    const k = await api<{ devices?: number }>("/api/push/key");
    if (k.ok) setDevices(k.data.devices ?? 0);
    if (Notification.permission === "denied") return setPhase("denied");
    try {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      const sub = await reg?.pushManager.getSubscription();
      setPhase(sub ? "on" : "off");
    } catch {
      setPhase("off");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function enable() {
    setBusy(true);
    setMsg(null);
    try {
      const k = await api<{ publicKey?: string }>("/api/push/key");
      if (!k.ok || !k.data.publicKey) throw new Error(errorMessage(k.data, "Could not load the notification key."));
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setPhase(perm === "denied" ? "denied" : "off");
        throw new Error("Notification permission was not granted.");
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(k.data.publicKey) }));
      const r = await api("/api/push/subscribe", { method: "POST", body: sub.toJSON() });
      if (!r.ok) throw new Error(errorMessage(r.data, "The server did not save this device."));
      setMsg({ ok: true, text: "This device is subscribed. Tap “Send test notification” to check it." });
      await refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Could not enable notifications." });
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setMsg(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await api("/api/push/subscribe", { method: "DELETE", body: { endpoint: sub.endpoint } });
        await sub.unsubscribe();
      }
      setMsg({ ok: true, text: "Notifications are off for this device." });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setMsg(null);
    const r = await api<{ message?: string }>("/api/push/test", { method: "POST", body: {} });
    setBusy(false);
    setMsg({ ok: r.ok, text: errorMessage(r.data, r.ok ? "Sent." : "Test failed.") });
  }

  return (
    <Card
      id="push"
      title="Phone notifications"
      right={phase === "on" ? <Pill tone="good">On · this device</Pill> : phase === "checking" ? <Pill>Checking…</Pill> : <Pill tone="warn">Off</Pill>}
    >
      <p className="text-sm text-fg-dim">
        Get a pop-up on your phone when a BUY or SELL signal fires (works even when this page is closed). Email stays the main alert; this is a quick extra.
        Notifications are best effort: if your phone is off or the browser is force-closed they can be delayed or missed.
      </p>
      <div className="mt-3 text-xs text-fg-mute">{devices} device(s) subscribed in total.</div>

      {phase === "unsupported" && (
        <div className="mt-4"><Notice tone="warn" title="This browser can't receive notifications">Use Chrome on Android, or on iPhone first add this site to your Home Screen (Share → Add to Home Screen) and open it from there.</Notice></div>
      )}
      {phase === "denied" && (
        <div className="mt-4"><Notice tone="bad" title="Notifications are blocked">In Chrome tap the lock icon in the address bar → Permissions (or Site settings) → Notifications → Allow, then reload this page.</Notice></div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {(phase === "off" || phase === "checking") && <Btn variant="primary" disabled={busy || phase === "checking"} onClick={enable}>Enable notifications on this device</Btn>}
        {phase === "on" && (
          <>
            <Btn variant="primary" disabled={busy} onClick={test}>Send test notification</Btn>
            <Btn disabled={busy} onClick={disable}>Turn off for this device</Btn>
          </>
        )}
      </div>
      {msg && <div className="mt-4"><Notice tone={msg.ok ? "good" : "bad"} title={msg.ok ? "Done" : "Problem"}>{msg.text}</Notice></div>}
    </Card>
  );
}
