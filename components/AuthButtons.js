"use client";

import { useSession, signIn, signOut } from "next-auth/react";

export default function AuthButtons() {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return (
      <button
        className="px-3 py-1.5 rounded-full border border-zinc-300 text-sm text-zinc-600"
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
        className="px-3 py-1.5 rounded-full border border-zinc-300 text-sm text-zinc-700 hover:bg-zinc-100 transition-colors"
      >
        Sign in
      </button>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-zinc-600 truncate max-w-[120px]">
        {session.user?.email}
      </span>
      <button
        onClick={() => signOut()}
        className="px-3 py-1.5 rounded-full border border-zinc-300 text-sm text-zinc-700 hover:bg-zinc-100 transition-colors"
      >
        Sign out
      </button>
    </div>
  );
}
