"use client";

import { useSession, signIn, signOut } from "next-auth/react";

export default function AuthButtons() {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return (
      <button
        className="px-3 py-1.5 rounded-full border border-white/25 text-sm text-neutral-400"
        disabled
      >
        Loading...
      </button>
    );
  }

  if (!session) {
    return (
      <button
        onClick={() => signIn("google")}
        className="px-3 py-1.5 rounded-full border border-white/40 text-sm text-neutral-100 transition-colors hover:border-white hover:bg-white hover:text-neutral-950"
      >
        Sign in
      </button>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-neutral-400 truncate max-w-[120px]">
        {session.user?.email}
      </span>
      <button
        onClick={() => signOut()}
        className="px-3 py-1.5 rounded-full border border-white/25 text-sm text-neutral-200 transition-colors hover:border-white/50 hover:bg-white/10"
      >
        Sign out
      </button>
    </div>
  );
}
