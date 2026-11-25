import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { ApiRequestError, signInWithEmail } from "@/lib/api";
import { SetupColumn, SetupHeader, TextField } from "./shell";

export default function SignInPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextEmail = email.trim();
    if (nextEmail.length === 0) {
      setError("Enter your email.");
      return;
    }
    if (password.length === 0) {
      setError("Enter your password.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await signInWithEmail(nextEmail, password);
      queryClient.removeQueries({ queryKey: ["me", "context"] });
      await navigate({ to: "/admin" });
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : "Email or password is wrong.");
    } finally {
      setPending(false);
    }
  }

  return (
    <SetupColumn>
      <SetupHeader title="Sign in" detail={null} />
      <form className="mt-8" noValidate onSubmit={(event) => void onSubmit(event)}>
        <TextField
          id="email"
          label="Email"
          value={email}
          onChange={setEmail}
          error={null}
          readOnly={pending}
          inputMode="text"
          autoComplete="username"
          type="email"
        />
        <div className="mt-4">
          <label className="block text-base font-medium" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            className="mt-1 box-border h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-base text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            value={password}
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        {error ? (
          <p className="mt-4 text-base text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <Button className="mt-8 min-h-11 w-full text-base" type="submit" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </SetupColumn>
  );
}
