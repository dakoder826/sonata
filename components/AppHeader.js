"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import AuthButtons from "@/components/AuthButtons";

export default function AppHeader() {
  const { data: session } = useSession();
  const pathname = usePathname();
  const isHome = pathname === "/";
  const logoHref = session ? "/sheets" : "/";

  return (
    <header className="sticky top-0 z-40 bg-neutral-950/90 backdrop-blur-md">
      <div className="mx-auto grid max-w-6xl grid-cols-[1fr_auto_1fr] items-center px-4 py-3 md:px-6">
        <Link href={logoHref} className="flex items-center gap-3">
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

        <div className="hidden items-center justify-center gap-8 sm:flex">
          {isHome ? (
            <>
              <a
                href="#convert"
                className="text-sm font-medium text-neutral-400 transition hover:text-white"
              >
                Try it
              </a>
              <a
                href="#pricing"
                className="text-sm font-medium text-neutral-400 transition hover:text-white"
              >
                Pricing
              </a>
            </>
          ) : session ? (
            <Link
              href="/pricing"
              className="text-sm font-medium text-neutral-400 transition hover:text-white"
            >
              Pricing
            </Link>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 sm:gap-3">
          <AuthButtons />
        </div>
      </div>
    </header>
  );
}
