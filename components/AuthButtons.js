"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSession, signIn, signOut } from "next-auth/react";

const AVATAR_GRADIENTS = [
  "bg-linear-to-br from-emerald-400 via-cyan-400 to-indigo-500 shadow-[0_0_18px_rgba(16,185,129,0.35)]",
  "bg-linear-to-br from-rose-400 via-fuchsia-500 to-indigo-500 shadow-[0_0_18px_rgba(244,63,94,0.35)]",
  "bg-linear-to-br from-amber-300 via-orange-400 to-rose-500 shadow-[0_0_18px_rgba(251,146,60,0.35)]",
  "bg-linear-to-br from-sky-400 via-blue-500 to-violet-500 shadow-[0_0_18px_rgba(59,130,246,0.35)]",
  "bg-linear-to-br from-lime-300 via-emerald-500 to-teal-500 shadow-[0_0_18px_rgba(34,197,94,0.35)]",
  "bg-linear-to-br from-purple-400 via-violet-500 to-pink-500 shadow-[0_0_18px_rgba(168,85,247,0.35)]",
  "bg-linear-to-br from-red-400 via-orange-500 to-amber-400 shadow-[0_0_18px_rgba(239,68,68,0.35)]",
];

export default function AuthButtons() {
  const { data: session, status } = useSession();
  const pathname = usePathname();
  const isOnSheetsPage = pathname?.startsWith("/sheets");
  const [billingAction, setBillingAction] = useState("");
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  const profileMenuRef = useRef(null);
  const planTier = session?.user?.planTier === "pro" ? "pro" : "free";
  const subscriptionStatus = session?.user?.subscriptionStatus ?? "";
  const pastDueDisplayTier = session?.user?.pastDueDisplayTier ?? "pro";
  const userInitial = useMemo(() => {
    const normalizedName =
      typeof session?.user?.name === "string" ? session.user.name.trim() : "";
    return normalizedName ? normalizedName.charAt(0).toUpperCase() : "U";
  }, [session?.user?.name]);
  const avatarGradientClass = useMemo(() => {
    const asciiCode = userInitial.charCodeAt(0);
    const isUpperAlphabet = asciiCode >= 65 && asciiCode <= 90;
    const paletteIndex = isUpperAlphabet
      ? (asciiCode - 65) % AVATAR_GRADIENTS.length
      : 0;
    return AVATAR_GRADIENTS[paletteIndex];
  }, [userInitial]);
  const planBadgeLabel = useMemo(() => {
    if (
      subscriptionStatus === "trialing" ||
      subscriptionStatus === "trialing-cancelled"
    ) {
      return "trialing";
    }

    if (
      subscriptionStatus === "pro" ||
      subscriptionStatus === "pro-cancelled"
    ) {
      return "pro";
    }

    if (subscriptionStatus === "past_due") {
      return pastDueDisplayTier === "trialing" ? "trialing" : "pro";
    }

    return planTier;
  }, [pastDueDisplayTier, planTier, subscriptionStatus]);

  async function handleBillingNavigation(endpoint, action) {
    setBillingAction(action);
    setIsProfileMenuOpen(false);
    try {
      const response = await fetch(endpoint, { method: "POST" });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.url) {
        throw new Error(data?.error || "Unable to continue to billing.");
      }
      window.location.href = data.url;
    } catch (error) {
      window.alert(error.message || "Unable to continue to billing.");
      setBillingAction("");
    }
  }

  useEffect(() => {
    function handlePointerDown(event) {
      if (!profileMenuRef.current) return;
      if (!profileMenuRef.current.contains(event.target)) {
        setIsProfileMenuOpen(false);
      }
    }

    function handleEscapeKey(event) {
      if (event.key === "Escape") {
        setIsProfileMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscapeKey);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscapeKey);
    };
  }, []);

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
      <span className="hidden rounded-full border border-white/20 px-2 py-0.5 text-xs font-semibold tracking-wide text-neutral-300 uppercase md:inline-flex">
        {planBadgeLabel}
      </span>
      <div className="relative" ref={profileMenuRef}>
        <button
          onClick={() => setIsProfileMenuOpen((isOpen) => !isOpen)}
          className={`inline-flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border border-white/30 text-xs font-semibold text-white transition-transform hover:scale-105 hover:cursor-pointer hover:border-white/60 ${avatarGradientClass}`}
          aria-expanded={isProfileMenuOpen}
          aria-haspopup="menu"
          aria-label="Open profile menu"
        >
          <span>{userInitial}</span>
        </button>
        {isProfileMenuOpen && (
          <div
            className="absolute right-0 z-20 mt-2 min-w-[220px] rounded-2xl border border-white/15 bg-neutral-900/95 p-1.5 shadow-2xl backdrop-blur-sm"
            role="menu"
          >
            <p className="truncate px-3 py-2 text-xs text-neutral-400">
              {session.user?.email}
            </p>
            {planTier === "pro" ? (
              <button
                onClick={() =>
                  handleBillingNavigation("/api/billing/portal", "portal")
                }
                className="w-full rounded-xl px-3 py-2 text-left text-sm text-neutral-200 transition-colors hover:cursor-pointer hover:bg-white/10"
                disabled={billingAction === "portal"}
                role="menuitem"
              >
                {billingAction === "portal" ? "Opening..." : "Manage billing"}
              </button>
            ) : (
              <button
                onClick={() =>
                  handleBillingNavigation("/api/billing/checkout", "checkout")
                }
                className="w-full rounded-xl px-3 py-2 text-left text-sm text-emerald-100 transition-colors hover:cursor-pointer hover:bg-emerald-500/20"
                disabled={billingAction === "checkout"}
                role="menuitem"
              >
                {billingAction === "checkout" ? "Opening..." : "Upgrade to Pro"}
              </button>
            )}
            <button
              onClick={() => {
                setIsProfileMenuOpen(false);
                signOut();
              }}
              className="mt-1 w-full rounded-xl px-3 py-2 text-left text-sm text-neutral-200 transition-colors hover:cursor-pointer hover:bg-white/10"
              role="menuitem"
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
