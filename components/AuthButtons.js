"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession, signIn, signOut } from "next-auth/react";

export default function AuthButtons() {
  const { data: session, status } = useSession();
  const pathname = usePathname();
  const isOnSheetsPage = pathname?.startsWith("/sheets");

  if (status === "loading") {
    return (
      <button
        className="rounded-full border border-white/25 px-3 py-1.5 text-sm text-neutral-400"
        disabled
      >
        Loading...
      </button>
    );
  }

  if (!session) {
    return (
      <button
        onClick={() => signIn(undefined, { callbackUrl: "/sheets" })}
        className="rounded-full border border-white/40 px-3 py-1.5 text-sm text-neutral-100 transition-colors hover:cursor-pointer hover:border-white hover:bg-white hover:text-neutral-950"
      >
        Sign in
      </button>
    );
  }

  return (
    <div className="flex items-center gap-3">
      {!isOnSheetsPage && (
        <Link
          href="/sheets"
          className="rounded-full border border-white/20 px-3 py-1.5 text-sm text-neutral-200 transition-colors hover:border-white/50 hover:bg-white/10"
        >
          My sheets
        </Link>
      )}
      <span className="max-w-[120px] truncate text-sm text-neutral-400">
        {session.user?.email}
      </span>
      <button
        onClick={() => signOut()}
        className="rounded-full border border-white/25 px-3 py-1.5 text-sm text-neutral-200 transition-colors hover:cursor-pointer hover:border-white/50 hover:bg-white/10"
      >
        Sign out
      </button>
    </div>
  );
}
