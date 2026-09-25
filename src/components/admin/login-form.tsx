"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { api, errorMessage } from "@/lib/client";
import { Alert, Button, Spinner } from "@/components/ui/primitives";

export function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
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
        <div className="relative">
          <input
            id="admin-password"
            className="field-input pr-12"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            autoCapitalize="none"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {/* Checking what was typed on a phone keyboard beats a third failed try. */}
          <button
            type="button"
            onClick={() => setShowPassword((shown) => !shown)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            className="absolute right-1 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-lg text-ink-400 transition-colors hover:bg-white/10 hover:text-ink-200 theme-light:hover:bg-ink-100 theme-light:hover:text-ink-700"
          >
            {showPassword ? <EyeOff className="h-5 w-5" aria-hidden="true" /> : <Eye className="h-5 w-5" aria-hidden="true" />}
          </button>
        </div>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Button type="submit" className="w-full" disabled={busy || !username || !password}>
        {busy ? <Spinner /> : null}
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
