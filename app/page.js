"use client";

import { useState } from "react";
import AuthButtons from "@/components/AuthButtons";
import MidiPlayer from "@/components/MidiPlayer";
import TypewriterHeadline from "@/components/TypewriterHeadline";
import FloatingNotes from "@/components/FloatingNotes";

const FEATURES = [
  {
    title: "Paste almost any link",
    body: "YouTube, TikTok, or a direct audio URL — we fetch the audio on the server so you can stay in the browser.",
  },
  {
    title: "Two arrangement modes",
    body: "Simple keeps fewer notes for a cleaner line. Regular preserves more harmony and detail while staying playable.",
  },
  {
    title: "MIDI + playback",
    body: "Download a standard MIDI file and preview it right here with meter embedded from the track.",
  },
  {
    title: "Notation you can read",
    body: "See the staff alongside playback so you can connect what you hear with what’s on the page.",
  },
  {
    title: "Privacy-aware by default",
    body: "Nothing is stored unless you sign in. Try the full flow with no account, then save pieces when you’re ready.",
  },
  {
    title: "Sign in to keep pieces",
    body: "Log in with Google to keep a history of what you’ve transcribed and revisit it later.",
  },
];

const STEPS = [
  {
    step: "01",
    title: "Drop your link",
    body: "Paste a song URL or audio link into the converter.",
  },
  {
    step: "02",
    title: "Pick a mode",
    body: "Choose Simple or Regular to match how dense you want the piano part.",
  },
  {
    step: "03",
    title: "Play & download",
    body: "Listen in the player, read the staff, and grab the MIDI for your DAW or sheet app.",
  },
];

function PianoKeyStrip({ className = "" }) {
  return (
    <div
      className={`flex h-2.5 max-w-md gap-px overflow-hidden rounded-sm border border-white/10 bg-neutral-900 p-px ${className}`}
      aria-hidden
    >
      {Array.from({ length: 28 }).map((_, i) => {
        const isBlack = [1, 4, 8, 11, 15, 18, 22, 25].includes(i);
        return (
          <div
            key={i}
            className={`min-w-0 flex-1 rounded-[1px] ${
              isBlack ? "bg-neutral-800" : "bg-neutral-100"
            }`}
          />
        );
      })}
    </div>
  );
}

