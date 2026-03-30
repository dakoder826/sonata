"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import AuthButtons from "@/components/AuthButtons";

export default function AppHeader() {
  const pathname = usePathname();
  const isHome = pathname === "/";

  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-neutral-950/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 md:px-6">
        <Link href="/" className="flex items-center gap-3">
          <Image
            src="/sonata-logo.svg"
            alt="Sonata logo"
            width={44}
            height={44}
            className="h-11 w-11 rounded-full border border-white/15 bg-white object-contain p-1"
          />
          <div>
            <p className="text-sm font-semibold tracking-tight text-neutral-100">
              Sonata
            </p>
            <p className="text-xs text-neutral-500">
              Paste a link. Get a piano sheet.
            </p>
          </div>
        </Link>

        <div className="flex items-center gap-2 sm:gap-3">
          {!isHome && (
            <Link
              href="/sheets"
              className="hidden text-sm font-medium text-neutral-400 transition hover:text-white sm:inline"
            >
              Your Sheets
            </Link>
          )}
          {isHome && (
            <a
              href="#convert"
              className="hidden text-sm font-medium text-neutral-400 transition hover:text-white sm:inline"
            >
              Try it
            </a>
          )}
          <AuthButtons />
        </div>
      </div>
    </header>
  );
}
