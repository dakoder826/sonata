"use client";

import { useState } from "react";
import AuthButtons from "@/components/AuthButtons";

export default function Home() {
  const [songUrl, setSongUrl] = useState("");
  const [status, setStatus] = useState("idle"); // idle | pending | done | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setResult(null);

    if (!songUrl.trim()) {
      setError("Please paste a song link.");
      return;
    }

    setStatus("pending");
    try {
      const response = await fetch("/api/transcriptions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ songUrl }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        const message = data?.error || "Something went wrong.";
        throw new Error(message);
      }

      const data = await response.json();
      setResult(data);
      setStatus("done");
    } catch (err) {
      setError(err.message || "Failed to create transcription.");
      setStatus("error");
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-zinc-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-black text-white flex items-center justify-center text-xs font-semibold">
              ♫
            </div>
            <div>
              <p className="text-sm font-semibold text-zinc-900">
                Piano Sheet Converter
              </p>
              <p className="text-xs text-zinc-500">
                Paste a link. Get a piano sheet.
              </p>
            </div>
          </div>
          <AuthButtons />
        </div>
      </header>

      <main className="flex-1">
        <div className="mx-auto flex max-w-4xl flex-col gap-8 px-4 py-12 md:py-16">
          <section className="max-w-2xl">
            <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 md:text-4xl">
              Convert any song link into{" "}
              <span className="underline decoration-zinc-400">
                clean piano sheets
              </span>
              .
            </h1>
            <p className="mt-3 text-sm text-zinc-600 md:text-base">
              No account needed to try it out. Sign in only if you want to save
              your pieces and come back later.
            </p>
          </section>

          <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm md:p-6">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <label
                  htmlFor="songUrl"
                  className="block text-sm font-medium text-zinc-800"
                >
                  Song link
                </label>
                <input
                  id="songUrl"
                  type="url"
                  placeholder="Paste a YouTube link, audio URL, etc."
                  value={songUrl}
                  onChange={(event) => setSongUrl(event.target.value)}
                  className="w-full rounded-xl border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm outline-none ring-0 transition focus:border-zinc-900 focus:bg-white"
                />
                <p className="text-xs text-zinc-500">
                  We&apos;ll fetch the audio on the server. Nothing is stored
                  unless you are signed in.
                </p>
              </div>

              {error && (
                <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {error}
                </p>
              )}

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <button
                  type="submit"
                  disabled={status === "pending"}
                  className="inline-flex items-center justify-center rounded-full bg-black px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400"
                >
                  {status === "pending"
                    ? "Converting..."
                    : "Convert to piano sheet"}
                </button>
                <p className="text-xs text-zinc-500">
                  This is an early preview. Expect ~stubbed results until the AI
                  backend is wired up.
                </p>
              </div>
            </form>

            {result && (
              <div className="mt-6 border-t border-zinc-200 pt-4">
                <h2 className="text-sm font-semibold text-zinc-800">
                  Your conversion
                </h2>
                <p className="mt-1 text-xs text-zinc-500 break-all">
                  {result.songUrl}
                </p>
                <div className="mt-3 flex flex-wrap gap-3">
                  <a
                    href={result.pdfUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-100"
                  >
                    Download PDF (stub)
                  </a>
                  <a
                    href={result.midiUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-100"
                  >
                    Download MIDI (stub)
                  </a>
                </div>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
