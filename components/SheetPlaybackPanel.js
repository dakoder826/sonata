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
  songUrl = "",
  createdAt = "",
  midiUrl = "",
  rawMidiUrl = "",
  pdfUrl = "",
  timeSignature = "4/4",
}) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-neutral-900">{title}</h3>
        {songUrl ? (
          <p className="mt-1 break-all text-xs text-neutral-500">{songUrl}</p>
        ) : null}
        {createdAt ? (
          <p className="mt-1 text-xs text-neutral-500">
            Created {formatDate(createdAt)}
          </p>
        ) : null}
      </div>

      {midiUrl ? <MidiPlayer url={midiUrl} timeSignature={timeSignature} /> : null}

      <div className="flex flex-wrap gap-3">
        {pdfUrl ? (
          <a
            href={pdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center rounded-full border border-neutral-400 bg-white px-3 py-1.5 text-xs font-medium text-neutral-900 transition hover:border-neutral-950 hover:bg-neutral-100"
          >
            Open Sheet (PDF)
          </a>
        ) : null}
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
