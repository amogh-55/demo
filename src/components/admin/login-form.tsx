"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { api, errorMessage } from "@/lib/client";
import { Alert, Button, Spinner } from "@/components/ui/primitives";

export function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/admin/login", { method: "POST", body: JSON.stringify({ username, password }) });
      router.replace("/admin");
      router.refresh();
    } catch (err) {
      // The server never says which of the two was wrong.
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-4">
      <div>
        <label className="field-label" htmlFor="admin-username">
          Username
        </label>
        <input
          id="admin-username"
          className="field-input"
          autoComplete="username"
          autoCapitalize="none"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
      </div>
      <div>
        <label className="field-label" htmlFor="admin-password">
          Password
        </label>
        <input
          id="admin-password"
          className="field-input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Button type="submit" className="w-full" disabled={busy || !username || !password}>
        {busy ? <Spinner /> : null}
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
