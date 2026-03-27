"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import SheetCreationForm from "@/components/SheetCreationForm";
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

export default function SheetsWorkspace({ userEmail = "" }) {
  const [songUrl, setSongUrl] = useState("");
  const [cleanLevel, setCleanLevel] = useState("regular");
  const [status, setStatus] = useState("idle");
  const [createError, setCreateError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [history, setHistory] = useState([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);

  const loadHistory = useCallback(async () => {
    setIsLoadingHistory(true);
    setLoadError("");
    try {
      const response = await fetch("/api/transcriptions", {
        cache: "no-store",
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.error || "Failed to load your saved sheets.");
      }

      setHistory(Array.isArray(data?.items) ? data.items : []);
    } catch (err) {
      setLoadError(err.message || "Failed to load your saved sheets.");
    } finally {
      setIsLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  async function handleCreateSheet(event) {
    event.preventDefault();
    setCreateError("");

    if (!songUrl.trim()) {
      setCreateError("Please paste a song link first.");
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

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || "Failed to create piano sheet.");
      }

      setSongUrl("");
      setCleanLevel("regular");
      await loadHistory();
      setIsCreateModalOpen(false);
      setStatus("done");
    } catch (err) {
      setStatus("error");
      setCreateError(err.message || "Failed to create piano sheet.");
    } finally {
      setStatus("idle");
    }
  }

  const hasSheets = useMemo(() => history.length > 0, [history]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 py-8 md:px-6 md:py-10">
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
            Saved sheets
          </h2>
          <div className="flex items-center gap-3">
            {isLoadingHistory && (
              <span className="text-xs text-neutral-500">Loading...</span>
            )}
            <button
              type="button"
              onClick={() => setIsCreateModalOpen(true)}
              className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-white bg-white text-2xl leading-none text-neutral-950 transition hover:cursor-pointer hover:bg-black hover:text-white"
              aria-label="Create new sheet"
            >
              +
            </button>
          </div>
        </div>

        {loadError && (
          <div className="mb-4 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
            {loadError}
          </div>
        )}

        {!isLoadingHistory && !hasSheets && (
          <div className="rounded-2xl border border-white/10 bg-neutral-900/40 p-6 text-sm text-neutral-400">
            No sheets saved yet. Use the + button to create your first one.
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {history.map((item) => (
            <Link
              key={item.id}
              href={`/sheets/${item.id}`}
              className="group overflow-hidden rounded-2xl border border-white/10 bg-neutral-900/40 transition hover:border-white/30 hover:bg-neutral-900/70"
            >
              <div className="aspect-4/3 border-b border-white/10 bg-neutral-950">
                {(item.midi_url || item.midiUrl) ? (
                  <div className="pointer-events-none h-full overflow-hidden p-2">
                    <div className="h-[145%] w-[145%] origin-top-left scale-[0.69]">
                      <MidiPlayer
                        url={item.midi_url || item.midiUrl}
                        timeSignature={
                          item.time_signature || item.timeSignature || "4/4"
                        }
                        notationOnly
                      />
                    </div>
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center px-3 text-center text-sm text-neutral-500">
                    No staff notation preview available yet
                  </div>
                )}
              </div>

              <div className="space-y-2 p-4">
                <p className="line-clamp-2 text-sm text-neutral-200 group-hover:text-white">
                  {item.song_url || item.songUrl}
                </p>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-neutral-500 capitalize">
                    {item.status || "completed"}
                  </span>
                  <span className="text-xs text-neutral-500">
                    {formatDate(item.created_at)}
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-lg rounded-2xl border border-neutral-200 bg-neutral-50 p-6 text-neutral-950 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.65)]">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-semibold text-neutral-950">
                Create piano sheet
              </h2>
              <button
                type="button"
                onClick={() => setIsCreateModalOpen(false)}
                className="rounded-full border border-neutral-300 px-2 py-1 text-sm text-neutral-700 transition hover:border-neutral-500 hover:text-neutral-950"
              >
                Close
              </button>
            </div>

            <SheetCreationForm
              songUrl={songUrl}
              onSongUrlChange={setSongUrl}
              cleanLevel={cleanLevel}
              onCleanLevelChange={setCleanLevel}
              onSubmit={handleCreateSheet}
              status={status}
              error={createError}
              submitLabel="Create piano sheet"
              submittingLabel="Creating sheet..."
              submitButtonClassName="inline-flex items-center justify-center rounded-full bg-neutral-950 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>
        </div>
      )}
    </div>
  );
}
