import { SignIn } from "@clerk/react";
import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  sanitizeTemporaryUsername,
  setTemporaryUsername,
  temporaryUsernameAuthEnabled,
} from "@/lib/temporary-user";

export default function SignInPage() {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const [, setLocation] = useLocation();
  const [username, setUsername] = useState("");
  const cleaned = sanitizeTemporaryUsername(username);

  if (temporaryUsernameAuthEnabled) {
    const submit = (event: FormEvent) => {
      event.preventDefault();
      if (cleaned.length < 2) return;
      setTemporaryUsername(cleaned);
      setLocation("/lobby", { replace: true });
    };

    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-secondary/20 via-background to-background relative">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#4f4f4f2e_1px,transparent_1px),linear-gradient(to_bottom,#4f4f4f2e_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_80%_50%_at_50%_0%,#000_70%,transparent_100%)] pointer-events-none" />
        <form
          onSubmit={submit}
          className="relative z-10 w-full max-w-sm rounded-md border border-primary/20 bg-card/95 p-8 shadow-[0_0_50px_rgba(251,191,36,0.08)]"
        >
          <div className="mb-8 text-center">
            <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full border border-primary text-primary">
              <span className="text-xl">◇</span>
            </div>
            <h1 className="text-xl font-bold tracking-wide">Access B5: ACTA</h1>
            <p className="mt-2 text-sm text-muted-foreground">Enter a commander name to resume operations</p>
          </div>
          <label className="mb-2 block text-sm font-semibold text-foreground" htmlFor="temporary-username">
            Commander name
          </label>
          <Input
            id="temporary-username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="e.g. Shirlyn"
            autoComplete="nickname"
            autoFocus
            maxLength={24}
            data-testid="input-temporary-username"
          />
          <p className="mt-2 min-h-5 text-xs text-muted-foreground">
            Letters, numbers, spaces, hyphen, or underscore.
          </p>
          <Button
            type="submit"
            className="mt-6 w-full"
            disabled={cleaned.length < 2}
            data-testid="button-enter-lobby"
          >
            Enter Lobby
          </Button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-secondary/20 via-background to-background relative">
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#4f4f4f2e_1px,transparent_1px),linear-gradient(to_bottom,#4f4f4f2e_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_80%_50%_at_50%_0%,#000_70%,transparent_100%)] pointer-events-none" />
      <div className="relative z-10 shadow-[0_0_50px_rgba(251,191,36,0.05)] border border-primary/10 rounded-md overflow-hidden">
        <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
      </div>
    </div>
  );
}
