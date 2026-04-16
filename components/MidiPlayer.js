"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as Tone from "tone";
import { Midi } from "@tonejs/midi";
import StaffNotation from "./StaffNotation";

function dedupeNearSimultaneousSamePitch(noteList, timeTolSec = 0.001) {
  if (!Array.isArray(noteList) || noteList.length === 0) return [];
  const sorted = [...noteList].sort((a, b) => {
    const dt = (a.time || 0) - (b.time || 0);
    if (dt !== 0) return dt;
    return (a.midi ?? 0) - (b.midi ?? 0);
  });
  const out = [];
  for (const n of sorted) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.midi === n.midi &&
      Math.abs((n.time || 0) - (prev.time || 0)) < timeTolSec
    ) {
      const pd = prev.duration || 0;
      const nd = n.duration || 0;
      if (nd > pd) out[out.length - 1] = { ...prev, ...n, duration: nd };
      continue;
    }
    out.push(n);
  }
  return out;
}

const DEFAULT_SECONDS_PER_BEAT = 0.5;

function parseTimeSignatureForLayout(ts) {
  const m = String(ts ?? "4/4")
    .trim()
    .match(/^(\d+)\s*\/\s*(\d+)$/);
  const num = m ? Math.max(1, Math.min(16, parseInt(m[1], 10))) : 4;
  const den = m ? Math.max(1, Math.min(32, parseInt(m[2], 10))) : 4;
  const beatsPerMeasure = den === 4 || den === 2 ? num : 4;
  return { beatsPerMeasure };
}

function durationToCode(sec, secPerBeat = DEFAULT_SECONDS_PER_BEAT) {
  const beats = sec / secPerBeat;
  if (beats <= 0.25) return "16";
  if (beats <= 0.5) return "8";
  if (beats <= 1) return "q";
  if (beats <= 2) return "h";
  return "w";
}

function codeToBeats(code) {
  switch (code) {
    case "16":
      return 0.25;
    case "8":
      return 0.5;
    case "q":
      return 1;
    case "h":
      return 2;
    case "w":
      return 4;
    default:
      return 1;
  }
}

function fitDurationBeats(sec, beatsRemaining, secPerBeat) {
  const candidates = [
    ["w", 4],
    ["h", 2],
    ["q", 1],
    ["8", 0.5],
    ["16", 0.25],
  ];
  const target = codeToBeats(durationToCode(sec, secPerBeat));
  let best = null;
  for (const [, beats] of candidates) {
    if (beats > beatsRemaining + 1e-6) continue;
    const score = Math.abs(beats - target);
    if (!best || score < best.score) best = { beats, score };
  }
  return best ? best.beats : Math.min(0.25, beatsRemaining);
}

function sanitizePlayableNotesForStaffAndAudio(
  noteList,
  secPerBeat,
  timeSignature,
) {
  if (!Array.isArray(noteList) || noteList.length === 0) return [];
  const spb =
    Number.isFinite(secPerBeat) && secPerBeat > 0
      ? secPerBeat
      : DEFAULT_SECONDS_PER_BEAT;
  const { beatsPerMeasure } = parseTimeSignatureForLayout(timeSignature);
  const grid = spb / 4;
  const chordEps = grid * 0.42;

  // Keep index references so we can return exact original note objects.
  const indexed = noteList.map((n, idx) => ({ ...n, __idx: idx }));
  const kept = new Set();

  function processHand(sourceNotes) {
    const byMeasure = new Map();
    for (const n of sourceNotes) {
      const beat = (Number(n.time) || 0) / spb;
      const measureIdx = Math.max(0, Math.floor(beat / beatsPerMeasure));
      if (!byMeasure.has(measureIdx)) byMeasure.set(measureIdx, []);
      byMeasure.get(measureIdx).push({
        ...n,
        localTime: (beat - measureIdx * beatsPerMeasure) * spb,
      });
    }

    for (const [, measureNotes] of byMeasure) {
      const sorted = [...measureNotes].sort(
        (a, b) => a.localTime - b.localTime,
      );
      let beatsUsed = 0;
      let i = 0;
      while (i < sorted.length && beatsUsed < beatsPerMeasure) {
        const t = sorted[i].localTime;
        const chord = sorted.filter(
          (n) => n.localTime >= t - chordEps && n.localTime <= t + chordEps,
        );
        const dur = chord.reduce(
          (s, n) => Math.max(s, Number(n.duration) || 0),
          0,
        );
        const beatsRemaining = Math.max(0, beatsPerMeasure - beatsUsed);
        if (beatsRemaining <= 1e-6) {
          i += chord.length;
          continue;
        }

        const hasRenderable = chord.some(
          (n) =>
            Number.isFinite(Number(n.midi)) ||
            (typeof n.name === "string" && n.name.trim().length > 0),
        );
        if (!hasRenderable) {
          i += chord.length;
          continue;
        }

        for (const n of chord) kept.add(n.__idx);
        beatsUsed += fitDurationBeats(dur, beatsRemaining, spb);
        i += chord.length;
      }
    }
  }

  processHand(indexed.filter((n) => (Number(n.midi) || 0) >= 60));
  processHand(indexed.filter((n) => (Number(n.midi) || 0) < 60));

  return indexed
    .filter((n) => kept.has(n.__idx))
    .map(({ __idx, ...n }) => n)
    .sort((a, b) => (a.time || 0) - (b.time || 0));
}

