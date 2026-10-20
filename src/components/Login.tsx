"use client";
import { useState, type FormEvent } from "react";
import { api, errorMessage } from "./api";
import { Btn } from "./ui";

export default function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await api("/api/auth/login", { method: "POST", body: { password } });
    setBusy(false);
    if (r.ok) onDone();
    else setError(errorMessage(r.data, "Could not sign in."));
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <div className="mb-6 text-center">
        <div className="text-2xl font-bold tracking-tight"><span className="text-btc">₿</span> Crypto Sentinel</div>
        <p className="mt-1 text-sm text-fg-mute">Educational paper-trading monitor · no real orders, ever</p>
      </div>
      <form onSubmit={submit} className="rounded-2xl border border-line bg-panel/80 p-5 shadow-card">
        <label htmlFor="pw" className="block text-sm font-medium text-fg-dim">Dashboard password</label>
        <input
          id="pw" type="password" autoComplete="current-password" required value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-2 w-full rounded-lg border border-line-2 bg-ink px-3 py-2.5 text-fg outline-none focus:border-accent"
        />
        {error && <p role="alert" className="mt-3 text-sm text-down">{error}</p>}
        <Btn variant="primary" type="submit" disabled={busy || !password} className="mt-4 w-full">{busy ? "Signing in…" : "Sign in"}</Btn>
        <p className="mt-3 text-xs text-fg-mute">This is the ADMIN_PASSWORD you set in your hosting environment variables.</p>
      </form>
    </main>
  );
}
