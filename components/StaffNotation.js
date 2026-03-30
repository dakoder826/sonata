"use client";

import { useEffect, useRef, useId } from "react";

// Duration quantization for EasyScore tokens.
// Uses runtime tempo from the parsed MIDI header when available.
const DEFAULT_SECONDS_PER_BEAT = 0.5; // 120 BPM fallback

// EasyScore uses `<pitch>/<dur>/r`; pitch sets vertical rest placement. Middle staff
// lines keep filler rests visually centered (C4/C3 sit toward the ledger-line area).
const TREBLE_REST_CENTER_PITCH = "B4";
const BASS_REST_CENTER_PITCH = "D3";
const PLAYHEAD_X_BIAS_PX = 6;
const STAFF_SPACE_PX = 10;
const GRAND_STAFF_SYSTEM_GAP_PX = 24;

/**
 * MIDI from multiple tracks often repeats the same pitch at (almost) the same time.
 * That becomes duplicate keys in one VexFlow chord → overlapping noteheads / extra stems.
 */
function dedupeNearSimultaneousSamePitch(noteList) {
  if (!noteList.length) return noteList;
  const sorted = [...noteList].sort((a, b) => {
    const dt = a.time - b.time;
    if (dt !== 0) return dt;
    return (a.midi ?? 0) - (b.midi ?? 0);
  });
  const out = [];
  // ~1ms: collapse export duplicates; keep musical reattacks on separate 16ths intact.
  const timeTolSec = 0.001;
  for (const n of sorted) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.midi === n.midi &&
      Math.abs(n.time - prev.time) < timeTolSec
    ) {
      const pd = prev.duration || 0;
      const nd = n.duration || 0;
      if (nd > pd) {
        out[out.length - 1] = { ...prev, ...n, duration: nd };
      }
      continue;
    }
    out.push(n);
  }
  return out;
}

