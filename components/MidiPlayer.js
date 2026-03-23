"use client";

import { useState, useRef, useEffect } from "react";
import * as Tone from "tone";
import { Midi } from "@tonejs/midi";
import StaffNotation from "./StaffNotation";

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
  return notes;
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
  "0": "C",
  "1": "G",
  "2": "D",
  "3": "A",
  "4": "E",
  "5": "B",
  "6": "F#",
  "7": "C#",
};

const FIFTHS_TO_MINOR = {
  "-7": "Abm",
  "-6": "Ebm",
  "-5": "Bbm",
  "-4": "Fm",
  "-3": "Cm",
  "-2": "Gm",
  "-1": "Dm",
  "0": "Am",
  "1": "Em",
  "2": "Bm",
  "3": "F#m",
  "4": "C#m",
  "5": "G#m",
  "6": "D#m",
  "7": "A#m",
};

const COMMON_VEX_KEYS = new Set([
  "C", "G", "D", "A", "E", "B", "F#", "C#",
  "F", "Bb", "Eb", "Ab", "Db", "Gb", "Cb",
  "Am", "Em", "Bm", "F#m", "C#m", "G#m", "D#m", "A#m",
  "Dm", "Gm", "Cm", "Fm", "Bbm", "Ebm", "Abm",
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

export default function MidiPlayer({ url, timeSignature: timeSignatureProp }) {
  const [isLoading, setIsLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState([]);
  const [timeSignature, setTimeSignature] = useState(
    timeSignatureProp?.trim() || "4/4",
  );
  const [keySignature, setKeySignature] = useState("C");
  const [currentTime, setCurrentTime] = useState(0);
  const [totalDuration, setTotalDuration] = useState(0);
  const startOffsetRef = useRef(0);
  const playTimeoutRef = useRef(null);
  const lastUrlRef = useRef(null);
  const intervalRef = useRef(null);
  const midiRef = useRef(null);
  const samplerRef = useRef(null);
  const partRef = useRef(null);

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
        setNotes(flatNotes);

        const fromMidi = timeSignatureFromMidi(midi);
        setTimeSignature(
          (timeSignatureProp && timeSignatureProp.trim()) ||
            fromMidi ||
            "4/4",
        );

        const keyFromMeta = keySignatureFromMidi(midi);
        const keyFromNotes = inferKeySignatureFromNotes(flatNotes);
        setKeySignature(keyFromMeta || keyFromNotes || "C");

        const fullDurationInit =
          flatNotes.length > 0
            ? flatNotes.reduce(
                (max, n) => Math.max(max, n.time + (n.duration || 0)),
                0,
              )
            : midi.duration || 0;
        setTotalDuration(fullDurationInit);
        // Helpful for debugging end-to-end timing vs staff rendering
        // but safe in production as a low-frequency log.
        console.log("MidiPlayer loaded MIDI", {
          noteCount: flatNotes.length,
          firstTime: flatNotes[0]?.time ?? 0,
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

  // Update currentTime during playback based on wall-clock time + start offset
  useEffect(() => {
    if (!isPlaying || totalDuration <= 0) return;
    // Drive UI time from Tone.Transport which is synced to the audio context.
    // performance.now() can be slightly offset from audio start (often visible on
    // the very first note).
    const VISUAL_LEAD = 0.0;
    intervalRef.current = setInterval(() => {
      const transport = Tone.getTransport();
      const t =
        (startOffsetRef.current ?? 0) + (transport.seconds ?? 0) + VISUAL_LEAD;
      const clamped = Math.max(0, Math.min(totalDuration, t));
      setCurrentTime(clamped);
    }, 30);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
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
          setNotes(flatNotes);

          const fullDurationInit =
            flatNotes.length > 0
              ? flatNotes.reduce(
                  (max, n) => Math.max(max, n.time + (n.duration || 0)),
                  0,
                )
              : midi.duration || 0;
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

      const fullDuration = midi.duration || 0;
      const startOffset = Math.max(
        0,
        Math.min(offsetSeconds || 0, fullDuration || 0),
      );
      setCurrentTime(startOffset);
      startOffsetRef.current = startOffset;

      // Stop any existing playback
      const transport = Tone.getTransport();
      transport.stop();
      transport.seconds = 0;
      if (partRef.current) {
        partRef.current.dispose();
        partRef.current = null;
      }
      if (playTimeoutRef.current) {
        clearTimeout(playTimeoutRef.current);
        playTimeoutRef.current = null;
      }
      samplerRef.current?.releaseAll?.();

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
      midi.tracks.forEach((track) => {
        track.notes.forEach((note) => {
          if (note.time + note.duration <= startOffset) return;
          const shiftedTime = Math.max(0, note.time - startOffset);
          events.push([shiftedTime, note]);
        });
      });

      const part = new Tone.Part((time, note) => {
        const duration = Math.min(Math.max(note.duration, 0.02), 8);
        sampler.triggerAttackRelease(note.name, duration, time);
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
        setCurrentTime(fullDuration);
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

    setCurrentTime(pausedAt);
    startOffsetRef.current = pausedAt;

    if (playTimeoutRef.current) {
      clearTimeout(playTimeoutRef.current);
      playTimeoutRef.current = null;
    }

    transport.stop();
    transport.seconds = 0;
    partRef.current?.dispose();
    partRef.current = null;
    samplerRef.current?.releaseAll?.();

    setIsPlaying(false);
    setIsPaused(true);
  }

  function handlePlayClick() {
    if (!url || isLoading || isPlaying) return;
    playFrom(currentTime);
  }

  const formatTime = (s) => {
    const m = Math.floor(s / 60);
    const sec = (s % 60).toFixed(1);
    return m > 0 ? `${m}:${sec.padStart(4, "0")}` : `${sec}s`;
  };

  return (
    <div className="flex flex-col gap-2">
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
      </div>

      {notes.length > 0 && (
        <>
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
                  if (isPlaying) {
                    playFrom(time);
                  }
                }}
                className="w-full"
              />
            )}
          </div>
          <StaffNotation
            notes={notes}
            currentTime={currentTime}
            timeSignature={timeSignature}
            keySignature={keySignature}
            onSeek={(time) => {
              setCurrentTime(time);
              if (isPlaying) {
                playFrom(time);
              }
            }}
          />
        </>
      )}

      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
