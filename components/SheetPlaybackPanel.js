"use client";

import { useState } from "react";
import { signIn, useSession } from "next-auth/react";
import MidiPlayer from "@/components/MidiPlayer";

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export default function SheetPlaybackPanel({
  title = "Your piano sheet",
  sheetName = "",
  songUrl = "",
  createdAt = "",
  midiUrl = "",
  rawMidiUrl = "",
  pdfUrl = "",
  timeSignature = "4/4",
}) {
  const { data: session, status } = useSession();
  const [showSignupPrompt, setShowSignupPrompt] = useState(false);
  const [billingAction, setBillingAction] = useState("");
  const isSignedIn = Boolean(session?.user?.id || session?.user?.email);
  const canDownload = status !== "loading" && isSignedIn;
  const planTier = session?.user?.planTier === "pro" ? "pro" : "free";

  async function handleBillingNavigation(endpoint, action) {
    setBillingAction(action);
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

  const pdfFileName = (() => {
    const fallback = "piano-sheet";
    if (!songUrl) return `${fallback}.pdf`;
    try {
      const parsed = new URL(songUrl);
      const fromPath =
        parsed.pathname.split("/").filter(Boolean).pop() || fallback;
      const safe = decodeURIComponent(fromPath)
        .replace(/\.[a-z0-9]+$/i, "")
        .replace(/[^a-z0-9\s-]/gi, " ")
        .trim()
        .replace(/\s+/g, "-")
        .toLowerCase();
      return `${safe || fallback}.pdf`;
    } catch {
      const safe = songUrl
        .replace(/[^a-z0-9\s-]/gi, " ")
        .trim()
        .replace(/\s+/g, "-")
        .toLowerCase();
      return `${safe || fallback}.pdf`;
    }
  })();

  return (
    <div className="space-y-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-neutral-900">{title}</h3>
        </div>

        {songUrl ? (
          <p className="mt-1 text-xs break-all text-neutral-500">{songUrl}</p>
        ) : null}
        {createdAt ? (
          <p className="mt-1 text-xs text-neutral-500">
            Created {formatDate(createdAt)}
          </p>
        ) : null}
      </div>

      {midiUrl ? (
        <MidiPlayer
          url={midiUrl}
          timeSignature={timeSignature}
          enablePdfDownload={canDownload}
          pdfFileName={pdfFileName}
          extraControls={
            <>
              {canDownload ? (
                <>
                  <a
                    href={midiUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-800 transition hover:bg-zinc-100"
                  >
                    Download MIDI
                  </a>
                  {rawMidiUrl ? (
                    <a
                      href={rawMidiUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-800 transition hover:bg-zinc-100"
                    >
                      Download raw MIDI
                    </a>
                  ) : null}
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setShowSignupPrompt(true)}
                    className="inline-flex items-center justify-center rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-800 transition hover:cursor-pointer hover:bg-zinc-100"
                  >
                    Download MIDI
                  </button>
                  {rawMidiUrl ? (
                    <button
                      type="button"
                      onClick={() => setShowSignupPrompt(true)}
                      className="inline-flex items-center justify-center rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-800 transition hover:cursor-pointer hover:bg-zinc-100"
                    >
                      Download raw MIDI
                    </button>
                  ) : null}
                </>
              )}
              {!canDownload ? (
                <button
                  type="button"
                  onClick={() => setShowSignupPrompt(true)}
                  className="inline-flex items-center justify-center rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-800 transition hover:cursor-pointer hover:bg-zinc-100"
                >
                  Download PDF
                </button>
              ) : null}
            </>
          }
        />
      ) : null}

      {showSignupPrompt ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-md"
          onClick={() => setShowSignupPrompt(false)}
        >
          <div
            className="relative w-full max-w-md overflow-hidden rounded-3xl border border-neutral-200 bg-white p-6 text-neutral-900 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.45)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div
              className="pointer-events-none absolute -top-20 -right-16 h-48 w-48 rounded-full bg-neutral-100 blur-3xl"
              aria-hidden
            />
            <div
              className="pointer-events-none absolute -bottom-20 -left-16 h-48 w-48 rounded-full bg-neutral-200/80 blur-3xl"
              aria-hidden
            />

            <div className="relative">
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-base font-semibold tracking-tight">
                  Sign up to save and download your piano transcriptions.
                </h3>
                <button
                  type="button"
                  onClick={() => setShowSignupPrompt(false)}
                  aria-label="Close sign-up prompt"
                  className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border border-neutral-300 text-lg leading-none text-neutral-700 transition-colors duration-150 hover:border-neutral-900 hover:bg-neutral-900 hover:text-white focus-visible:ring-2 focus-visible:ring-neutral-900/30 focus-visible:outline-none"
                >
                  ×
                </button>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-neutral-600">
                Create an account to download MIDI/PDF files and keep every
                sheet in your personal library.
              </p>
            </div>

            <div className="mt-6 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => signIn(undefined, { callbackUrl: "/sheets" })}
                className="inline-flex items-center justify-center rounded-full border border-black bg-black px-4 py-2 text-xs font-semibold text-white transition hover:cursor-pointer hover:opacity-90"
              >
                Sign up / Sign in
              </button>
              <button
                type="button"
                onClick={() => setShowSignupPrompt(false)}
                className="inline-flex items-center justify-center rounded-full border border-neutral-300 bg-transparent px-4 py-2 text-xs font-medium text-neutral-700 transition hover:cursor-pointer hover:bg-neutral-100"
              >
                Not now
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