function uniqNoteNamesPreserveOrder(names) {
  const seen = new Set();
  const out = [];
  for (const name of names) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function durationToCode(sec, secPerBeat = DEFAULT_SECONDS_PER_BEAT) {
  const beats = sec / secPerBeat;
  if (beats <= 0.03125) return "128";
  if (beats <= 0.0625) return "64";
  if (beats <= 0.125) return "32";
  if (beats <= 0.25) return "16";
  if (beats <= 0.5) return "8";
  if (beats <= 1) return "q";
  if (beats <= 2) return "h";
  // Keep rendered notes stemmed; avoid whole-note glyphs for long sustains.
  return "h";
}

function codeToBeats(code) {
  switch (code) {
    case "128":
      return 0.03125;
    case "64":
      return 0.0625;
    case "32":
      return 0.125;
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

// EasyScore expects note names like C4, F#3. Octaves 0-8 are typical.
function sanitizeNoteName(name) {
  const match = String(name)
    .trim()
    .match(/^([A-G]#?)(-?\d+)$/i);
  if (!match) return null;
  const [, letter, octave] = match;
  const oct = parseInt(octave, 10);
  const safeOct = Math.max(0, Math.min(8, oct));
  return `${letter.toUpperCase()}${safeOct}`;
}

function midiToNoteName(midi) {
  if (!Number.isFinite(midi)) return null;
  const m = Math.round(Number(midi));
  // MIDI note 60 = C4
  const pitchClass = ((m % 12) + 12) % 12;
  const octave = Math.floor(m / 12) - 1;
  const safeOct = Math.max(0, Math.min(8, octave));
  const names = [
    "C",
    "C#",
    "D",
    "D#",
    "E",
    "F",
    "F#",
    "G",
    "G#",
    "A",
    "A#",
    "B",
  ];
  return `${names[pitchClass]}${safeOct}`;
}

/**
 * Build EasyScore text plus tie/slur pairs (indices into the note tickables from
 * score.notes — rests appended by padWithRests come after and are not indexed).
 */
function buildEasyScoreMeasure(
  notes,
  maxBeats = 4,
  restPitch = TREBLE_REST_CENTER_PITCH,
  secPerBeat = DEFAULT_SECONDS_PER_BEAT,
) {
  function fitDurationCode(sec, beatsRemaining) {
    const candidates = [
      ["h", 2],
      ["q", 1],
      ["8", 0.5],
      ["16", 0.25],
      ["32", 0.125],
      ["64", 0.0625],
      ["128", 0.03125],
    ];
    const target = codeToBeats(durationToCode(sec, secPerBeat));
    // choose closest duration <= remaining beats
    let best = null;
    for (const [code, beats] of candidates) {
      if (beats > beatsRemaining + 1e-6) continue;
      const score = Math.abs(beats - target);
      if (!best || score < best.score) best = { code, beats, score };
    }
    return best ?? null;
  }

  const tiePairs = [];
  const slurPairs = [];
  const events = [];

  if (!notes.length) {
    return {
      str: padWithRests("", 0, maxBeats, restPitch),
      tiePairs,
      slurPairs,
      events,
    };
  }

  const sorted = [...notes].sort((a, b) => a.time - b.time);
  const parts = [];
  const eventMeta = [];
  const grid = secPerBeat / 4;
  const chordEps = grid * 0.42;
  let beatsUsed = 0;

  let i = 0;
  while (i < sorted.length) {
    const t = sorted[i].time;
    const chord = sorted.filter(
      (n) => n.time >= t - chordEps && n.time <= t + chordEps,
    );
    const chordEnd = chord.reduce(
      (s, n) => Math.max(s, n.time + n.duration),
      0,
    );
    const nextIndex = i + chord.length;
    const nextChordTime =
      nextIndex < sorted.length
        ? sorted[nextIndex].time
        : maxBeats * secPerBeat;
    // Use onset spacing first so we preserve rhythmic placement from MIDI even
    // when original note durations overlap heavily.
    const onsetSpan = Math.max(0, nextChordTime - t);
    const maxDurFromMidi = Math.max(0, chordEnd - t);
    const dur = Math.max(
      0.01,
      Math.min(
        Math.max(onsetSpan, secPerBeat / 128),
        maxDurFromMidi > 0 ? maxDurFromMidi : onsetSpan || secPerBeat / 128,
      ),
    );
    const beatsRemaining = Math.max(0, maxBeats - beatsUsed);
    if (beatsRemaining <= 1e-6) {
      break;
    }
    const fit = fitDurationCode(dur, beatsRemaining);
    if (!fit) break;
    const code = fit.code;
    const noteBeats = fit.beats;
    const beatStart = beatsUsed;
    const names = uniqNoteNamesPreserveOrder(
      chord
        .map((n) => midiToNoteName(n.midi) ?? sanitizeNoteName(n.name))
        .filter(Boolean),
    );
    if (names.length === 0) {
      i += chord.length;
      continue;
    }

    const singleMidi =
      chord.length === 1 && names.length === 1 && Number.isFinite(chord[0].midi)
        ? Math.round(Number(chord[0].midi))
        : null;

    if (names.length > 1) {
      parts.push(`(${names.join(" ")})/${code}`);
    } else {
      parts.push(`${names[0]}/${code}`);
    }

    eventMeta.push({
      tStart: t,
      tEnd: t + dur,
      singleMidi,
      isChord: names.length > 1,
    });
    events.push({
      timeSec: chord.reduce(
        (minTime, n) =>
          Math.min(
            minTime,
            Number.isFinite(n.sourceTime) ? n.sourceTime : Number(n.time) || 0,
          ),
        Number.POSITIVE_INFINITY,
      ),
      beatStart,
      beatLength: noteBeats,
      timeEndSec: chord.reduce((maxEnd, n) => {
        const t = Number.isFinite(n.sourceTime)
          ? n.sourceTime
          : Number(n.time) || 0;
        const d = Math.max(0.02, Number(n.duration) || 0.02);
        return Math.max(maxEnd, t + d);
      }, 0),
    });

    beatsUsed += noteBeats;
    i += chord.length;
  }

  const TIE_GAP_SEC = grid * 0.12;
  // Legato slurs: overlap (true MIDI legato) or back-to-back on the grid — not a wide gap.
  const LEGATO_SLUR_GAP_SEC = grid * 0.06;

  for (let e = 0; e < eventMeta.length - 1; e++) {
    const a = eventMeta[e];
    const b = eventMeta[e + 1];
    const gap = b.tStart - a.tEnd;
    const overlap = gap < 0;

    if (
      a.isChord ||
      b.isChord ||
      a.singleMidi == null ||
      b.singleMidi == null
    ) {
      continue;
    }

    if (a.singleMidi === b.singleMidi) {
      if (overlap || Math.abs(gap) < TIE_GAP_SEC) {
        tiePairs.push([e, e + 1]);
      }
    } else if (overlap || (gap >= 0 && gap < LEGATO_SLUR_GAP_SEC)) {
      slurPairs.push([e, e + 1]);
    }
  }

  const str = parts.join(", ").replace(/,+/g, ",").trim();
  return {
    str: padWithRests(str, beatsUsed, maxBeats, restPitch),
    tiePairs,
    slurPairs,
    events,
  };
}

function dedupeAndMonotonizeTimingMap(points) {
  if (!Array.isArray(points) || points.length === 0) return [];
  const sorted = [...points].sort((a, b) => {
    const dt = (a.timeSec || 0) - (b.timeSec || 0);
    if (Math.abs(dt) > 1e-6) return dt;
    return (a.beat || 0) - (b.beat || 0);
  });
  const timeTolSec = 0.001;
  const buckets = [];
  for (let i = 0; i < sorted.length; ) {
    const seed = sorted[i];
    if (!Number.isFinite(seed?.timeSec) || !Number.isFinite(seed?.beat)) {
      i += 1;
      continue;
    }
    const beats = [seed.beat];
    let j = i + 1;
    while (j < sorted.length) {
      const p = sorted[j];
      if (!Number.isFinite(p?.timeSec) || !Number.isFinite(p?.beat)) {
        j += 1;
        continue;
      }
      if (Math.abs(p.timeSec - seed.timeSec) > timeTolSec) break;
      beats.push(p.beat);
      j += 1;
    }
    beats.sort((a, b) => a - b);
    const mid = Math.floor(beats.length / 2);
    const medianBeat =
      beats.length % 2 === 1 ? beats[mid] : (beats[mid - 1] + beats[mid]) / 2;
    buckets.push({ timeSec: seed.timeSec, beat: medianBeat });
    i = j;
  }

  const out = [];
  for (const p of buckets) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(p.timeSec - prev.timeSec) <= timeTolSec) {
      prev.beat = (prev.beat + p.beat) / 2;
    } else {
      out.push({ timeSec: p.timeSec, beat: p.beat });
    }
  }
  for (let i = 1; i < out.length; i += 1) {
    if (out[i].beat < out[i - 1].beat) out[i].beat = out[i - 1].beat;
  }
  return out;
}

function mapTimeToBeat(timingMap, timeSec, fallbackBeat = 0) {
  if (!Array.isArray(timingMap) || timingMap.length === 0) return fallbackBeat;
  if (timingMap.length === 1) return timingMap[0].beat;

  if (timeSec <= timingMap[0].timeSec) return timingMap[0].beat;
  const last = timingMap[timingMap.length - 1];
  if (timeSec >= last.timeSec) return last.beat;
  for (let i = 0; i < timingMap.length - 1; i += 1) {
    const a = timingMap[i];
    const b = timingMap[i + 1];
    if (timeSec < a.timeSec || timeSec > b.timeSec) continue;
    const span = Math.max(1e-6, b.timeSec - a.timeSec);
    const p = (timeSec - a.timeSec) / span;
    return a.beat + p * (b.beat - a.beat);
  }
  return fallbackBeat;
}

function mapBeatToTime(timingMap, beat, fallbackTimeSec = 0) {
  if (!Array.isArray(timingMap) || timingMap.length === 0)
    return fallbackTimeSec;
  if (timingMap.length === 1) return timingMap[0].timeSec;
  if (beat <= timingMap[0].beat) return timingMap[0].timeSec;
  const last = timingMap[timingMap.length - 1];
  if (beat >= last.beat) return last.timeSec;
  for (let i = 0; i < timingMap.length - 1; i += 1) {
    const a = timingMap[i];
    const b = timingMap[i + 1];
    if (beat < a.beat || beat > b.beat) continue;
    const span = Math.max(1e-6, b.beat - a.beat);
    const p = (beat - a.beat) / span;
    return a.timeSec + p * (b.timeSec - a.timeSec);
  }
  return fallbackTimeSec;
}

function applyTiesAndSlurs(factory, tickables, tiePairs, slurPairs) {
  if (!factory || !Array.isArray(tickables)) return;

  for (const [fromIdx, toIdx] of tiePairs) {
    const from = tickables[fromIdx];
    const to = tickables[toIdx];
    if (
      !from ||
      !to ||
      typeof from.isRest !== "function" ||
      typeof to.isRest !== "function" ||
      from.isRest() ||
      to.isRest()
    ) {
      continue;
    }
    try {
      factory.StaveTie({ from, to });
    } catch (e) {
      console.warn("StaffNotation: StaveTie failed", e);
    }
  }

  for (const [fromIdx, toIdx] of slurPairs) {
    const from = tickables[fromIdx];
    const to = tickables[toIdx];
    if (
      !from ||
      !to ||
      typeof from.isRest !== "function" ||
      typeof to.isRest !== "function" ||
      from.isRest() ||
      to.isRest()
    ) {
      continue;
    }
    try {
      factory.Curve({
        from,
        to,
        options: {
          thickness: 1.25,
          yShift: 8,
          cps: [
            { x: 0, y: 12 },
            { x: 0, y: 12 },
          ],
        },
      });
    } catch (e) {
      console.warn("StaffNotation: legato Curve failed", e);
    }
  }
}

function padWithRests(
  str,
  beatsUsed,
  maxBeats,
  restPitch = TREBLE_REST_CENTER_PITCH,
) {
  // VexFlow EasyScore rest token syntax is: <pitch>/<dur>/r (pitch = vertical slot).
  const remaining = maxBeats - beatsUsed;
  if (remaining <= 0.00001) return str;

  // Quantize remaining rests to 128th-grid so dense measures can still
  // be filled without overflowing ticks.
  const STEP = 0.03125; // 1/128 note in beat units
  const steps128 = Math.max(0, Math.round(remaining / STEP));
  const restParts = [];
  // Group into quarter/eighth/sixteenth/thirty-second/sixty-fourth/128th.
  let s = steps128;
  while (s >= 32) {
    restParts.push(`${restPitch}/q/r`);
    s -= 32;
  }
  while (s >= 16) {
    restParts.push(`${restPitch}/8/r`);
    s -= 16;
  }
  while (s >= 8) {
    restParts.push(`${restPitch}/16/r`);
    s -= 8;
  }
  while (s >= 4) {
    restParts.push(`${restPitch}/32/r`);
    s -= 4;
  }
  while (s >= 2) {
    restParts.push(`${restPitch}/64/r`);
    s -= 2;
  }
  while (s >= 1) {
    restParts.push(`${restPitch}/128/r`);
    s -= 1;
  }

  const restStr = restParts.join(", ");
  return str ? `${str}, ${restStr}` : restStr;
}

/**
 * VexFlow EasyScore parses notes but does not beam them automatically.
 * Group consecutive eighth/sixteenth (and shorter) *non-rests* and call `score.beam`
 * so stems and beams stay visually connected.
 */
function beamConsecutiveTickables(score, tickables) {
  if (!score || !Array.isArray(tickables) || tickables.length < 2) return;

  const BEAMABLE_DURATIONS = new Set(["8", "16", "32", "64", "128"]);

  function isBeamableNote(note) {
    if (!note || typeof note.getDuration !== "function") return false;
    if (typeof note.isRest === "function" && note.isRest()) return false;
    if (
      typeof note.shouldIgnoreTicks === "function" &&
      note.shouldIgnoreTicks()
    ) {
      return false;
    }
    const d = String(note.getDuration());
    return BEAMABLE_DURATIONS.has(d);
  }

  let run = [];
  function flush() {
    if (run.length >= 2) {
      try {
        score.beam(run);
      } catch (e) {
        console.warn("StaffNotation: beam failed", e);
      }
    }
    run = [];
  }

  for (const n of tickables) {
    if (isBeamableNote(n)) run.push(n);
    else flush();
  }
  flush();
}

function forceStemDirection(tickables, stemDirection = "up") {
  if (!Array.isArray(tickables) || tickables.length === 0) return;
  const dir = stemDirection === "down" ? -1 : 1;
  for (const note of tickables) {
    if (!note || typeof note.isRest !== "function" || note.isRest()) continue;
    try {
      if (typeof note.setStemDirection === "function") {
        note.setStemDirection(dir);
      }
      if (typeof note.getStem === "function" && note.getStem()) {
        note.getStem().setDirection?.(dir);
      }
    } catch (e) {
      console.warn("StaffNotation: forcing stem direction failed", e);
    }
  }
}

function forceMeasureBarlines(vf, stave, measureIndex, isLastMeasureInRow) {
  if (!stave || !vf) return;
  try {
    const barType = vf.Barline?.type;
    if (!barType) return;
    const beginType =
      measureIndex === 0 ? barType.SINGLE : (barType.NONE ?? barType.SINGLE);
    const endType = isLastMeasureInRow
      ? (barType.END ?? barType.SINGLE)
      : barType.SINGLE;
    stave.setBegBarType?.(beginType);
    stave.setEndBarType?.(endType);
  } catch (e) {
    console.warn("StaffNotation: forcing barlines failed", e);
  }
}

/**
 * VexFlow registers Bravura/Academico via FontFace when the module loads, but loading
 * is async. Canvas uses fillText for SMuFL noteheads — if we draw before the font is
 * ready, every head shows as a square (missing-glyph tofu).
 */
async function ensureVexflowFontsReady() {
  if (typeof document === "undefined" || !document.fonts) return;
  try {
    await document.fonts.ready;
    if (typeof document.fonts.load === "function") {
      await Promise.all([
        document.fonts.load("20px Bravura"),
        document.fonts.load("20px Academico"),
      ]);
    }
  } catch {
    /* Drawing may still work if fonts were already cached */
  }
}

const SUPPORTED_KEY_SIGNATURES = new Set([
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

function normalizeKeySignature(keySignature) {
  if (!keySignature) return "C";
  const s = String(keySignature).trim();
  const m = s.match(/^([A-Ga-g])([#b]?)(m?)$/);
  if (!m) return "C";
  const k = `${m[1].toUpperCase()}${m[2] || ""}${m[3] || ""}`;
  return SUPPORTED_KEY_SIGNATURES.has(k) ? k : "C";
}

/** Parse "4/4", "3/4", etc. Layout assumes quarter-based meters (denominator 4 or 2). */
function parseTimeSignature(ts) {
  const m = String(ts ?? "4/4")
    .trim()
    .match(/^(\d+)\s*\/\s*(\d+)$/);
  const num = m ? Math.max(1, Math.min(16, parseInt(m[1], 10))) : 4;
  const den = m ? Math.max(1, Math.min(32, parseInt(m[2], 10))) : 4;
  const label = `${num}/${den}`;
  // Grand staff layout: quarter-note beats per measure (VexFlow EasyScore).
  const beatsPerMeasure = den === 4 || den === 2 ? num : 4;
  const beatsPerLine = beatsPerMeasure * 2;
  return { beatsPerMeasure, beatsPerLine, label };
}

export default function StaffNotation({
  notes,
  currentTime = 0,
  onSeek,
  timeSignature = "4/4",
  keySignature = "C",
  secondsPerBeat = DEFAULT_SECONDS_PER_BEAT,
}) {
  const containerRef = useRef(null);
  const playheadRef = useRef(null);
  const staffScrollRef = useRef(null);
  const staffWidthRef = useRef(0);
  const lineHeightRef = useRef(0);
  const lineCountRef = useRef(1);
  const totalBeatsRef = useRef(8);
  const lastEventTimeRef = useRef(0);
  const firstEventTimeRef = useRef(0);
  const systemXRef = useRef(10);
  const measureWidthRef = useRef(0);
  const measureGapRef = useRef(0);
  const beatsPerMeasureRef = useRef(4);
  const firstMeasureLeftPadRef = useRef(56);
  const timingMapRef = useRef([]);
  const onSeekRef = useRef(onSeek);
  const id = useId().replace(/:/g, "");
  const secPerBeat =
    Number.isFinite(secondsPerBeat) && secondsPerBeat > 0
      ? secondsPerBeat
      : DEFAULT_SECONDS_PER_BEAT;
  const normalizedKeySignature = normalizeKeySignature(keySignature);
  // Each "line system" contains two 4/4 measures (8 beats total), because we
  // generate `measure1` + `measure2` tickables into a single voice.
  // We therefore configure the VexFlow Voice for 8 beats to avoid
  // "Too many ticks" during EasyScore parsing.

  useEffect(() => {
    onSeekRef.current = onSeek;
  }, [onSeek]);

  // Move playhead and scroll staff to keep it in view (MuseScore-style)
  useEffect(() => {
    if (!notes.length) return;

    const { beatsPerLine } = parseTimeSignature(timeSignature);

    const firstEventTime = Math.max(
      0,
      firstEventTimeRef.current ?? Math.min(...notes.map((n) => n.time || 0)),
    );
    const lastEventTime =
      lastEventTimeRef.current ||
      Math.max(...notes.map((n) => n.time + (n.duration || 0)));
    if (!lastEventTime || !Number.isFinite(lastEventTime)) return;

    const totalBeats = Math.max(beatsPerLine, lastEventTime / secPerBeat);
    const firstBeat = Math.max(0, firstEventTime / secPerBeat);
    const lastBeat = Math.max(firstBeat, lastEventTime / secPerBeat);
    const timingMap = timingMapRef.current || [];

    const width = staffWidthRef.current;
    const playhead = playheadRef.current;
    const lineHeight = lineHeightRef.current || 0;
    const lineCount =
      lineCountRef.current || Math.max(1, Math.ceil(totalBeats / beatsPerLine));
    if (!width || !playhead || !lineHeight || !lineCount) return;

    const clampedTime = Math.max(
      firstEventTime,
      Math.min(currentTime, lastEventTime),
    );
    const positionBeats =
      timingMap.length >= 2
        ? mapTimeToBeat(timingMap, clampedTime, clampedTime / secPerBeat)
        : clampedTime / secPerBeat;
    const maxLines = Math.max(
      1,
      Math.min(lineCount, Math.ceil(totalBeats / beatsPerLine)),
    );

    const clampedBeats = Math.max(0, Math.min(totalBeats, positionBeats));
    const lineIndex = Math.min(
      maxLines - 1,
      Math.floor(clampedBeats / beatsPerLine),
    );
    const lineStartBeat = lineIndex * beatsPerLine;
    const withinLineBeats = Math.max(
      0,
      Math.min(beatsPerLine, clampedBeats - lineStartBeat),
    );

    const beatsPerMeasure = Math.max(1, beatsPerMeasureRef.current || 4);
    const systemX = systemXRef.current || 10;
    const measureWidth = measureWidthRef.current || width / 2;
    const measureGap = measureGapRef.current || 0;
    const firstMeasureLeftPad = Math.max(
      0,
      Math.min(measureWidth * 0.45, firstMeasureLeftPadRef.current || 56),
    );

    let left = 0;
    if (withinLineBeats <= beatsPerMeasure) {
      const p = withinLineBeats / beatsPerMeasure;
      left =
        systemX +
        firstMeasureLeftPad +
        p * Math.max(1, measureWidth - firstMeasureLeftPad);
    } else {
      const p = (withinLineBeats - beatsPerMeasure) / beatsPerMeasure;
      left = systemX + measureWidth + measureGap + p * measureWidth;
    }
    left = Math.max(
      systemX,
      Math.min(systemX + measureWidth * 2 + measureGap, left),
    );
    left += PLAYHEAD_X_BIAS_PX;
    const top = lineIndex * lineHeight;

    playhead.style.left = `${left}px`;
    playhead.style.top = `${top}px`;
    playhead.style.height = `${lineHeight}px`;
  }, [currentTime, notes, timeSignature, secPerBeat]);

  useEffect(() => {
    const container = containerRef.current;
    if (!notes.length || !container) return;

    const {
      beatsPerMeasure,
      beatsPerLine,
      label: meterLabel,
    } = parseTimeSignature(timeSignature);

    const displayNotes = notes;

    const firstEventTime = Math.max(
      0,
      Math.min(...displayNotes.map((n) => n.time || 0)),
    );
    const lastEventTime = Math.max(
      ...displayNotes.map((n) => n.time + (n.duration || 0)),
    );
    const totalBeats = Math.max(beatsPerLine, lastEventTime / secPerBeat);
    const lines = Math.max(1, Math.ceil(totalBeats / beatsPerLine));

    firstEventTimeRef.current = firstEventTime;
    lastEventTimeRef.current = lastEventTime;
    totalBeatsRef.current = totalBeats;
    lineCountRef.current = lines;

    const trebleNotes = displayNotes.filter((n) => n.midi >= 60);
    const bassNotes = displayNotes.filter((n) => n.midi < 60);

    const buildLines = (sourceNotes, restPitch) => {
      const result = [];
      for (let line = 0; line < lines; line++) {
        const startBeat = line * beatsPerLine;
        const endBeat = startBeat + beatsPerLine;
        const lineNotes = sourceNotes
          .map((n) => {
            const beat = n.time / secPerBeat;
            return { ...n, beat, sourceTime: n.time };
          })
          .filter((n) => n.beat >= startBeat && n.beat < endBeat)
          .map((n) => ({
            ...n,
            time: (n.beat - startBeat) * secPerBeat,
          }));
        const measure1Notes = lineNotes.filter(
          (n) => n.time < beatsPerMeasure * secPerBeat,
        );
        const measure2Notes = lineNotes
          .filter((n) => n.time >= beatsPerMeasure * secPerBeat)
          .map((n) => ({
            ...n,
            time: n.time - beatsPerMeasure * secPerBeat,
          }));
        const m1 = buildEasyScoreMeasure(
          measure1Notes,
          beatsPerMeasure,
          restPitch,
          secPerBeat,
        );
        const m2 = buildEasyScoreMeasure(
          measure2Notes,
          beatsPerMeasure,
          restPitch,
          secPerBeat,
        );
        result.push([m1, m2]);
      }
      return result;
    };

    const trebleLines = buildLines(trebleNotes, TREBLE_REST_CENTER_PITCH);
    const bassLines = buildLines(bassNotes, BASS_REST_CENTER_PITCH);

    const allTimingPoints = [];
    for (let line = 0; line < lines; line += 1) {
      const lineStartBeat = line * beatsPerLine;
      const [trebleM1, trebleM2] = trebleLines[line] ?? [];
      const [bassM1, bassM2] = bassLines[line] ?? [];
      const measureDefs = [
        { offset: 0, treble: trebleM1, bass: bassM1 },
        { offset: beatsPerMeasure, treble: trebleM2, bass: bassM2 },
      ];
      for (const measure of measureDefs) {
        const eventSources = [measure.treble?.events, measure.bass?.events];
        for (const src of eventSources) {
          if (!Array.isArray(src)) continue;
          for (const ev of src) {
            if (
              !Number.isFinite(ev?.timeSec) ||
              !Number.isFinite(ev?.beatStart)
            ) {
              continue;
            }
            allTimingPoints.push({
              timeSec: ev.timeSec,
              beat: lineStartBeat + measure.offset + ev.beatStart,
            });
            if (
              Number.isFinite(ev?.timeEndSec) &&
              Number.isFinite(ev?.beatLength)
            ) {
              allTimingPoints.push({
                timeSec: ev.timeEndSec,
                beat:
                  lineStartBeat +
                  measure.offset +
                  ev.beatStart +
                  Math.max(0, ev.beatLength),
              });
            }
          }
        }
      }
    }
    const firstBeatForMap = Math.max(0, firstEventTime / secPerBeat);
    const lastBeatForMap = Math.max(
      firstBeatForMap,
      lastEventTime / secPerBeat,
    );
    allTimingPoints.push({ timeSec: firstEventTime, beat: firstBeatForMap });
    allTimingPoints.push({ timeSec: lastEventTime, beat: lastBeatForMap });
    timingMapRef.current = dedupeAndMonotonizeTimingMap(allTimingPoints);

    const hasTreble = trebleLines.some((pair) =>
      pair.some((m) => m?.str && m.str.trim().length > 0),
    );
    const hasBass = bassLines.some((pair) =>
      pair.some((m) => m?.str && m.str.trim().length > 0),
    );

    if (!hasTreble && !hasBass) return;

    container.innerHTML = "";
    // Make the staff fill the available horizontal space (full-width sheet)
    const containerWidth = container.clientWidth || window.innerWidth || 900;
    const width = containerWidth;
    staffWidthRef.current = width;

    // Increase vertical space between consecutive grand staffs (rows).
    // (Do not add extra spacing between treble & bass within the same grand staff.)
    const baseLineHeight = hasBass ? 278 : 196;
    const singleLineHeight = baseLineHeight + GRAND_STAFF_SYSTEM_GAP_PX;
    const totalLines = lines;
    const height = singleLineHeight * totalLines;
    lineHeightRef.current = singleLineHeight;
    lineCountRef.current = totalLines;

    const wrapper = document.createElement("div");
    wrapper.style.overflowX = "hidden";
    wrapper.style.overflowY = "auto";
    // Fixed viewport height so we can auto-scroll when the playhead moves (we scroll for the user)
    const scrollAreaHeight = Math.min(
      typeof window !== "undefined" ? window.innerHeight * 0.7 : 560,
      560,
    );
    wrapper.style.maxHeight = `${scrollAreaHeight}px`;
    wrapper.style.height = `${scrollAreaHeight}px`;
    staffScrollRef.current = wrapper;

    const inner = document.createElement("div");
    inner.style.position = "relative";
    inner.style.width = "100%";
    inner.style.minHeight = `${height}px`;
    inner.style.overflow = "hidden";

    // Canvas (not SVG) so stems and SMuFL noteheads share one rasterized surface—avoids
    // the common “gap” between head and stem from SVG stroke vs text misalignment.
    const staffCanvas = document.createElement("canvas");
    staffCanvas.id = `staff-${id}`;
    staffCanvas.style.display = "block";
    staffCanvas.style.width = `${width}px`;
    staffCanvas.style.height = `${height}px`;
    staffCanvas.style.maxWidth = "100%";
    inner.appendChild(staffCanvas);

    const playheadEl = document.createElement("div");
    playheadEl.setAttribute("aria-hidden", "true");
    playheadEl.style.cssText =
      "position:absolute;top:0;width:2px;background:#dc2626;pointer-events:none;z-index:10;transition:left 0s linear;";
    playheadEl.style.left = "0";
    playheadRef.current = playheadEl;
    inner.appendChild(playheadEl);

    wrapper.appendChild(inner);
    container.appendChild(wrapper);

    // Allow clicking on the staff area to move the playhead (seek)
    const handlePointer = (event) => {
      if (!onSeekRef.current) return;
      if (!lastEventTimeRef.current || !totalBeatsRef.current) return;

      const scrollEl = staffScrollRef.current;
      if (!scrollEl) return;

      const rect = scrollEl.getBoundingClientRect();
      const clientX = "clientX" in event ? event.clientX : 0;
      const clientY = "clientY" in event ? event.clientY : 0;
      const x = clientX - rect.left + scrollEl.scrollLeft - PLAYHEAD_X_BIAS_PX;
      const y = clientY - rect.top + scrollEl.scrollTop;

      const width = staffWidthRef.current || rect.width || 1;
      const lineHeight = lineHeightRef.current || 1;
      const { beatsPerLine: bpl } = parseTimeSignature(timeSignature);
      const totalBeatsLocal = totalBeatsRef.current || bpl;
      const firstEventTimeLocal = Math.max(0, firstEventTimeRef.current || 0);
      const lastEventTimeLocal = lastEventTimeRef.current || 0;
      if (!lastEventTimeLocal || !Number.isFinite(lastEventTimeLocal)) return;
      const firstBeatLocal = Math.max(0, firstEventTimeLocal / secPerBeat);
      const lastBeatLocal = Math.max(
        firstBeatLocal,
        lastEventTimeLocal / secPerBeat,
      );
      const timingMap = timingMapRef.current || [];

      const maxLines =
        lineCountRef.current || Math.ceil(totalBeatsLocal / bpl) || 1;
      const lineIndex = Math.max(
        0,
        Math.min(maxLines - 1, Math.floor(y / lineHeight)),
      );
      const beatsPerMeasure = Math.max(1, beatsPerMeasureRef.current || 4);
      const systemX = systemXRef.current || 10;
      const measureWidth = measureWidthRef.current || width / 2;
      const measureGap = measureGapRef.current || 0;
      const firstMeasureLeftPad = Math.max(
        0,
        Math.min(measureWidth * 0.45, firstMeasureLeftPadRef.current || 56),
      );

      let withinLineBeatsMapped = 0;
      const firstMeasureStartX = systemX + firstMeasureLeftPad;
      const firstMeasureEndX = systemX + measureWidth;
      const secondMeasureStartX = firstMeasureEndX + measureGap;
      const secondMeasureEndX = secondMeasureStartX + measureWidth;

      if (x <= firstMeasureStartX) {
        withinLineBeatsMapped = 0;
      } else if (x <= firstMeasureEndX) {
        const p =
          (x - firstMeasureStartX) /
          Math.max(1, firstMeasureEndX - firstMeasureStartX);
        withinLineBeatsMapped = p * beatsPerMeasure;
      } else if (x <= secondMeasureStartX) {
        withinLineBeatsMapped = beatsPerMeasure;
      } else if (x <= secondMeasureEndX) {
        const p = (x - secondMeasureStartX) / Math.max(1, measureWidth);
        withinLineBeatsMapped = beatsPerMeasure + p * beatsPerMeasure;
      } else {
        withinLineBeatsMapped = bpl;
      }

      const beatsPos = lineIndex * bpl + withinLineBeatsMapped;
      const clampedBeats = Math.max(0, Math.min(totalBeatsLocal, beatsPos));
      const clampedWithinWindow = Math.max(
        firstBeatLocal,
        Math.min(lastBeatLocal, clampedBeats),
      );
      const time =
        timingMap.length >= 2
          ? mapBeatToTime(
              timingMap,
              clampedWithinWindow,
              clampedWithinWindow * secPerBeat,
            )
          : clampedWithinWindow * secPerBeat;

      onSeekRef.current(time);
    };

    wrapper.addEventListener("mousedown", handlePointer);

    import("vexflow").then(async (vf) => {
      // If the component was unmounted or the container cleared before VexFlow loaded,
      // bail out to avoid "BadElementId" errors.
      if (!containerRef.current) return;
      if (!staffCanvas.id || !document.getElementById(staffCanvas.id)) return;

      await ensureVexflowFontsReady();

      const Factory = vf.Factory ?? vf.default?.Factory;
      const Renderer = vf.Renderer;
      const canvasBackend = Renderer?.Backends?.CANVAS ?? 1;

      try {
        const factory = new Factory({
          renderer: {
            elementId: staffCanvas.id,
            width,
            height,
            backend: canvasBackend,
          },
          // Slightly smaller glyph/staff scale to reduce crowding.
          stave: { space: STAFF_SPACE_PX },
        });
        const score = factory.EasyScore();
        // Match voice length to our per-measure EasyScore strings (quarter-note beats).
        score.set({ time: `${beatsPerMeasure}/4` });

        let anyTrebleOk = false;
        let anyBassOk = false;

        const systemRefs = [];
        const systemX = 10;
        const measureGap = 0;
        const systemWidth = width - 20;
        const measureWidth = (systemWidth - measureGap) / 2;
        systemXRef.current = systemX;
        measureWidthRef.current = measureWidth;
        measureGapRef.current = measureGap;
        beatsPerMeasureRef.current = beatsPerMeasure;
        // Gutter occupied by clef/key/time at the start of each row.
        firstMeasureLeftPadRef.current = Math.max(
          54,
          Math.min(84, measureWidth * 0.31),
        );

        let loggedTooManyTicks = false;

        const emptyMeasure = { str: "", tiePairs: [], slurPairs: [] };

        for (let line = 0; line < totalLines; line++) {
          const [trebleM1, trebleM2] = trebleLines[line] ?? [
            emptyMeasure,
            emptyMeasure,
          ];
          const [bassM1, bassM2] = bassLines[line] ?? [
            emptyMeasure,
            emptyMeasure,
          ];
          const measures = [
            { treble: trebleM1, bass: bassM1, measureIndex: 0 },
            { treble: trebleM2, bass: bassM2, measureIndex: 1 },
          ];

          for (const measure of measures) {
            const { treble, bass, measureIndex } = measure;
            const hasTrebleThisMeasure =
              treble.str && treble.str.trim().length > 0;
            const hasBassThisMeasure = bass.str && bass.str.trim().length > 0;
            if (!hasTrebleThisMeasure && !hasBassThisMeasure) continue;

            const x = systemX + measureIndex * (measureWidth + measureGap);
            const y = line * singleLineHeight;
            const system = factory.System({
              width: measureWidth,
              x,
              y,
            });
            systemRefs.push(system);

            let trebleOk = false;
            let bassOk = false;

            if (hasTrebleThisMeasure) {
              try {
                const opts = { clef: "treble", stem: "up" };
                const trebleTickables = score.notes(treble.str, opts);
                if (!trebleTickables.length) {
                  throw new Error("Empty treble voice");
                }
                forceStemDirection(trebleTickables, "up");
                beamConsecutiveTickables(score, trebleTickables);
                applyTiesAndSlurs(
                  factory,
                  trebleTickables,
                  treble.tiePairs ?? [],
                  treble.slurPairs ?? [],
                );
                const trebleVoice = score.voice(trebleTickables);
                trebleVoice.setStrict?.(false);
                const trebleStave = system.addStave({
                  voices: [trebleVoice],
                });
                forceMeasureBarlines(
                  vf,
                  trebleStave,
                  measureIndex,
                  measureIndex === 1,
                );
                // Show clef/time only at the start of each row.
                if (measureIndex === 0) {
                  trebleStave
                    .addClef("treble")
                    .addKeySignature(normalizedKeySignature)
                    .addTimeSignature(meterLabel);
                }
                trebleOk = true;
                anyTrebleOk = true;
              } catch (e) {
                const msg = String(e?.message || e);
                if (!loggedTooManyTicks && msg.includes("Too many ticks")) {
                  loggedTooManyTicks = true;
                  console.warn("StaffNotation: Too many ticks (treble)", {
                    line,
                    measureIndex,
                    treble: treble.str,
                  });
                }
                console.warn("StaffNotation: treble voice failed", e);
              }
            }

            if (hasBassThisMeasure) {
              try {
                const opts = { clef: "bass", stem: "down" };
                const bassTickables = score.notes(bass.str, opts);
                if (!bassTickables.length) {
                  throw new Error("Empty bass voice");
                }
                forceStemDirection(bassTickables, "down");
                beamConsecutiveTickables(score, bassTickables);
                applyTiesAndSlurs(
                  factory,
                  bassTickables,
                  bass.tiePairs ?? [],
                  bass.slurPairs ?? [],
                );
                const bassVoice = score.voice(bassTickables);
                bassVoice.setStrict?.(false);
                const bassStave = system.addStave({
                  voices: [bassVoice],
                });
                forceMeasureBarlines(
                  vf,
                  bassStave,
                  measureIndex,
                  measureIndex === 1,
                );
                // Show clef/time only at the start of each row.
                if (measureIndex === 0) {
                  bassStave
                    .addClef("bass")
                    .addKeySignature(normalizedKeySignature)
                    .addTimeSignature(meterLabel);
                }
                bassOk = true;
                anyBassOk = true;
              } catch (e) {
                const msg = String(e?.message || e);
                if (!loggedTooManyTicks && msg.includes("Too many ticks")) {
                  loggedTooManyTicks = true;
                  console.warn("StaffNotation: Too many ticks (bass)", {
                    line,
                    measureIndex,
                    bass: bass.str,
                  });
                }
                console.warn("StaffNotation: bass voice failed", e);
              }
            }

            if (trebleOk && bassOk && measureIndex === 0) {
              // Add the grand-staff connector only at the row start.
              // If we add it again on the middle measure, it visually stacks
              // with the prior system barline and looks like a thick final bar.
              system.addConnector();
            }
          }
        }

        if (anyTrebleOk || anyBassOk) {
          try {
            // If for some reason no system ended up with an attached stave,
            // skip drawing to avoid VexFlow "MissingStave" runtime errors.
            const hasAnyStaves = systemRefs.some((system) => {
              const staves =
                typeof system.getStaves === "function"
                  ? system.getStaves()
                  : [];
              return Array.isArray(staves) && staves.length > 0;
            });
            if (!hasAnyStaves) {
              console.warn(
                "StaffNotation: no staves to draw, skipping factory.draw()",
              );
              return;
            }

            factory.draw();
          } catch (drawErr) {
            const msg = String(
              drawErr && drawErr.message ? drawErr.message : drawErr,
            );
            if (
              msg &&
              (msg.includes("MissingStave") || msg.includes("NoTickContext"))
            ) {
              // Benign VexFlow layout quirk (often triggered by very sparse/easy voices).
              // We skip drawing rather than surfacing a red console error.
              console.warn(
                "StaffNotation: VexFlow layout issue, skipping draw()",
                msg,
              );
              return;
            }
            console.error("StaffNotation draw error:", drawErr);
            container.innerHTML = `<p class="text-xs text-zinc-500">Could not draw staff notation.</p>`;
          }
        } else {
          container.innerHTML = `<p class="text-xs text-zinc-500">Could not parse notes for staff.</p>`;
        }
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        if (
          msg &&
          (msg.includes("MissingStave") || msg.includes("NoTickContext"))
        ) {
          // Some VexFlow internals can still throw layout errors even before factory.draw().
          // We treat these as benign and simply skip drawing rather than crashing the app.
          console.warn(
            "StaffNotation: VexFlow early layout issue, skipping render()",
            msg,
          );
          return;
        }
        console.error("StaffNotation render error:", err);
        container.innerHTML = `<p class="text-xs text-zinc-500">Could not draw staff notation.</p>`;
      }
    });

    return () => {
      if (container) container.innerHTML = "";
      playheadRef.current = null;
      staffScrollRef.current = null;
      wrapper.removeEventListener("mousedown", handlePointer);
    };
  }, [notes, id, timeSignature, normalizedKeySignature, secPerBeat]);

  if (!notes.length) return null;

  const { label: headerMeter } = parseTimeSignature(timeSignature);
  const headerKey = normalizedKeySignature;

  return (
    <div
      data-staff-notation="true"
      className="w-full rounded-xl border border-zinc-200 bg-white"
    >
      <p className="px-2 pt-2 pb-1 text-[10px] font-medium tracking-wide text-zinc-500 uppercase">
        Staff notation
        <span className="text-zinc-400 normal-case">
          {` · ${headerMeter} · ${headerKey}`}
        </span>
      </p>
      <div
        ref={containerRef}
        className="flex min-h-[140px] items-center justify-start"
      />
    </div>
  );
}