function smoothDurationsForPlayback(noteList, secPerBeat) {
  if (!Array.isArray(noteList) || noteList.length === 0) return [];
  const spb =
    Number.isFinite(secPerBeat) && secPerBeat > 0
      ? secPerBeat
      : DEFAULT_SECONDS_PER_BEAT;
  const maxBridgeGap = Math.min(0.16, spb * 0.45);
  const releasePad = 0.012;
  const sorted = noteList
    .map((n) => ({
      ...n,
      time: Math.max(0, Number(n.time) || 0),
      duration: Math.max(0.02, Number(n.duration) || 0.02),
    }))
    .sort((a, b) => (a.time || 0) - (b.time || 0));
  const out = sorted.map((n) => ({ ...n }));
  for (let i = 0; i < out.length; i += 1) {
    const n = out[i];
    const nEnd = n.time + n.duration;
    const nMidi = Number(n.midi) || 0;
    const thisIsRight = nMidi >= 60;
    let next = null;
    for (let j = i + 1; j < out.length; j += 1) {
      const c = out[j];
      const cMidi = Number(c.midi) || 0;
      if (cMidi >= 60 === thisIsRight) {
        next = c;
        break;
      }
    }
    if (!next) continue;
    const gap = next.time - nEnd;
    if (gap > 0 && gap <= maxBridgeGap) {
      const bridgedEnd = Math.min(
        next.time - releasePad,
        nEnd + Math.max(0.01, gap * 0.88),
      );
      n.duration = Math.max(0.02, bridgedEnd - n.time);
    }
  }
  return out;
}

// Flatten all notes from all tracks with absolute time, for display
function flattenNotes(midi) {
  const notes = [];
  midi.tracks.forEach((track) => {
    track.notes.forEach((note) => {
      notes.push({
        time: note.time,
        duration: note.duration,
        name: note.name,
        velocity: note.velocity,
        midi: note.midi ?? noteToMidi(note.name),
      });
    });
  });
  notes.sort((a, b) => a.time - b.time);
  if (!notes.length) return notes;
  // Trim leading empty space so the playhead starts where notes actually begin.
  const firstTime = Math.max(0, notes[0].time || 0);
  const shifted =
    firstTime > 0
      ? notes.map((n) => ({ ...n, time: Math.max(0, n.time - firstTime) }))
      : notes;
  return shifted;
}

function buildOnsetTimeline(noteList, timeTolSec = 0.001) {
  if (!Array.isArray(noteList) || noteList.length === 0) return [];
  const sortedTimes = noteList
    .map((n) => Math.max(0, Number(n?.time) || 0))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  const out = [];
  for (const t of sortedTimes) {
    const prev = out[out.length - 1];
    if (prev != null && Math.abs(t - prev) <= timeTolSec) continue;
    out.push(t);
  }
  return out;
}

function snapToLatestOnset(onsets, timeSec, timeTolSec = 0.001) {
  const t = Math.max(0, Number(timeSec) || 0);
  if (!Array.isArray(onsets) || onsets.length === 0) return t;
  if (t <= onsets[0] + timeTolSec) return onsets[0];
  const last = onsets[onsets.length - 1];
  if (t >= last) return last;

  let lo = 0;
  let hi = onsets.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (onsets[mid] <= t + timeTolSec) lo = mid + 1;
    else hi = mid - 1;
  }
  return onsets[Math.max(0, hi)] ?? t;
}

