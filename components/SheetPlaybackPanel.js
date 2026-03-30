"use client";

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
        <h3 className="text-sm font-semibold text-neutral-900">{title}</h3>

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
          enablePdfDownload
          pdfFileName={pdfFileName}
        />
      ) : null}

      <div className="flex flex-wrap gap-3">
        {midiUrl ? (
          <a
            href={midiUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center rounded-full border border-neutral-400 bg-white px-3 py-1.5 text-xs font-medium text-neutral-900 transition hover:border-neutral-950 hover:bg-neutral-100"
          >
            Download MIDI
          </a>
        ) : null}
        {rawMidiUrl ? (
          <a
            href={rawMidiUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center rounded-full border border-neutral-400 bg-white px-3 py-1.5 text-xs font-medium text-neutral-900 transition hover:border-neutral-950 hover:bg-neutral-100"
          >
            Download raw MIDI
          </a>
        ) : null}
      </div>
    </div>
  );
}