export default function Home() {
  const [songUrl, setSongUrl] = useState("");
  const [status, setStatus] = useState("idle"); // idle | pending | done | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [cleanLevel, setCleanLevel] = useState("regular"); // simple | regular

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
        body: JSON.stringify({ songUrl, cleanLevel }),
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
    <div className="relative flex min-h-screen flex-col bg-neutral-950 font-sans">
      <FloatingNotes />
      <header className="relative z-20 sticky top-0 border-b border-white/10 bg-neutral-950/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 md:px-6">
          <div className="flex items-center gap-3">
            <div
              className="flex h-9 w-9 items-center justify-center rounded-md border border-white/15 bg-white text-sm font-semibold text-neutral-950 shadow-[0_1px_0_rgb(255_255_255_/_0.06)_inset]"
              aria-hidden
            >
              ♫
            </div>
            <div>
              <p className="text-sm font-semibold tracking-tight text-neutral-100">
                Sonata
              </p>
              <p className="text-xs text-neutral-500">
                Paste a link. Get a piano sheet.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <a
              href="#convert"
              className="hidden text-sm font-medium text-neutral-400 transition hover:text-white sm:inline"
            >
              Try it
            </a>
            <AuthButtons />
          </div>
        </div>
      </header>

      <main className="relative z-10 flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden border-b border-white/10">
          <div
            className="pointer-events-none absolute inset-0 opacity-[0.035]"
            style={{
              backgroundImage: `linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)`,
              backgroundSize: "4rem 4rem",
            }}
            aria-hidden
          />
          <div className="relative mx-auto max-w-6xl px-4 pb-20 pt-16 md:px-6 md:pb-28 md:pt-20 lg:pt-24">
            <p className="text-center text-xs font-medium uppercase tracking-[0.2em] text-neutral-500 md:text-left">
              AI-assisted piano transcription
            </p>
            <div className="mx-auto mt-6 max-w-4xl text-center md:mx-0 md:text-left">
              <TypewriterHeadline className="text-[1.65rem] leading-[1.15] sm:text-4xl sm:leading-tight md:text-5xl md:leading-[1.1] lg:text-6xl lg:leading-[1.08]" />
            </div>
            <div className="mx-auto mt-8 flex justify-center md:justify-start">
              <PianoKeyStrip />
            </div>
            <p className="mx-auto mt-8 max-w-2xl text-center text-base leading-relaxed text-neutral-400 md:mx-0 md:text-left md:text-lg">
              Turn songs from the web into weighted, playable piano MIDI — with a
              built-in player, staff view, and a choice between a lean arrangement
              and a fuller one.
            </p>
            <div className="mx-auto mt-10 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:justify-start">
              <a
                href="#convert"
                className="inline-flex items-center justify-center rounded-full bg-white px-8 py-3.5 text-sm font-semibold text-neutral-950 shadow-[0_0_0_1px_rgba(255,255,255,0.08)] transition hover:bg-neutral-200"
              >
                Convert a track
              </a>
              <a
                href="#features"
                className="inline-flex items-center justify-center rounded-full border border-white/25 px-8 py-3.5 text-sm font-medium text-neutral-100 transition hover:border-white/50 hover:bg-white/5"
              >
                See what you get
              </a>
            </div>
          </div>
        </section>

        {/* Converter */}
        <section id="convert" className="scroll-mt-24 border-b border-white/10 py-16 md:py-20">
          <div className="mx-auto max-w-6xl px-4 md:px-6">
            <div className="max-w-2xl">
              <h2 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
                Try it now
              </h2>
              <p className="mt-2 text-neutral-400">
                No signup required. Drop a URL, pick a mode, and open your MIDI in
                seconds.
              </p>
            </div>
            <div className="mt-10 max-w-3xl">
              <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4 text-neutral-950 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.65)] md:p-7">
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <label
                      htmlFor="songUrl"
                      className="block text-sm font-medium text-neutral-900"
                    >
                      Song link
                    </label>
                    <input
                      id="songUrl"
                      type="url"
                      placeholder="Paste a YouTube link, audio URL, etc."
                      value={songUrl}
                      onChange={(event) => setSongUrl(event.target.value)}
                      className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-2.5 text-sm text-neutral-950 outline-none ring-0 transition focus:border-neutral-950 focus:ring-1 focus:ring-neutral-950"
                    />
                    <p className="text-xs text-neutral-500">
                      We&apos;ll fetch the audio on the server. Nothing is stored
                      unless you are signed in.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label
                      htmlFor="cleanLevel"
                      className="block text-sm font-medium text-neutral-900"
                    >
                      Mode
                    </label>
                    <select
                      id="cleanLevel"
                      value={cleanLevel}
                      onChange={(event) => setCleanLevel(event.target.value)}
                      className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-2.5 text-sm text-neutral-950 outline-none ring-0 transition focus:border-neutral-950 focus:ring-1 focus:ring-neutral-950"
                    >
                      <option value="simple">
                        Simple — cleaner, fewer notes
                      </option>
                      <option value="regular">Regular — balanced detail</option>
                    </select>
                    <p className="text-xs text-neutral-500">
                      Choose a cleaner arrangement or a fuller balanced one.
                    </p>
                  </div>

                  {error && (
                    <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-900">
                      {error}
                    </p>
                  )}

                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <button
                      type="submit"
                      disabled={status === "pending"}
                      className="inline-flex items-center justify-center rounded-full bg-neutral-950 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-400"
                    >
                      {status === "pending"
                        ? "Converting..."
                        : "Convert to piano sheet"}
                    </button>
                    <p className="text-xs text-neutral-500">
                      Early preview — quality and speed will keep improving.
                    </p>
                  </div>
                </form>

                {result && (
                  <div className="mt-6 border-t border-neutral-200 pt-5">
                    <h3 className="text-sm font-semibold text-neutral-900">
                      Your conversion
                    </h3>
                    <p className="mt-1 break-all text-xs text-neutral-500">
                      {result.songUrl}
                    </p>
                    <div className="mt-4 flex flex-col gap-3">
                      {result.midiUrl && (
                        <MidiPlayer
                          url={result.midiUrl}
                          timeSignature={result.timeSignature}
                        />
                      )}
                      <div className="flex flex-wrap gap-3">
                        {result.pdfUrl && (
                          <a
                            href={result.pdfUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center justify-center rounded-full border border-neutral-400 bg-white px-3 py-1.5 text-xs font-medium text-neutral-900 transition hover:border-neutral-950 hover:bg-neutral-100"
                          >
                            Download PDF
                          </a>
                        )}
                        {result.midiUrl && (
                          <a
                            href={result.midiUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center justify-center rounded-full border border-neutral-400 bg-white px-3 py-1.5 text-xs font-medium text-neutral-900 transition hover:border-neutral-950 hover:bg-neutral-100"
                          >
                            Download MIDI
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Features */}
        <section
          id="features"
          className="scroll-mt-24 border-b border-white/10 py-20 md:py-28"
        >
          <div className="mx-auto max-w-6xl px-4 md:px-6">
            <div className="max-w-2xl">
              <h2 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
                Everything on one landing strip
              </h2>
              <p className="mt-3 text-neutral-400 md:text-lg">
                Built for quick tries and for when you want to keep a library of
                your arrangements.
              </p>
            </div>
            <ul className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:gap-5">
              {FEATURES.map(({ title, body }) => (
                <li
                  key={title}
                  className="group rounded-2xl border border-white/10 bg-neutral-900/40 p-6 transition hover:border-white/20 hover:bg-neutral-900/70"
                >
                  <div className="mb-4 h-px w-8 bg-white/30 transition group-hover:w-12 group-hover:bg-white/50" />
                  <h3 className="text-base font-semibold text-white">{title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-neutral-400">
                    {body}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* How it works — ivory panel */}
        <section className="border-b border-white/10 py-20 md:py-28">
          <div className="mx-auto max-w-6xl px-4 md:px-6">
            <div className="rounded-3xl border border-neutral-200 bg-neutral-50 px-6 py-12 text-neutral-950 shadow-[0_24px_80px_-24px_rgba(0,0,0,0.55)] md:px-12 md:py-16">
              <h2 className="text-center text-2xl font-semibold tracking-tight md:text-3xl">
                How it works
              </h2>
              <p className="mx-auto mt-3 max-w-xl text-center text-neutral-600">
                Three steps from link to listening at the piano.
              </p>
              <ol className="mt-12 grid gap-10 md:grid-cols-3 md:gap-8">
                {STEPS.map(({ step, title, body }) => (
                  <li key={step} className="text-center md:text-left">
                    <span className="font-mono text-xs font-medium text-neutral-400">
                      {step}
                    </span>
                    <h3 className="mt-2 text-lg font-semibold text-neutral-900">
                      {title}
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-neutral-600">
                      {body}
                    </p>
                  </li>
                ))}
              </ol>
              <div className="mt-12 flex justify-center">
                <a
                  href="#convert"
                  className="inline-flex rounded-full bg-neutral-950 px-8 py-3 text-sm font-semibold text-white transition hover:bg-neutral-800"
                >
                  Start with your link
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="relative z-10 border-t border-white/10 py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 px-4 text-center text-sm text-neutral-500 md:flex-row md:px-6 md:text-left">
          <div className="flex items-center gap-2">
            <span
              className="flex h-7 w-7 items-center justify-center rounded border border-white/15 bg-white text-xs font-semibold text-neutral-950"
              aria-hidden
            >
              ♫
            </span>
            <span className="font-medium text-neutral-300">Sonata</span>
          </div>
          <p className="max-w-md">
            Transcription is automated and best treated as a starting point for
            practice and arranging — not a substitute for a human copyist.
          </p>
        </div>
      </footer>
    </div>
  );
}
