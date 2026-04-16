"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
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
  const { data: session } = useSession();
  const [sheetName, setSheetName] = useState("");
  const [songUrl, setSongUrl] = useState("");
  const [cleanLevel, setCleanLevel] = useState("regular");
  const [status, setStatus] = useState("idle");
  const [createError, setCreateError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isUpgradeModalOpen, setIsUpgradeModalOpen] = useState(false);
  const [history, setHistory] = useState([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [editingSheetId, setEditingSheetId] = useState("");
  const [draftSheetName, setDraftSheetName] = useState("");
  const [renamingSheetId, setRenamingSheetId] = useState("");
  const [renameError, setRenameError] = useState("");
  const [deletingSheetId, setDeletingSheetId] = useState("");
  const [entitlement, setEntitlement] = useState(null);
  const [billingAction, setBillingAction] = useState("");

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
      setEntitlement(data?.entitlement ?? null);
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
    if (isCreateDisabled) {
      setIsCreateModalOpen(false);
      setIsUpgradeModalOpen(true);
      return;
    }

    event.preventDefault();
    setCreateError("");

    if (!songUrl.trim()) {
      setCreateError("Please paste a song link first.");
      return;
    }
    if (!sheetName.trim()) {
      setCreateError("Please give your sheet a name.");
      return;
    }

    setStatus("pending");
    try {
      const response = await fetch("/api/transcriptions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sheetName, songUrl, cleanLevel }),
      });

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        if (data?.code === "limit_reached_free_plan") {
          setIsCreateModalOpen(false);
          setIsUpgradeModalOpen(true);
          await loadHistory();
          return;
        }
        throw new Error(data?.error || "Failed to create piano sheet.");
      }

      setSheetName("");
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
  const planTier = session?.user?.planTier === "pro" ? "pro" : "free";
  const activeSheetCount =
    typeof entitlement?.activeSheetCount === "number"
      ? entitlement.activeSheetCount
      : history.filter((item) =>
          ["processing", "completed"].includes(item.status || "completed"),
        ).length;
  const isCreateDisabled = planTier !== "pro" && activeSheetCount >= 1;

  async function startBillingNavigation(endpoint, action) {
    setBillingAction(action);
    try {
      const response = await fetch(endpoint, { method: "POST" });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.url) {
        throw new Error(data?.error || "Unable to continue to billing.");
      }
      window.location.href = data.url;
    } catch (error) {
      if (isUpgradeModalOpen) {
        window.alert(error.message || "Unable to continue to billing.");
      }
      setCreateError(error.message || "Unable to continue to billing.");
      setBillingAction("");
    }
  }

  function handleOpenCreateFlow() {
    setCreateError("");
    if (isCreateDisabled) {
      setIsUpgradeModalOpen(true);
      return;
    }
    setIsCreateModalOpen(true);
  }

  function beginRename(event, item) {
    event.preventDefault();
    event.stopPropagation();
    setRenameError("");
    setEditingSheetId(item.id);
    setDraftSheetName(item.sheet_name || item.sheetName || "");
  }

  function cancelRename(event) {
    event.preventDefault();
    event.stopPropagation();
    setEditingSheetId("");
    setDraftSheetName("");
    setRenameError("");
  }

  async function saveRename(event, itemId) {
    event.preventDefault();
    event.stopPropagation();
    const normalized = draftSheetName.trim();
    if (!normalized) {
      setRenameError("Sheet name cannot be empty.");
      return;
    }
    setRenameError("");
    setRenamingSheetId(itemId);
    try {
      const response = await fetch("/api/transcriptions", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: itemId, sheetName: normalized }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || "Failed to rename sheet.");
      }
      const nextName = data?.sheetName || normalized;
      setHistory((prev) =>
        prev.map((entry) =>
          entry.id === itemId
            ? { ...entry, sheet_name: nextName, sheetName: nextName }
            : entry,
        ),
      );
      setEditingSheetId("");
      setDraftSheetName("");
    } catch (err) {
      setRenameError(err.message || "Failed to rename sheet.");
    } finally {
      setRenamingSheetId("");
    }
  }

  async function deleteSheet(event, itemId) {
    event.preventDefault();
    event.stopPropagation();
    setCreateError("");
    setDeletingSheetId(itemId);
    try {
      const response = await fetch("/api/transcriptions", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: itemId }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || "Failed to delete sheet.");
      }
      setHistory((prev) => prev.filter((entry) => entry.id !== itemId));
      await loadHistory();
    } catch (error) {
      setCreateError(error.message || "Failed to delete sheet.");
    } finally {
      setDeletingSheetId("");
    }
  }

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
              onClick={handleOpenCreateFlow}
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
                {item.midi_url || item.midiUrl ? (
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
                {editingSheetId === item.id ? (
                  <form
                    className="space-y-2"
                    onSubmit={(event) => saveRename(event, item.id)}
                  >
                    <input
                      type="text"
                      value={draftSheetName}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onChange={(event) =>
                        setDraftSheetName(event.target.value)
                      }
                      className="w-full rounded-lg border border-white/30 bg-black/30 px-2.5 py-1.5 text-sm font-semibold text-white ring-0 transition outline-none focus:border-white focus:ring-1 focus:ring-white"
                      autoFocus
                    />
                    <div className="flex items-center gap-2">
                      <button
                        type="submit"
                        disabled={renamingSheetId === item.id}
                        className="rounded-full border border-white/25 px-2.5 py-1 text-[11px] font-medium text-white transition hover:border-white/45 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {renamingSheetId === item.id ? "Saving..." : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={cancelRename}
                        className="rounded-full border border-white/20 px-2.5 py-1 text-[11px] font-medium text-neutral-300 transition hover:border-white/35 hover:text-white"
                      >
                        Cancel
                      </button>
                    </div>
                    {renameError ? (
                      <p className="text-[11px] font-medium text-red-300">
                        {renameError}
                      </p>
                    ) : null}
                  </form>
                ) : (
                  <div className="flex items-center gap-2">
                    <h3 className="line-clamp-1 text-sm font-semibold text-white">
                      {item.sheet_name || item.sheetName || "Untitled sheet"}
                    </h3>
                    <button
                      type="button"
                      aria-label="Rename sheet"
                      onClick={(event) => beginRename(event, item)}
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/15 text-xs text-neutral-300 opacity-0 transition group-hover:opacity-100 hover:border-white/40 hover:text-white"
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      aria-label="Delete sheet"
                      onClick={(event) => deleteSheet(event, item.id)}
                      disabled={deletingSheetId === item.id}
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-red-300/25 text-red-200 opacity-0 transition group-hover:opacity-100 hover:border-red-300/60 hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-80"
                    >
                      {deletingSheetId === item.id ? (
                        <span className="text-sm leading-none">...</span>
                      ) : (
                        <svg
                          viewBox="0 0 24 24"
                          className="h-3.5 w-3.5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M3 6h18" />
                          <path d="M8 6V4h8v2" />
                          <path d="M6 6l1 14h10l1-14" />
                          <path d="M10 11v6" />
                          <path d="M14 11v6" />
                        </svg>
                      )}
                    </button>
                  </div>
                )}
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
                className="rounded-full border border-neutral-300 px-2 py-1 text-sm text-neutral-700 transition hover:cursor-pointer hover:border-neutral-500 hover:text-neutral-950"
              >
                Close
              </button>
            </div>

            <SheetCreationForm
              sheetName={sheetName}
              onSheetNameChange={setSheetName}
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
            {planTier !== "pro" ? (
              <p className="mt-3 text-xs text-neutral-600">
                Free plan includes 1 active sheet at a time. Upgrade for
                unlimited sheets.
              </p>
            ) : null}
          </div>
        </div>
      )}

      {isUpgradeModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-lg rounded-2xl border border-emerald-300/40 bg-neutral-950 p-6 text-neutral-100 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.75)]">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-semibold text-white">
                You reached your free limit ({activeSheetCount}/1)
              </h2>
              <button
                type="button"
                onClick={() => setIsUpgradeModalOpen(false)}
                className="rounded-full border border-white/20 px-2 py-1 text-sm text-neutral-300 transition hover:cursor-pointer hover:border-white/50 hover:text-white"
              >
                Close
              </button>
            </div>
            <p className="text-sm text-neutral-300">
              Upgrade to Sonata Pro to unlock{" "}
              <span className="font-semibold text-white">
                unlimited sheet generations
              </span>{" "}
              and active sheets.
            </p>
            <div className="mt-4 rounded-xl border border-emerald-300/30 bg-emerald-500/10 p-4">
              <p className="text-sm font-semibold text-emerald-100">
                Start with a 7-day free trial
              </p>
              <p className="mt-1 text-xs text-emerald-50/90">
                Then continue at $8.99/month. Cancel anytime in billing settings.
              </p>
            </div>
            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() =>
                  startBillingNavigation("/api/billing/checkout", "checkout")
                }
                className="inline-flex rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-neutral-950 transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-75"
                disabled={billingAction === "checkout"}
              >
                {billingAction === "checkout"
                  ? "Opening checkout..."
                  : "Upgrade to Pro"}
              </button>
              <button
                type="button"
                onClick={() => setIsUpgradeModalOpen(false)}
                className="inline-flex rounded-full border border-white/25 px-5 py-2.5 text-sm font-medium text-white transition hover:border-white/50 hover:bg-white/10"
              >
                Maybe later
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
