/**
 * The first screen a served canvas shows: one field, for the office's token.
 *
 * It is handed over once. The office answers with a cookie this page cannot
 * read, so nothing here keeps it — not in storage, not in a variable that
 * outlives the submit, and not in the bundle, which is what kept a canvas off
 * the internet until now.
 */
import { useState, type ReactNode } from "react";
import { Button } from "../ui/button.js";
import { Field, inputClass } from "../ui/field.js";

export function SignIn({
  onSignIn,
  problem,
}: {
  /** Answers with what went wrong, or null when it worked. */
  readonly onSignIn: (token: string) => Promise<string | null>;
  /** Something that went wrong before this screen was shown. */
  readonly problem: string | null;
}): ReactNode {
  const [token, setToken] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const [trying, setTrying] = useState(false);

  const submit = (event: { preventDefault: () => void }): void => {
    event.preventDefault();
    if (token.trim().length === 0 || trying) return;
    setTrying(true);
    void onSignIn(token.trim()).then((failure) => {
      setTrying(false);
      setRefused(failure);
      // Not kept on a failure either: a field holding a refused token is a
      // field somebody walks away from.
      if (failure === null) setToken("");
    });
  };

  return (
    <main className="flex h-full items-center justify-center bg-canvas p-6 text-ink">
      <form
        onSubmit={submit}
        aria-label="Sign in"
        className="flex w-full max-w-sm flex-col gap-3 rounded-panel border border-border bg-surface p-5"
      >
        <h1 className="text-lg font-semibold">Virtual Office</h1>
        <p className="text-xs text-ink-muted">
          This office is kept behind one token. Paste it in and this browser stays signed in; the
          page itself never holds it.
        </p>

        <Field label="Token">
          <input
            className={inputClass}
            type="password"
            autoComplete="current-password"
            placeholder="sk-…"
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
            }}
          />
        </Field>

        {(refused ?? problem) !== null && (
          <p role="alert" className="text-xs text-ink">
            {refused ?? problem}
          </p>
        )}

        <Button type="submit" aria-label="Sign in" disabled={token.trim().length === 0 || trying}>
          {trying ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </main>
  );
}