function timeSignatureFromMidi(midi) {
  try {
    const list = midi.header?.timeSignatures;
    if (list && list.length > 0) {
      const ts = list[0].timeSignature;
      if (Array.isArray(ts) && ts.length >= 2) {
        return `${ts[0]}/${ts[1]}`;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

const FIFTHS_TO_MAJOR = {
  "-7": "Cb",
  "-6": "Gb",
  "-5": "Db",
  "-4": "Ab",
  "-3": "Eb",
  "-2": "Bb",
  "-1": "F",
  0: "C",
  1: "G",
  2: "D",
  3: "A",
  4: "E",
  5: "B",
  6: "F#",
  7: "C#",
};

const FIFTHS_TO_MINOR = {
  "-7": "Abm",
  "-6": "Ebm",
  "-5": "Bbm",
  "-4": "Fm",
  "-3": "Cm",
  "-2": "Gm",
  "-1": "Dm",
  0: "Am",
  1: "Em",
  2: "Bm",
  3: "F#m",
  4: "C#m",
  5: "G#m",
  6: "D#m",
  7: "A#m",
};

const COMMON_VEX_KEYS = new Set([
  "C",
  "G",
  "D",
  "A",
  "E",
  "B",
  "F#",
  "C#",
  "F",
  "Bb",
  "Eb",
  "Ab",
  "Db",
  "Gb",
  "Cb",
  "Am",
  "Em",
  "Bm",
  "F#m",
  "C#m",
  "G#m",
  "D#m",
  "A#m",
  "Dm",
  "Gm",
  "Cm",
  "Fm",
  "Bbm",
  "Ebm",
  "Abm",
]);

function normalizeKeyNameForVexFlow(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^([A-Ga-g])([#b]?)(m?)$/);
  if (!m) return null;
  const normalized = `${m[1].toUpperCase()}${m[2] || ""}${m[3] || ""}`;
  return COMMON_VEX_KEYS.has(normalized) ? normalized : null;
}

function keySignatureFromMidi(midi) {
  try {
    const list = midi.header?.keySignatures;
    if (!list || list.length === 0) return null;
    const ks = list[0] || {};

    if (typeof ks.key === "string") {
      const normalized = normalizeKeyNameForVexFlow(ks.key);
      if (normalized) return normalized;
    }

    const fifths = Number(ks.key);
    const scale = Number(ks.scale);
    if (Number.isFinite(fifths) && fifths >= -7 && fifths <= 7) {
      const table = scale === 1 ? FIFTHS_TO_MINOR : FIFTHS_TO_MAJOR;
      return table[String(fifths)] ?? null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

const KEY_CANDIDATES = [
  ["C", [0, 2, 4, 5, 7, 9, 11]],
  ["G", [7, 9, 11, 0, 2, 4, 6]],
  ["D", [2, 4, 6, 7, 9, 11, 1]],
  ["A", [9, 11, 1, 2, 4, 6, 8]],
  ["E", [4, 6, 8, 9, 11, 1, 3]],
  ["B", [11, 1, 3, 4, 6, 8, 10]],
  ["F#", [6, 8, 10, 11, 1, 3, 5]],
  ["C#", [1, 3, 5, 6, 8, 10, 0]],
  ["F", [5, 7, 9, 10, 0, 2, 4]],
  ["Bb", [10, 0, 2, 3, 5, 7, 9]],
  ["Eb", [3, 5, 7, 8, 10, 0, 2]],
  ["Ab", [8, 10, 0, 1, 3, 5, 7]],
  ["Db", [1, 3, 5, 6, 8, 10, 0]],
  ["Gb", [6, 8, 10, 11, 1, 3, 5]],
  ["Cb", [11, 1, 3, 4, 6, 8, 10]],
  ["Am", [9, 11, 0, 2, 4, 5, 7]],
  ["Em", [4, 6, 7, 9, 11, 0, 2]],
  ["Bm", [11, 1, 2, 4, 6, 7, 9]],
  ["F#m", [6, 8, 9, 11, 1, 2, 4]],
  ["C#m", [1, 3, 4, 6, 8, 9, 11]],
  ["G#m", [8, 10, 11, 1, 3, 4, 6]],
  ["D#m", [3, 5, 6, 8, 10, 11, 1]],
  ["A#m", [10, 0, 1, 3, 5, 6, 8]],
  ["Dm", [2, 4, 5, 7, 9, 10, 0]],
  ["Gm", [7, 9, 10, 0, 2, 3, 5]],
  ["Cm", [0, 2, 3, 5, 7, 8, 10]],
  ["Fm", [5, 7, 8, 10, 0, 1, 3]],
  ["Bbm", [10, 0, 1, 3, 5, 6, 8]],
  ["Ebm", [3, 5, 6, 8, 10, 11, 1]],
  ["Abm", [8, 10, 11, 1, 3, 4, 6]],
];

function inferKeySignatureFromNotes(notes) {
  if (!Array.isArray(notes) || notes.length < 6) return null;
  const weights = Array(12).fill(0);
  for (const n of notes) {
    const midi = Number(n?.midi);
    if (!Number.isFinite(midi)) continue;
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    const dur = Math.max(0.05, Number(n?.duration) || 0.1);
    weights[pc] += dur;
  }

  let bestKey = null;
  let bestScore = -1;
  for (const [key, scalePcs] of KEY_CANDIDATES) {
    let score = 0;
    for (const pc of scalePcs) score += weights[pc] || 0;
    const tonicPc = scalePcs[0];
    score += (weights[tonicPc] || 0) * 0.18;
    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
    }
  }
  return bestKey;
}
function noteToMidi(name) {
  const match = String(name).match(/^([A-G]#?)(-?\d+)$/);
  if (!match) return 60;
  const [, step, octave] = match;
  const steps = {
    C: 0,
    "C#": 1,
    D: 2,
    "D#": 3,
    E: 4,
    F: 5,
    "F#": 6,
    G: 7,
    "G#": 8,
    A: 9,
    "A#": 10,
    B: 11,
  };
  return (parseInt(octave, 10) + 1) * 12 + (steps[step] ?? 0);
}

export default function MidiPlayer({
  url,
  timeSignature: timeSignatureProp,
  notationOnly = false,
  enablePdfDownload = false,
  pdfFileName = "piano-sheet.pdf",
  extraControls = null,
}) {
  const [isLoading, setIsLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState([]);
  const [timeSignature, setTimeSignature] = useState(
    timeSignatureProp?.trim() || "4/4",
  );
  const [keySignature, setKeySignature] = useState("C");
  const [secondsPerBeat, setSecondsPerBeat] = useState(0.5);
  const [currentTime, setCurrentTime] = useState(0);
  const [playheadTime, setPlayheadTime] = useState(0);
  const [totalDuration, setTotalDuration] = useState(0);
  const [isDownloadingPdf, setIsDownloadingPdf] = useState(false);
  const startOffsetRef = useRef(0);
  const playTimeoutRef = useRef(null);
  const lastUrlRef = useRef(null);
  const rafRef = useRef(null);
  const midiRef = useRef(null);
  const samplerRef = useRef(null);
  const partRef = useRef(null);
  const playbackNotesRef = useRef([]);
  const onsetTimesRef = useRef([]);
  const noteStartRef = useRef(0);
  const noteEndRef = useRef(0);
  const rootRef = useRef(null);

  const downloadNotationAsPdf = useCallback(async () => {
    if (isDownloadingPdf) return;
    setError("");
    setIsDownloadingPdf(true);

    try {
      const root = rootRef.current;
      const notationRoot = root?.querySelector('[data-staff-notation="true"]');
      const canvas = notationRoot?.querySelector("canvas");

      if (!canvas) {
        throw new Error("Staff notation is still loading. Please try again.");
      }

      const { jsPDF } = await import("jspdf");
      const canvasWidthPx = canvas.width || canvas.clientWidth;
      const canvasHeightPx = canvas.height || canvas.clientHeight;
      if (!canvasWidthPx || !canvasHeightPx) {
        throw new Error("Could not read notation dimensions for PDF export.");
      }

      const pdf = new jsPDF({
        orientation: "portrait",
        unit: "mm",
        format: "a4",
        compress: true,
      });
      const pageWidthMm = pdf.internal.pageSize.getWidth();
      const pageHeightMm = pdf.internal.pageSize.getHeight();
      const marginMm = 10;
      const drawWidthMm = Math.max(20, pageWidthMm - marginMm * 2);
      const drawHeightMm = Math.max(20, pageHeightMm - marginMm * 2);

      const sliceHeightPx = Math.max(
        1,
        Math.floor((drawHeightMm * canvasWidthPx) / drawWidthMm),
      );

      let sourceY = 0;
      let pageIndex = 0;
      while (sourceY < canvasHeightPx) {
        const currentSliceHeightPx = Math.min(
          sliceHeightPx,
          canvasHeightPx - sourceY,
        );
        const pageCanvas = document.createElement("canvas");
        pageCanvas.width = canvasWidthPx;
        pageCanvas.height = currentSliceHeightPx;
        const ctx = pageCanvas.getContext("2d");
        if (!ctx) {
          throw new Error("Failed to prepare PDF page image.");
        }

        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
        ctx.drawImage(
          canvas,
          0,
          sourceY,
          canvasWidthPx,
          currentSliceHeightPx,
          0,
          0,
          canvasWidthPx,
          currentSliceHeightPx,
        );

        const imageData = pageCanvas.toDataURL("image/png", 1.0);
        const renderedHeightMm =
          (currentSliceHeightPx * drawWidthMm) / canvasWidthPx;
        if (pageIndex > 0) {
          pdf.addPage("a4", "portrait");
        }
        pdf.addImage(
          imageData,
          "PNG",
          marginMm,
          marginMm,
          drawWidthMm,
          renderedHeightMm,
          undefined,
          "FAST",
        );

        sourceY += currentSliceHeightPx;
        pageIndex += 1;
      }
      const safeName = String(pdfFileName || "piano-sheet")
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .toLowerCase();
      const fileNameWithExt = safeName.endsWith(".pdf")
        ? safeName
        : `${safeName || "piano-sheet"}.pdf`;
      pdf.save(fileNameWithExt);
    } catch (err) {
      console.error("Failed to export staff notation PDF:", err);
      setError(err.message || "Failed to export PDF.");
    } finally {
      setIsDownloadingPdf(false);
    }
  }, [isDownloadingPdf, pdfFileName]);

  // Parse the MIDI as soon as we have a URL so that
  // - we can render the staff *before* playback
  // - note parsing is decoupled from audio playback success
  useEffect(() => {
    let cancelled = false;

    async function loadMidiFromUrl(midiUrl) {
      if (!midiUrl) return;
      try {
        // Avoid re-loading if we've already parsed this URL
        if (midiRef.current && lastUrlRef.current === midiUrl && notes.length) {
          if (
            midiRef.current.duration &&
            midiRef.current.duration !== totalDuration
          ) {
            setTotalDuration(midiRef.current.duration);
          }
          return;
        }

        const response = await fetch(midiUrl);
        if (!response.ok) {
          throw new Error("Failed to load MIDI file.");
        }
        const arrayBuffer = await response.arrayBuffer();
        const midi = new Midi(arrayBuffer);
        if (cancelled) return;

        midiRef.current = midi;
        lastUrlRef.current = midiUrl;

        const flatNotes = flattenNotes(midi);
        noteStartRef.current =
          flatNotes.length > 0
            ? Math.max(
                0,
                midi.tracks
                  .flatMap((t) => t.notes)
                  .reduce(
                    (m, n) => Math.min(m, n.time),
                    Number.POSITIVE_INFINITY,
                  ),
              )
            : 0;

        const fromMidi = timeSignatureFromMidi(midi);
        const resolvedTimeSignature =
          (timeSignatureProp && timeSignatureProp.trim()) || fromMidi || "4/4";
        setTimeSignature(resolvedTimeSignature);

        const keyFromMeta = keySignatureFromMidi(midi);
        const keyFromNotes = inferKeySignatureFromNotes(flatNotes);
        setKeySignature(keyFromMeta || keyFromNotes || "C");
        const bpmMeta = Number(midi.header?.tempos?.[0]?.bpm);
        const resolvedSecondsPerBeat =
          Number.isFinite(bpmMeta) && bpmMeta > 0 ? 60 / bpmMeta : 0.5;
        setSecondsPerBeat(resolvedSecondsPerBeat);
        // Use one shared note set for notation + playback so what users hear
        // and what they see stay aligned.
        const unifiedNotes = smoothDurationsForPlayback(
          flatNotes,
          resolvedSecondsPerBeat,
        );
        setNotes(unifiedNotes);
        playbackNotesRef.current = unifiedNotes;
        onsetTimesRef.current = buildOnsetTimeline(unifiedNotes);

        const fullDurationInit =
          unifiedNotes.length > 0
            ? unifiedNotes.reduce(
                (max, n) => Math.max(max, n.time + (n.duration || 0)),
                0,
              )
            : midi.duration || 0;
        noteEndRef.current = fullDurationInit;
        setTotalDuration(fullDurationInit);
        // Helpful for debugging end-to-end timing vs staff rendering
        // but safe in production as a low-frequency log.
        console.log("MidiPlayer loaded MIDI", {
          noteCount: unifiedNotes.length,
          firstTime: unifiedNotes[0]?.time ?? 0,
          lastEndTime: fullDurationInit,
        });
      } catch (err) {
        if (cancelled) return;
        console.error("Error loading MIDI for notation:", err);
        setError(err.message || "Failed to load MIDI for preview.");
      }
    }

    loadMidiFromUrl(url);

    return () => {
      cancelled = true;
    };
    // We intentionally do NOT depend on notes/totalDuration here to avoid loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, timeSignatureProp]);

  // Update currentTime during playback directly from the playback transport.
  useEffect(() => {
    if (!isPlaying || totalDuration <= 0) return;
    const tick = () => {
      const transport = Tone.getTransport();
      const t = (startOffsetRef.current ?? 0) + (transport.seconds ?? 0);
      const clamped = Math.max(0, Math.min(totalDuration, t));
      setCurrentTime(clamped);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [isPlaying, totalDuration]);

  async function playFrom(offsetSeconds) {
    if (!url) return;
    setError("");
    setIsLoading(true);

    try {
      await Tone.start();

      // At this point the MIDI should already be parsed by the url effect above.
      // If, for some reason, it isn't yet, fall back to loading it here so
      // playback still works.
      if (!midiRef.current || lastUrlRef.current !== url) {
        try {
          const response = await fetch(url);
          if (!response.ok) {
            throw new Error("Failed to load MIDI file.");
          }
          const arrayBuffer = await response.arrayBuffer();
          const midi = new Midi(arrayBuffer);
          midiRef.current = midi;
          lastUrlRef.current = url;

          const flatNotes = flattenNotes(midi);
          const fallbackTimeSignature =
            (timeSignatureProp && timeSignatureProp.trim()) ||
            timeSignatureFromMidi(midi) ||
            "4/4";
          setTimeSignature(fallbackTimeSignature);
          const bpmMeta = Number(midi.header?.tempos?.[0]?.bpm);
          const fallbackSecondsPerBeat =
            Number.isFinite(bpmMeta) && bpmMeta > 0 ? 60 / bpmMeta : 0.5;
          setSecondsPerBeat(fallbackSecondsPerBeat);
          const unifiedNotes = smoothDurationsForPlayback(
            flatNotes,
            fallbackSecondsPerBeat,
          );
          setNotes(unifiedNotes);
          playbackNotesRef.current = unifiedNotes;
          onsetTimesRef.current = buildOnsetTimeline(unifiedNotes);
          noteStartRef.current =
            flatNotes.length > 0
              ? Math.max(
                  0,
                  midi.tracks
                    .flatMap((t) => t.notes)
                    .reduce(
                      (m, n) => Math.min(m, n.time),
                      Number.POSITIVE_INFINITY,
                    ),
                )
              : 0;

          const fullDurationInit =
            unifiedNotes.length > 0
              ? unifiedNotes.reduce(
                  (max, n) => Math.max(max, n.time + (n.duration || 0)),
                  0,
                )
              : midi.duration || 0;
          noteEndRef.current = fullDurationInit;
          setTotalDuration(fullDurationInit);
        } catch (loadErr) {
          console.error("Fallback MIDI load failed:", loadErr);
          throw loadErr;
        }
      }

      const midi = midiRef.current;
      if (!midi) {
        throw new Error("No MIDI data to play.");
      }

      const fullDuration = Math.max(0, noteEndRef.current || 0);
      const startOffset = Math.max(
        0,
        Math.min(offsetSeconds || 0, fullDuration || 0),
      );
      setCurrentTime(Math.max(0, startOffset));
      setPlayheadTime(snapToLatestOnset(onsetTimesRef.current, startOffset));
      startOffsetRef.current = startOffset;

      // Stop any existing playback before starting a new one.
      stopPlaybackEngine();
      const transport = Tone.getTransport();

      // Ensure audio context is running (required after user gesture in many browsers)
      const ctx = Tone.getContext();
      if (ctx.state !== "running") {
        await ctx.resume();
      }

      // Piano samples from same origin (public/piano/) so CORS never blocks. Run: npm run download-piano
      if (!samplerRef.current) {
        const sampler = new Tone.Sampler({
          urls: {
            A0: "A0.mp3",
            C1: "C1.mp3",
            "F#1": "Fs1.mp3",
            C2: "C2.mp3",
            "F#2": "Fs2.mp3",
            C3: "C3.mp3",
            "F#3": "Fs3.mp3",
            C4: "C4.mp3",
            "F#4": "Fs4.mp3",
            C5: "C5.mp3",
            "F#5": "Fs5.mp3",
            C6: "C6.mp3",
          },
          baseUrl: "/piano/",
          attack: 0.001,
          release: 1.4,
          volume: -1,
        }).toDestination();
        samplerRef.current = sampler;
      }

      const sampler = samplerRef.current;

      // Wait for sampler buffers to be ready (avoids "first note only" when scheduling many notes)
      if (sampler.loaded && typeof sampler.loaded.then === "function") {
        await sampler.loaded;
      } else {
        await Tone.loaded();
      }

      // Part only runs when Transport is running.
      // Support starting from an offset by skipping earlier notes and shifting times.
      const events = [];
      const renderNotes = Array.isArray(playbackNotesRef.current)
        ? playbackNotesRef.current
        : [];
      renderNotes.forEach((note) => {
        const normTime = Math.max(0, Number(note.time) || 0);
        const normDur = Math.max(0.02, Number(note.duration) || 0.02);
        if (normTime + normDur <= startOffset) return;
        if (normTime >= fullDuration + 0.001) return;
        const shiftedTime = Math.max(0, normTime - startOffset);
        events.push([
          shiftedTime,
          {
            name: note.name,
            duration: normDur,
            songTime: normTime,
          },
        ]);
      });

      const part = new Tone.Part((time, note) => {
        const duration = Math.min(Math.max(note.duration, 0.02), 8);
        sampler.triggerAttackRelease(note.name, duration, time);
        // Drive playhead from Tone's audio clock so jumps happen at heard onsets.
        Tone.Draw.schedule(() => {
          const clampedSongTime = Math.max(
            0,
            Math.min(fullDuration, Number(note.songTime) || 0),
          );
          const snapped = snapToLatestOnset(
            onsetTimesRef.current,
            clampedSongTime,
          );
          setPlayheadTime(snapped);
        }, time);
      }, events);
      part.start(0);
      part.stop(fullDuration + 0.5);
      partRef.current = part;

      transport.start();

      setIsPlaying(true);
      setIsPaused(false);

      const remaining = Math.max(0, fullDuration - startOffset);
      const totalDurationSeconds = (remaining + 1) * 1000;
      playTimeoutRef.current = setTimeout(() => {
        transport.stop();
        partRef.current?.dispose();
        partRef.current = null;
        sampler.releaseAll?.();
        setIsPlaying(false);
        setIsPaused(false);
        setCurrentTime(Math.max(0, fullDuration));
        setPlayheadTime(snapToLatestOnset(onsetTimesRef.current, fullDuration));
        playTimeoutRef.current = null;
        startOffsetRef.current = 0;
      }, totalDurationSeconds);
    } catch (err) {
      console.error("Error playing MIDI:", err);
      setError(err.message || "Failed to play MIDI.");
      setIsPlaying(false);
      setIsPaused(false);
    } finally {
      setIsLoading(false);
    }
  }

  function handlePauseClick() {
    if (!isPlaying || isLoading) return;

    const transport = Tone.getTransport();
    const elapsed = transport.seconds ?? 0;
    const pausedAt = Math.max(
      0,
      Math.min(totalDuration, (startOffsetRef.current ?? 0) + elapsed),
    );

    setCurrentTime(Math.max(0, pausedAt));
    setPlayheadTime(snapToLatestOnset(onsetTimesRef.current, pausedAt));
    startOffsetRef.current = pausedAt;

    stopPlaybackEngine();

    setIsPlaying(false);
    setIsPaused(true);
  }

  function stopPlaybackEngine() {
    if (playTimeoutRef.current) {
      clearTimeout(playTimeoutRef.current);
      playTimeoutRef.current = null;
    }
    const transport = Tone.getTransport();
    transport.stop();
    transport.seconds = 0;
    partRef.current?.dispose();
    partRef.current = null;
    samplerRef.current?.releaseAll?.();
  }

  // Ensure playback stops if user leaves the page/component.
  useEffect(() => {
    return () => {
      stopPlaybackEngine();
    };
    /// eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handlePlayClick() {
    if (!url || isLoading || isPlaying) return;
    playFrom(currentTime);
  }

  const formatTime = (s) => {
    const m = Math.floor(s / 60);
    const sec = (s % 60).toFixed(1);
    return m > 0 ? `${m}:${sec.padStart(4, "0")}` : `${sec}s`;
  };
  const progressPercent =
    totalDuration > 0
      ? Math.max(0, Math.min(100, (currentTime / totalDuration) * 100))
      : 0;

  return (
    <div ref={rootRef} className="flex flex-col gap-2">
      {!notationOnly && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handlePlayClick}
            disabled={!url || isLoading || isPlaying}
            className="inline-flex items-center justify-center rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading
              ? "Loading..."
              : isPlaying
                ? "Playing..."
                : isPaused
                  ? "Resume preview"
                  : "Play preview"}
          </button>
          <button
            type="button"
            onClick={handlePauseClick}
            disabled={!isPlaying || isLoading}
            className="inline-flex items-center justify-center rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Pause
          </button>
          {totalDuration > 0 && (
            <span className="text-xs text-zinc-500">
              {formatTime(currentTime)} / {formatTime(totalDuration)}
            </span>
          )}
          {extraControls}
          {enablePdfDownload && notes.length > 0 && (
            <button
              type="button"
              onClick={downloadNotationAsPdf}
              disabled={isDownloadingPdf}
              className="inline-flex items-center justify-center rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-800 hover:cursor-pointer hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isDownloadingPdf ? "Preparing PDF..." : "Download PDF"}
            </button>
          )}
        </div>
      )}

      {notes.length > 0 && (
        <>
          {!notationOnly && (
            <div className="mt-1">
              {totalDuration > 0 && (
                <input
                  type="range"
                  min={0}
                  max={totalDuration}
                  step={0.01}
                  value={currentTime}
                  onChange={(event) => {
                    const time = parseFloat(event.target.value) || 0;
                    setCurrentTime(time);
                    setPlayheadTime(time);
                    if (isPlaying) {
                      playFrom(time);
                    }
                  }}
                  className="h-2.5 w-full cursor-pointer appearance-none rounded-full outline-none [&::-moz-range-progress]:h-2.5 [&::-moz-range-progress]:rounded-full [&::-moz-range-progress]:bg-red-500 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-red-500 [&::-moz-range-thumb]:shadow-[0_0_0_2px_rgba(255,255,255,0.9),0_0_8px_rgba(239,68,68,0.5)] [&::-moz-range-track]:h-2.5 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-zinc-200 [&::-webkit-slider-runnable-track]:h-2.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:mt-[-3px] [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-0 [&::-webkit-slider-thumb]:bg-red-500 [&::-webkit-slider-thumb]:shadow-[0_0_0_2px_rgba(255,255,255,0.9),0_0_8px_rgba(239,68,68,0.5)]"
                  style={{
                    accentColor: "#ef4444",
                    background: `linear-gradient(to right, #ef4444 0%, #ef4444 ${progressPercent}%, #e4e4e7 ${progressPercent}%, #e4e4e7 100%)`,
                  }}
                />
              )}
            </div>
          )}
          <StaffNotation
            notes={notes}
            currentTime={playheadTime}
            timeSignature={timeSignature}
            keySignature={keySignature}
            secondsPerBeat={secondsPerBeat}
            onSeek={
              notationOnly
                ? undefined
                : (time) => {
                    setCurrentTime(time);
                    setPlayheadTime(time);
                    if (isPlaying) {
                      playFrom(time);
                    }
                  }
            }
          />
        </>
      )}

      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
