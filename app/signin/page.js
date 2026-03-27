"use client";

import { useMemo, useState } from "react";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";

export default function SignInPage() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") || "/sheets";
  const authError = searchParams.get("error");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [isRegisterMode, setIsRegisterMode] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  const authErrorText = useMemo(() => {
    if (!authError) return "";
    if (authError === "CredentialsSignin") {
      return "Invalid email or password.";
    }
    return "Could not sign in. Please try again.";
  }, [authError]);

  async function handleSubmit(event) {
    event.preventDefault();
    setMessage("");
    setIsSubmitting(true);

    try {
      if (isRegisterMode) {
        const response = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, name }),
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          setMessage(data?.error || "Could not create account.");
          return;
        }
      }

      await signIn("credentials", {
        email,
        password,
        callbackUrl,
      });
    } catch (error) {
      console.error("Sign in page submit failed:", error);
      setMessage("Could not complete sign in. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-950 px-4 py-16">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-neutral-900/70 p-6 shadow-[0_24px_60px_-24px_rgba(0,0,0,0.7)] backdrop-blur">
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          {isRegisterMode ? "Create account" : "Welcome back"}
        </h1>
        <p className="mt-2 text-sm text-neutral-400">
          Sign in with Google or email to save your piano sheets.
        </p>

        <button
          type="button"
          onClick={() => signIn("google", { callbackUrl })}
          className="mt-6 inline-flex w-full items-center justify-center rounded-xl border border-white/20 bg-white px-4 py-2.5 text-sm font-medium text-neutral-950 transition hover:cursor-pointer hover:bg-neutral-100"
        >
          Continue with Google
        </button>

        <div className="my-5 h-px w-full bg-white/10" />

        <form onSubmit={handleSubmit} className="space-y-3">
          {isRegisterMode && (
            <div className="space-y-1">
              <label htmlFor="name" className="text-xs text-neutral-400">
                Name (optional)
              </label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="w-full rounded-xl border border-white/15 bg-neutral-950 px-3 py-2 text-sm text-white ring-0 transition outline-none focus:border-white/40"
                placeholder="Your name"
              />
            </div>
          )}

          <div className="space-y-1">
            <label htmlFor="email" className="text-xs text-neutral-400">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              className="w-full rounded-xl border border-white/15 bg-neutral-950 px-3 py-2 text-sm text-white ring-0 transition outline-none focus:border-white/40"
              placeholder="you@example.com"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="password" className="text-xs text-neutral-400">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={8}
              className="w-full rounded-xl border border-white/15 bg-neutral-950 px-3 py-2 text-sm text-white ring-0 transition outline-none focus:border-white/40"
              placeholder="At least 8 characters"
            />
          </div>

          {(message || authErrorText) && (
            <p className="rounded-xl border border-red-300/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {message || authErrorText}
            </p>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="inline-flex w-full items-center justify-center rounded-xl bg-neutral-100 px-4 py-2.5 text-sm font-semibold text-neutral-950 transition hover:cursor-pointer hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting
              ? "Please wait..."
              : isRegisterMode
                ? "Create account"
                : "Sign in with email"}
          </button>
        </form>

        <button
          type="button"
          onClick={() => {
            setMessage("");
            setIsRegisterMode((current) => !current);
          }}
          className="mt-4 text-xs text-neutral-400 underline-offset-4 transition hover:text-neutral-200 hover:underline"
        >
          {isRegisterMode
            ? "Already have an account? Sign in"
            : "New here? Create an email account"}
        </button>
      </div>
    </main>
  );
}
