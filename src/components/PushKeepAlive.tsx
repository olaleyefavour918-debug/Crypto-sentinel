"use client";
import { useEffect } from "react";
import { api } from "./api";

const toKey = (b64u: string) => {
  const pad = "=".repeat((4 - (b64u.length % 4)) % 4);
  const raw = atob((b64u + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

/**
 * Keeps this phone's push subscription alive. Browsers occasionally rotate or drop a subscription, and the server deletes
 * one the push service reports as expired; either way alerts would silently stop. Whenever the app is opened (or comes
 * back to the foreground) and notifications are already allowed, this re-registers the device with the server (safe to
 * repeat) or re-creates the subscription if the browser lost it. It never asks for permission and never shows UI.
 */
export default function PushKeepAlive() {
  useEffect(() => {
    let running = false;
    const heal = async () => {
      if (running) return;
      running = true;
      try {
        if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window) || Notification.permission !== "granted") return;
        const reg = (await navigator.serviceWorker.getRegistration("/sw.js")) ?? (await navigator.serviceWorker.register("/sw.js"));
        await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
          const k = await api<{ publicKey: string }>("/api/push/key");
          if (!k.ok) return;
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(k.data.publicKey) as unknown as BufferSource });
        }
        await api("/api/push/subscribe", { method: "POST", body: sub.toJSON() });
      } catch {
        /* best effort: the Push panel shows the real state */
      } finally {
        running = false;
      }
    };
    void heal();
    const onVisible = () => { if (document.visibilityState === "visible") void heal(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  return null;
}
