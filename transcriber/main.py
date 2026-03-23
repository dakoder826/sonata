import os
import tempfile
import uuid
import ssl
from pathlib import Path
from urllib.parse import urlparse

import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from yt_dlp import YoutubeDL

from basic_pitch.inference import predict
from basic_pitch import ICASSP_2022_MODEL_PATH
from basic_pitch.inference import Model

import numpy as np
import pretty_midi
import certifi

try:
    import soundfile as sf
    SOUNDFILE_AVAILABLE = True
except Exception:
    SOUNDFILE_AVAILABLE = False
    sf = None

try:
    import librosa
    LIBROSA_AVAILABLE = True
except ImportError:
    LIBROSA_AVAILABLE = False

# Valid CA bundle for HTTPS (yt-dlp / requests on odd macOS setups).
try:
    _ssl_ctx = ssl.create_default_context(cafile=certifi.where())
    ssl._create_default_https_context = lambda: _ssl_ctx
except Exception:
    pass

# Global Basic Pitch model cache (one load per process).
_BASIC_PITCH_MODEL = None


def _get_basic_pitch_model() -> Model:
    global _BASIC_PITCH_MODEL
    if _BASIC_PITCH_MODEL is None:
        _BASIC_PITCH_MODEL = Model(ICASSP_2022_MODEL_PATH)
    return _BASIC_PITCH_MODEL


def _env_truthy(name: str) -> bool:
    v = os.environ.get(name, "")
    return str(v).strip().lower() in ("1", "true", "yes", "on")


class TranscriptionRequest(BaseModel):
    audio_url: str
    # Ignored (kept for API compatibility with older clients).
    use_separation: bool = True
    clean_level: str = "balanced"  # "simple" | "balanced" | "detailed"


class TranscriptionResponse(BaseModel):
    midi_url: str
    pdf_url: str | None = None
    time_signature: str = "4/4"  # e.g. "3/4", "4/4" — also embedded in MIDI


app = FastAPI(title="Sonata Transcriber")

# Allow the Next.js app (e.g. localhost:3000) to fetch MIDI/PDF from this server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=False,
    allow_methods=["GET", "HEAD"],
    allow_headers=["*"],
)

MEDIA_ROOT = Path(os.environ.get("TRANSCRIBER_MEDIA_ROOT", "./media")).resolve()
MEDIA_ROOT.mkdir(parents=True, exist_ok=True)

app.mount("/media", StaticFiles(directory=str(MEDIA_ROOT)), name="media")


def _download_audio_to_temp(audio_url: str) -> Path:
    """
    Download audio from a URL to a temporary file.
    - For YouTube links, use yt-dlp + ffmpeg to get a WAV.
    - For direct audio URLs, stream with requests.
    """
    try:
        parsed = urlparse(audio_url)
    except Exception:
        parsed = None

    is_youtube = False
    is_tiktok = False
    is_spotify = False
    if parsed and parsed.hostname:
        host = parsed.hostname.lower()
        if "youtube.com" in host or "youtu.be" in host:
            is_youtube = True
        elif "tiktok.com" in host:
            is_tiktok = True
        elif "spotify.com" in host:
            is_spotify = True

    # Use yt-dlp for platforms that yt-dlp supports well (YouTube, TikTok, etc.)
    if is_youtube or is_tiktok:
        # Use yt-dlp to extract best audio as WAV
        tmp_dir = tempfile.mkdtemp()
        ydl_opts = {
            "format": "bestaudio/best",
            "outtmpl": os.path.join(tmp_dir, "%(id)s.%(ext)s"),
            "noplaylist": True,
            # Ignore shell/system proxy envs. In local dev this often points to
            # restricted corporate proxies and causes yt-dlp 403 tunnel failures.
            "proxy": "",
            "postprocessors": [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "wav",
                    "preferredquality": "192",
                }
            ],
            "quiet": True,
            "no_warnings": True,
        }

        try:
            with YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(audio_url, download=True)
                base_path = ydl.prepare_filename(info)
        except Exception as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Failed to download audio from YouTube: {exc}",
            ) from exc

        base = Path(base_path)
        wav_path = base.with_suffix(".wav")
        if wav_path.exists():
            return wav_path
        # Fallback: return whatever yt-dlp actually wrote
        if base.exists():
            return base

        raise HTTPException(
            status_code=400,
            detail="Video download did not produce an audio file.",
        )

    # Spotify links usually do not expose raw audio directly and are DRM-protected.
    # For now, we explicitly reject raw Spotify URLs and ask the caller to provide
    # a different source (e.g. YouTube, TikTok, or a direct audio file URL).
    if is_spotify:
        raise HTTPException(
            status_code=400,
            detail=(
                "Spotify links are not supported directly. "
                "Please use a YouTube, TikTok, or direct audio URL instead."
            ),
        )

    # Generic: attempt to stream the URL directly (works for direct audio files, some CDNs, etc.)
    resp = requests.get(audio_url, stream=True, timeout=60)
    if resp.status_code != 200:
        raise HTTPException(
            status_code=400, detail="Failed to download audio from URL."
        )

    suffix = ".audio"
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(tmp_fd, "wb") as f:
        for chunk in resp.iter_content(chunk_size=8192):
            if chunk:
                f.write(chunk)
    return Path(tmp_path)


def _estimate_bpm(audio_path: Path, max_audio_seconds: float = 120.0) -> float:
    """
    Estimate BPM from audio so quantization uses the real beat grid.
    Returns 120.0 on failure or if librosa is not available.
    """
    if not LIBROSA_AVAILABLE:
        return 120.0
    try:
        y, sr = librosa.load(
            str(audio_path), sr=22050, mono=True, duration=max_audio_seconds
        )
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr, units="time")
        if isinstance(tempo, np.ndarray):
            tempo = float(tempo.flatten()[0]) if tempo.size else 120.0
        tempo = float(tempo)
        if tempo < 40 or tempo > 240:
            return 120.0
        return tempo
    except Exception:
        return 120.0


def _estimate_time_signature(audio_path: Path, max_audio_seconds: float = 90.0) -> tuple[int, int]:
    """
    Guess simple meter from beat onsets (3/4 vs 4/4). Denominator is always 4 here.
    """
    if not LIBROSA_AVAILABLE:
        return (4, 4)
    try:
        y, sr = librosa.load(
            str(audio_path), sr=22050, mono=True, duration=max_audio_seconds
        )
        hop = 512
        onset = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
        _, beat_frames = librosa.beat.beat_track(
            onset_envelope=onset, sr=sr, hop_length=hop, tightness=85
        )
        if len(beat_frames) < 14:
            return (4, 4)
        strengths: list[float] = []
        for bf in beat_frames[: min(72, len(beat_frames))]:
            bi = int(np.clip(round(float(bf)), 0, len(onset) - 1))
            strengths.append(float(onset[bi]))
        if len(strengths) < 14:
            return (4, 4)

        def accent_score(period: int) -> float:
            s = 0.0
            c = 0
            for i in range(len(strengths)):
                if i % period == 0:
                    s += strengths[i]
                    c += 1
            return s / max(1, c)

        s3 = accent_score(3)
        s4 = accent_score(4)
        # Waltz / 3-feel: every 3rd beat is more consistently accented than 4/4 grid.
        if s3 > s4 * 1.14:
            return (3, 4)
        return (4, 4)
    except Exception:
        return (4, 4)


def _arrange_playable_piano(
    pm: pretty_midi.PrettyMIDI,
    level: str,
    split_pitch: int = 60,
    bucket_eps: float = 0.042,
) -> pretty_midi.PrettyMIDI:
    """
    Turn a dense transcription into a *piano arrangement* (playable two-hand part),
    not a literal dump of everything the model thought it heard.

    Per short time slice:
    - Right hand (pitch >= split_pitch): keep only the top 1–3 notes (melody / upper harmony).
    - Left hand (pitch < split_pitch): keep only the bottom 1–2 notes (bass / shell).
    """
    if level == "simple":
        # Easy should stay playable but not feel "hole-punched".
        # Keep a little RH harmony while keeping LH simple.
        max_rh, max_lh = 2, 1
    elif level == "detailed":
        max_rh, max_lh = 3, 2
    else:
        max_rh, max_lh = 2, 2

    for inst in pm.instruments:
        if getattr(inst, "is_drum", False) or not inst.notes:
            continue
        notes = sorted(inst.notes, key=lambda n: (n.start, n.pitch))
        out = []
        i = 0
        prev_rh_pitch = None
        while i < len(notes):
            t0 = notes[i].start
            j = i + 1
            while j < len(notes) and notes[j].start <= t0 + bucket_eps:
                j += 1
            bucket = notes[i:j]
            rh = [n for n in bucket if n.pitch >= split_pitch]
            lh = [n for n in bucket if n.pitch < split_pitch]

            if rh:
                rh.sort(key=lambda n: (n.pitch, n.velocity))
                if len(rh) > max_rh:
                    if level == "simple":
                        # Melody continuity: keep highest note + one that best connects
                        # to the previous RH center (or next-highest when unknown).
                        highest = rh[-1]
                        if prev_rh_pitch is None:
                            companion = rh[-2]
                        else:
                            companion = min(
                                rh[:-1],
                                key=lambda n: (
                                    abs(n.pitch - prev_rh_pitch),
                                    -n.velocity,
                                ),
                            )
                        rh_keep = sorted(
                            {id(highest): highest, id(companion): companion}.values(),
                            key=lambda n: (n.pitch, n.velocity),
                        )
                    else:
                        rh_keep = rh[-max_rh:]
                else:
                    rh_keep = list(rh)
            else:
                rh_keep = []

            if lh:
                lh.sort(key=lambda n: (n.pitch, -n.velocity))
                lh_keep = lh[:max_lh]
            else:
                lh_keep = []

            if not rh_keep and not lh_keep and bucket:
                # e.g. everything clustered one side after split — take strongest single note
                one = max(bucket, key=lambda n: (n.velocity, n.end - n.start))
                out.append(one)
            else:
                out.extend(rh_keep)
                out.extend(lh_keep)
            if rh_keep:
                prev_rh_pitch = max(rh_keep, key=lambda n: n.pitch).pitch
            i = j

        inst.notes = sorted(out, key=lambda n: (n.start, n.pitch, n.end))
    return pm


def _clean_midi(
    pm: pretty_midi.PrettyMIDI,
    level: str,
    bpm: float = 120.0,
) -> pretty_midi.PrettyMIDI:
    """
    Denoise, quantize, and thin note lists (prep for human playback).

    This is *not* the final musical intent layer — :func:`_arrange_playable_piano`
    runs after this to produce a deliberate two-hand reduction.
    """
    if level == "simple":  # Easy: preserve flow while still removing obvious noise.
        min_duration = 0.075
        min_velocity = 8
        max_notes_per_chord = 4
        min_rearticulation = 0.095
        max_chord_span = 20
        sustain_merge_gap = 0.19
        max_left_hand_notes = 2
        max_right_hand_notes = 2
    elif level == "detailed":  # Hard — still rich, but actually playable (was “grandmaster” dense)
        min_duration = 0.05
        min_velocity = 12
        max_notes_per_chord = 4
        min_rearticulation = 0.068
        max_chord_span = 24
        sustain_merge_gap = 0.09
        max_left_hand_notes = 2
        max_right_hand_notes = 2
    else:  # balanced (Medium)
        min_duration = 0.075
        min_velocity = 12
        max_notes_per_chord = 4
        min_rearticulation = 0.092
        max_chord_span = 22
        sustain_merge_gap = 0.13
        max_left_hand_notes = 2
        max_right_hand_notes = 2

    tempo = max(40.0, min(240.0, bpm))
    seconds_per_beat = 60.0 / tempo
    if level == "simple":
        # Keep 16th grid so rhythmic character is preserved.
        # Simplicity comes from voice-density limits, not rhythm collapse.
        grid = seconds_per_beat / 4.0  # 16th notes
    elif level == "detailed":
        # Finer grid to retain more rhythmic detail
        grid = seconds_per_beat / 6.0  # 24th notes
    else:
        grid = seconds_per_beat / 4.0  # 16th notes

    chord_snap_sec = 0.032  # chord alignment (slightly looser = less stiff)
    gap_fill_sec = 0.030   # small gap fill for smoother legato
    velocity_alpha = 0.5   # smoother dynamics along time

    for instrument in pm.instruments:
        cleaned = []
        for note in instrument.notes:
            dur = note.end - note.start
            if dur < min_duration or note.velocity < min_velocity:
                continue
            if note.end <= note.start:
                continue
            cleaned.append(note)
        instrument.notes = cleaned
        if not instrument.notes:
            continue

        instrument.notes.sort(key=lambda n: (n.start, n.pitch))

        # Remove isolated blip notes (much shorter than median, no nearby same-pitch)
        blip_ratio = 0.36 if level == "simple" else 0.42
        if len(instrument.notes) > 4:
            durations = [n.end - n.start for n in instrument.notes]
            median_dur = float(np.median(durations))
            kept = []
            for i, note in enumerate(instrument.notes):
                dur = note.end - note.start
                if dur >= median_dur * blip_ratio:
                    kept.append(note)
                    continue
                # Check for nearby same-pitch note within 0.2s
                has_near = any(
                    n.pitch == note.pitch and 0 < abs(n.start - note.start) < 0.2
                    for j, n in enumerate(instrument.notes) if j != i
                )
                if has_near or dur >= min_duration * 1.5:
                    kept.append(note)
            instrument.notes = kept

        # Chord snapping: group notes that start within chord_snap_sec, align to earliest
        i = 0
        while i < len(instrument.notes):
            t0 = instrument.notes[i].start
            j = i + 1
            while j < len(instrument.notes) and instrument.notes[j].start <= t0 + chord_snap_sec:
                j += 1
            aligned = min(n.start for n in instrument.notes[i:j])
            for k in range(i, j):
                instrument.notes[k].start = aligned
            i = j

        # Quantize to grid
        for note in instrument.notes:
            note.start = round(note.start / grid) * grid
            note.end = max(note.start + min_duration, round(note.end / grid) * grid)

        # Merge same-pitch duplicates that are very close
        merged = []
        for note in instrument.notes:
            if (
                merged
                and merged[-1].pitch == note.pitch
                and abs(merged[-1].start - note.start) < grid / 4.0
            ):
                merged[-1].end = max(merged[-1].end, note.end)
            else:
                merged.append(note)
        instrument.notes = merged

        # Note-end smoothing: extend note end slightly to avoid choppy gaps
        for i, note in enumerate(instrument.notes):
            end_candidates = [note.end]
            for other in instrument.notes:
                if other.pitch == note.pitch and other.start > note.start:
                    gap = other.start - note.end
                    if 0 < gap <= gap_fill_sec:
                        end_candidates.append(other.start - 0.005)
                    break
            note.end = min(
                max(end_candidates),
                round((note.end + gap_fill_sec) / grid) * grid,
            )
            note.end = max(note.end, note.start + min_duration)
            note.end = min(note.end, note.start + 60.0)  # sanity: no 1-minute notes

        # Velocity smoothing along time (exponential moving average)
        if len(instrument.notes) > 1:
            velocities = [n.velocity for n in instrument.notes]
            smoothed = [velocities[0]]
            for i in range(1, len(velocities)):
                s = velocity_alpha * smoothed[-1] + (1 - velocity_alpha) * velocities[i]
                smoothed.append(int(round(max(1, min(127, s)))))
            for n, v in zip(instrument.notes, smoothed):
                n.velocity = v

        # Keep output playable while preserving musical identity:
        # - cap dense chord clusters
        # - avoid impossible ultra-fast same-pitch re-articulation
        instrument.notes = _enforce_playability(
            instrument.notes,
            chord_snap_sec=chord_snap_sec,
            max_notes_per_chord=max_notes_per_chord,
            min_rearticulation=min_rearticulation,
            max_chord_span=max_chord_span,
        )
        instrument.notes = _enforce_hand_density(
            instrument.notes,
            chord_snap_sec=chord_snap_sec,
            split_pitch=60,
            max_left=max_left_hand_notes,
            max_right=max_right_hand_notes,
        )
        instrument.notes = _retain_rhythmic_anchors(
            instrument.notes,
            bpm=tempo,
            grid=grid,
            min_velocity=max(8, int(min_velocity * 0.8)),
        )
        instrument.notes = _consolidate_sustains(
            instrument.notes,
            merge_gap=sustain_merge_gap,
            min_overlap=0.0,
        )
        instrument.notes = _prune_decorative_notes(
            instrument.notes, level=level, bpm=tempo
        )

    return pm


def _consolidate_sustains(
    notes: list,
    merge_gap: float,
    min_overlap: float = 0.0,
) -> list:
    """
    Merge repeated same-pitch notes that are very close together into one
    sustained note. This removes machine-gun retrigger artifacts while keeping
    intentional re-articulation when the gap is clearly larger.
    """
    if not notes:
        return notes

    # Process pitch-by-pitch so lines are independent.
    by_pitch = {}
    for n in notes:
        by_pitch.setdefault(n.pitch, []).append(n)

    merged_all = []
    for _pitch, seq in by_pitch.items():
        seq.sort(key=lambda n: (n.start, n.end))
        if not seq:
            continue

        cur = seq[0]
        for nxt in seq[1:]:
            # Positive gap => separation, negative => overlap.
            gap = nxt.start - cur.end
            overlap = cur.end - nxt.start if nxt.start < cur.end else 0.0

            can_merge = (gap <= merge_gap) and (overlap >= min_overlap)
            if can_merge:
                # Extend sustain and keep the stronger attack velocity.
                cur.end = max(cur.end, nxt.end)
                cur.velocity = max(cur.velocity, nxt.velocity)
            else:
                merged_all.append(cur)
                cur = nxt

        merged_all.append(cur)

    merged_all.sort(key=lambda n: (n.start, n.pitch, n.end))
    return merged_all


def _enforce_hand_density(
    notes: list,
    chord_snap_sec: float,
    split_pitch: int,
    max_left: int,
    max_right: int,
) -> list:
    """
    Cap simultaneous density per hand region to keep passages playable.
    """
    if not notes:
        return notes

    sorted_notes = sorted(notes, key=lambda n: (n.start, n.pitch, n.end))
    out = []
    i = 0
    while i < len(sorted_notes):
        t0 = sorted_notes[i].start
        j = i + 1
        while j < len(sorted_notes) and sorted_notes[j].start <= t0 + chord_snap_sec:
            j += 1
        bucket = sorted_notes[i:j]

        left = [n for n in bucket if n.pitch < split_pitch]
        right = [n for n in bucket if n.pitch >= split_pitch]

        if len(left) > max_left:
            left = sorted(
                left,
                key=lambda n: ((n.velocity * 2.0) + (n.end - n.start), -abs(n.pitch - 48)),
                reverse=True,
            )[:max_left]
        if len(right) > max_right:
            right = sorted(
                right,
                key=lambda n: ((n.velocity * 2.0) + (n.end - n.start), -abs(n.pitch - 72)),
                reverse=True,
            )[:max_right]

        out.extend(left + right)
        i = j

    return sorted(out, key=lambda n: (n.start, n.pitch, n.end))


def _retain_rhythmic_anchors(
    notes: list,
    bpm: float,
    grid: float,
    min_velocity: int,
) -> list:
    """
    Ensure structural rhythm anchors survive simplification:
    prefer downbeat / strong-beat onsets and prominent attack points.
    """
    if not notes:
        return notes

    sec_per_beat = 60.0 / max(40.0, min(240.0, bpm))
    beat_tol = max(grid, 0.03)
    out = list(notes)

    def is_strong_beat(t: float) -> bool:
        beat_pos = (t / sec_per_beat) % 4.0
        # Keep beat 1 and beat 3 anchors (roughly).
        return abs(beat_pos - 0.0) <= 0.15 or abs(beat_pos - 2.0) <= 0.15

    # If a strong beat has no onset nearby, promote one local candidate.
    max_t = max((n.end for n in notes), default=0.0)
    t = 0.0
    while t <= max_t + beat_tol:
        if is_strong_beat(t):
            has_anchor = any(abs(n.start - t) <= beat_tol for n in out)
            if not has_anchor:
                cands = [
                    n for n in notes
                    if abs(n.start - t) <= (sec_per_beat * 0.35)
                    and n.velocity >= min_velocity
                ]
                if cands:
                    chosen = max(cands, key=lambda n: (n.velocity, n.end - n.start))
                    out.append(chosen)
        t += sec_per_beat

    # Dedup (can add existing objects from source list)
    uniq = {}
    for n in out:
        k = (n.pitch, round(n.start, 4), round(n.end, 4))
        if k not in uniq or n.velocity > uniq[k].velocity:
            uniq[k] = n
    return sorted(uniq.values(), key=lambda n: (n.start, n.pitch, n.end))


def _prune_decorative_notes(notes: list, level: str, bpm: float) -> list:
    """
    Drop very short, quiet notes that sit alone in time+pitch space — typical
    Basic-Pitch 'sparkles' that make the part feel busy and unplayable.
    Keeps notes on strong beats, clear melodic neighbors, or high-register peaks
    (avoids deleting brief climax / belt notes that have no nearby pitch).
    """
    if len(notes) < 2:
        return notes

    tempo = max(40.0, min(240.0, bpm))
    sec_per_beat = 60.0 / tempo

    if level == "simple":
        max_dur, max_vel, t_win, p_win = 0.09, 28, 0.15, 4
    elif level == "detailed":
        max_dur, max_vel, t_win, p_win = 0.052, 38, 0.09, 3
    else:
        max_dur, max_vel, t_win, p_win = 0.07, 34, 0.12, 4

    beat_tol = max(sec_per_beat * 0.11, 0.035)

    def on_strong_beat(t: float) -> bool:
        pos = (t / sec_per_beat) % 4.0
        if pos <= beat_tol or pos >= 4.0 - beat_tol:
            return True
        return abs(pos - 2.0) <= beat_tol

    sorted_n = sorted(notes, key=lambda n: (n.start, n.pitch))
    out = []
    for n in sorted_n:
        dur = n.end - n.start
        if dur >= max_dur or n.velocity >= max_vel:
            out.append(n)
            continue
        if on_strong_beat(n.start):
            out.append(n)
            continue
        # Climaxes / belts: very high notes are often short and "lonely" in pitch
        # (no neighbor within a fourth) — old logic deleted them as "sparkles".
        if n.pitch >= 76:
            out.append(n)
            continue
        t0, t1 = n.start - t_win, n.start + t_win
        # Wider pitch neighborhood above the staff so stepwise melody still counts.
        pw = p_win + 4 if n.pitch >= 67 else p_win
        lo, hi = n.pitch - pw, n.pitch + pw
        has_neighbor = False
        for m in sorted_n:
            if m is n:
                continue
            if m.start < t0:
                continue
            if m.start > t1:
                break
            if lo <= m.pitch <= hi:
                has_neighbor = True
                break
        if has_neighbor:
            out.append(n)
        # else: drop weak isolated blip

    return sorted(out, key=lambda x: (x.start, x.pitch, x.end))


def _enforce_playability(
    notes: list,
    chord_snap_sec: float,
    max_notes_per_chord: int,
    min_rearticulation: float,
    max_chord_span: int,
) -> list:
    """
    Constrain transcription to human-playable density.
    """
    if not notes:
        return notes

    sorted_notes = sorted(notes, key=lambda n: (n.start, n.pitch, n.end))

    # Group near-simultaneous notes into chord buckets.
    buckets = []
    i = 0
    while i < len(sorted_notes):
        t0 = sorted_notes[i].start
        j = i + 1
        while j < len(sorted_notes) and sorted_notes[j].start <= t0 + chord_snap_sec:
            j += 1
        buckets.append(sorted_notes[i:j])
        i = j

    # Trim each chord to a playable thickness + span.
    playable = []
    for bucket in buckets:
        if len(bucket) <= 1:
            playable.extend(bucket)
            continue

        # Preserve song identity anchors:
        # - lowest note (bass contour)
        # - highest note (melody contour)
        bucket_by_pitch = sorted(bucket, key=lambda n: (n.pitch, -n.velocity))
        low = bucket_by_pitch[0]
        high = bucket_by_pitch[-1]

        kept = []
        seen_ids = set()
        for anchor in (low, high):
            key = (anchor.pitch, round(anchor.start, 4), round(anchor.end, 4))
            if key not in seen_ids:
                kept.append(anchor)
                seen_ids.add(key)

        remaining_slots = max(0, max_notes_per_chord - len(kept))
        if remaining_slots > 0:
            others = [
                n
                for n in bucket
                if (n.pitch, round(n.start, 4), round(n.end, 4)) not in seen_ids
            ]
            others.sort(key=lambda n: (n.velocity, -abs(n.pitch - 60)), reverse=True)
            kept.extend(others[:remaining_slots])

        # Per-hand density cap (simple physicality model).
        split = 60
        left = sorted([n for n in kept if n.pitch < split], key=lambda n: n.pitch)
        right = sorted([n for n in kept if n.pitch >= split], key=lambda n: n.pitch)
        left_max = max(1, max_notes_per_chord // 2)
        right_max = max(1, max_notes_per_chord - left_max)
        if len(left) > left_max:
            # keep stronger outer+inner tones
            left = sorted(left, key=lambda n: (n.velocity, -abs(n.pitch - 48)), reverse=True)[:left_max]
        if len(right) > right_max:
            right = sorted(right, key=lambda n: (n.velocity, -abs(n.pitch - 72)), reverse=True)[:right_max]
        kept = left + right

        # Keep chord hand-span plausible.
        kept.sort(key=lambda n: n.pitch)
        while len(kept) > 1 and (kept[-1].pitch - kept[0].pitch) > max_chord_span:
            # Drop weaker extreme.
            left = kept[0]
            right = kept[-1]
            drop_left = left.velocity <= right.velocity
            if drop_left:
                kept = kept[1:]
            else:
                kept = kept[:-1]
        playable.extend(kept)

    # Prevent superhuman repeated-strike speed on same pitch.
    playable.sort(key=lambda n: (n.pitch, n.start, n.end))
    thinned = []
    last_by_pitch = {}
    for n in playable:
        prev = last_by_pitch.get(n.pitch)
        if prev is None:
            thinned.append(n)
            last_by_pitch[n.pitch] = n
            continue

        gap = n.start - prev.start
        if gap < min_rearticulation:
            # Keep the stronger of two near-identical strikes.
            if n.velocity > prev.velocity:
                try:
                    thinned.remove(prev)
                except ValueError:
                    pass
                thinned.append(n)
                last_by_pitch[n.pitch] = n
            # otherwise drop n
        else:
            thinned.append(n)
            last_by_pitch[n.pitch] = n

    return sorted(thinned, key=lambda n: (n.start, n.pitch, n.end))


def _run_basic_pitch_pass(
    model: Model,
    audio_path: Path,
    onset_threshold: float,
    frame_threshold: float,
    minimum_note_length: float,
) -> pretty_midi.PrettyMIDI:
    """
    Single Basic Pitch inference pass.
    """
    _, midi_data, _ = predict(
        str(audio_path),
        model,
        onset_threshold=onset_threshold,
        frame_threshold=frame_threshold,
        minimum_note_length=minimum_note_length,
        minimum_frequency=27.5,
        maximum_frequency=4186.0,
        melodia_trick=True,
    )
    return midi_data


def _count_notes(pm: pretty_midi.PrettyMIDI) -> int:
    return sum(len(instr.notes) for instr in pm.instruments)


def _offset_midi(pm: pretty_midi.PrettyMIDI, offset_sec: float) -> pretty_midi.PrettyMIDI:
    if offset_sec <= 0:
        return pm
    for instr in pm.instruments:
        for n in instr.notes:
            n.start += offset_sec
            n.end += offset_sec
    return pm


def _run_basic_pitch_multi_pass(
    model: Model,
    audio_path: Path,
    level: str,
    onset_bias: float = 0.0,
    frame_bias: float = 0.0,
    length_scale: float = 1.0,
    inference_mode: str = "quality",
) -> pretty_midi.PrettyMIDI:
    """
    Multi-pass Basic Pitch for one audio source (or one chunk).
    Bias parameters let us adapt sensitivity per chunk.

    inference_mode:
      - "quality": primary + sensitive + short-note pass (max recall; slowest)
      - "fast": primary + sensitive (default for all users; strong MIDI, fewer runs)
      - "ultra": single primary pass (emergency speed; lowest recall)
    """
    def clamp01(x: float) -> float:
        return max(0.05, min(0.95, x))

    def clamp_len(x: float) -> float:
        return max(30.0, min(120.0, x))

    primary = _run_basic_pitch_pass(
        model,
        audio_path,
        onset_threshold=clamp01(0.40 + onset_bias),
        frame_threshold=clamp01(0.24 + frame_bias),
        minimum_note_length=clamp_len(65.0 * length_scale),
    )

    if inference_mode == "ultra":
        return primary

    sensitive = _run_basic_pitch_pass(
        model,
        audio_path,
        onset_threshold=clamp01(
            (0.31 if level == "detailed" else (0.38 if level == "simple" else 0.34))
            + onset_bias
        ),
        frame_threshold=clamp01(
            (0.18 if level == "detailed" else (0.23 if level == "simple" else 0.20))
            + frame_bias
        ),
        minimum_note_length=clamp_len(
            (50.0 if level == "detailed" else (62.0 if level == "simple" else 55.0))
            * length_scale
        ),
    )
    merged = _merge_midis(primary, sensitive, start_tol=0.028, end_tol=0.05)

    if inference_mode == "fast" or level == "simple":
        return merged

    short_note_pass = _run_basic_pitch_pass(
        model,
        audio_path,
        onset_threshold=clamp01(0.36 + onset_bias),
        frame_threshold=clamp01(0.19 + frame_bias),
        minimum_note_length=clamp_len((42.0 if level == "detailed" else 48.0) * length_scale),
    )
    merged = _merge_midis(merged, short_note_pass, start_tol=0.022, end_tol=0.04)

    return merged


def _run_basic_pitch(
    model: Model,
    audio_path: Path,
    level: str = "balanced",
    inference_mode: str = "quality",
) -> pretty_midi.PrettyMIDI:
    """
    Run Basic Pitch with recall-friendly thresholds.
    We recover musical coverage first; cleanup handles noise afterward.
    """
    if inference_mode == "quality":
        chunk_sec, overlap_sec, min_duration_for_chunks = 26.0, 4.0, 35.0
    elif inference_mode == "fast":
        chunk_sec, overlap_sec, min_duration_for_chunks = 48.0, 3.2, 32.0
    else:  # ultra — default path: huge windows, minimal overlap = fewest BP runs
        chunk_sec, overlap_sec, min_duration_for_chunks = 72.0, 2.4, 16.0

    # Segment + overlap inference gives better section consistency on long songs.
    if LIBROSA_AVAILABLE and SOUNDFILE_AVAILABLE:
        try:
            y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
            duration = len(y) / float(sr) if sr > 0 else 0.0
            if duration > min_duration_for_chunks:
                hop = max(1.0, chunk_sec - overlap_sec)
                merged_all = None
                starts = np.arange(0.0, max(0.0, duration - 0.001), hop)

                for start in starts:
                    end = min(duration, start + chunk_sec)
                    i0 = int(round(start * sr))
                    i1 = int(round(end * sr))
                    chunk = y[i0:i1]
                    if chunk.size == 0:
                        continue

                    # Adaptive sensitivity by chunk loudness.
                    rms = float(np.sqrt(np.mean(np.square(chunk))) + 1e-8)
                    rms_db = 20.0 * np.log10(rms)
                    onset_bias = 0.0
                    frame_bias = 0.0
                    length_scale = 1.0
                    if rms_db < -30.0:
                        onset_bias -= 0.03
                        frame_bias -= 0.02
                        length_scale *= 0.92
                    elif rms_db > -16.0:
                        onset_bias += 0.02
                        frame_bias += 0.01
                        length_scale *= 1.08

                    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                        tmp_chunk_path = Path(tmp.name)
                    try:
                        sf.write(str(tmp_chunk_path), chunk, sr)
                        pm_chunk = _run_basic_pitch_multi_pass(
                            model,
                            tmp_chunk_path,
                            level=level,
                            onset_bias=onset_bias,
                            frame_bias=frame_bias,
                            length_scale=length_scale,
                            inference_mode=inference_mode,
                        )
                        pm_chunk = _offset_midi(pm_chunk, float(start))
                        if merged_all is None:
                            merged_all = pm_chunk
                        else:
                            merged_all = _merge_midis(
                                merged_all, pm_chunk, start_tol=0.045, end_tol=0.07
                            )
                    finally:
                        try:
                            if tmp_chunk_path.exists():
                                tmp_chunk_path.unlink()
                        except Exception:
                            pass

                if merged_all is not None:
                    return merged_all
        except Exception:
            # Fallback to full-file inference below.
            pass

    # Fallback: full-file multi-pass inference.
    return _run_basic_pitch_multi_pass(
        model, audio_path, level=level, inference_mode=inference_mode
    )


def _merge_midis(
    primary: pretty_midi.PrettyMIDI,
    secondary: pretty_midi.PrettyMIDI,
    start_tol: float = 0.03,
    end_tol: float = 0.05,
) -> pretty_midi.PrettyMIDI:
    """
    Merge notes from `secondary` into `primary` while avoiding near-duplicates.
    This improves recall in sections missed by one source (mix vs separated stem).
    """
    merged = pretty_midi.PrettyMIDI()

    # Preserve tempo/key/time-signature metadata where available.
    try:
        merged._tick_scales = list(getattr(primary, "_tick_scales", []))
    except Exception:
        pass

    max_instr = max(len(primary.instruments), len(secondary.instruments))
    for i in range(max_instr):
        p_instr = primary.instruments[i] if i < len(primary.instruments) else None
        s_instr = secondary.instruments[i] if i < len(secondary.instruments) else None

        if p_instr is not None:
            base_program = p_instr.program
            base_is_drum = p_instr.is_drum
            base_name = p_instr.name
        elif s_instr is not None:
            base_program = s_instr.program
            base_is_drum = s_instr.is_drum
            base_name = s_instr.name
        else:
            continue

        out = pretty_midi.Instrument(
            program=base_program, is_drum=base_is_drum, name=base_name
        )

        existing = []
        if p_instr is not None:
            for n in p_instr.notes:
                out.notes.append(n)
                existing.append(n)

        if s_instr is not None:
            for n in s_instr.notes:
                dup = False
                dup_index = -1
                for e in existing:
                    if (
                        e.pitch == n.pitch
                        and abs(e.start - n.start) <= start_tol
                        and abs(e.end - n.end) <= end_tol
                    ):
                        dup = True
                        dup_index = existing.index(e)
                        break
                if not dup:
                    out.notes.append(n)
                    existing.append(n)
                else:
                    # Confidence proxy: prefer stronger, longer note
                    # when two notes are near-duplicates.
                    try:
                        e = existing[dup_index]
                        e_score = (e.velocity * 2.0) + (e.end - e.start)
                        n_score = (n.velocity * 2.0) + (n.end - n.start)
                        if n_score > e_score:
                            out.notes.remove(e)
                            out.notes.append(n)
                            existing[dup_index] = n
                    except Exception:
                        pass

        out.notes.sort(key=lambda n: (n.start, n.pitch, n.end))
        merged.instruments.append(out)

    return merged


def _collapse_to_single_piano(pm: pretty_midi.PrettyMIDI) -> pretty_midi.PrettyMIDI:
    """Merge all non-drum tracks into one acoustic grand instrument."""
    out = pretty_midi.PrettyMIDI()
    piano = pretty_midi.Instrument(program=0, is_drum=False, name="piano")
    for ins in pm.instruments:
        if ins.is_drum:
            continue
        piano.notes.extend(ins.notes)
    piano.notes.sort(key=lambda n: (n.start, n.pitch, n.end))
    out.instruments.append(piano)
    return out


def _scale_velocities(pm: pretty_midi.PrettyMIDI) -> pretty_midi.PrettyMIDI:
    """
    Rescale velocities with a gentle curve so the middle range is slightly
    expanded (cleaner, more expressive playback). Output 30–112.
    """
    for instrument in pm.instruments:
        if not instrument.notes:
            continue
        velocities = [n.velocity for n in instrument.notes]
        lo, hi = min(velocities), max(velocities)
        span = hi - lo if hi > lo else 1
        for note in instrument.notes:
            n = (note.velocity - lo) / span
            n = n ** 0.92  # gentle curve: expand middle for cleaner dynamics
            note.velocity = int(30 + n * 82)
            note.velocity = max(1, min(127, note.velocity))
    return pm


@app.post("/transcribe", response_model=TranscriptionResponse)
def transcribe(req: TranscriptionRequest) -> TranscriptionResponse:
    if not req.audio_url:
        raise HTTPException(status_code=400, detail="audio_url is required.")

    input_path = _download_audio_to_temp(req.audio_url)

    try:
        model = _get_basic_pitch_model()

        # Fast pipeline (no Demucs, one waveform): default = 1 Basic Pitch pass + huge chunks.
        # TRANSCRIBER_MAX_QUALITY=1 → 2-pass + medium chunks.
        # TRANSCRIBER_DEEP_BP=1 → 3-pass + small chunks (slowest, best recall).
        if _env_truthy("TRANSCRIBER_DEEP_BP"):
            inference_mode = "quality"
        elif _env_truthy("TRANSCRIBER_MAX_QUALITY"):
            inference_mode = "fast"
        else:
            inference_mode = "ultra"

        print("[transcribe] full-mix Basic Pitch, inference_mode=", inference_mode)

        raw_midi = _run_basic_pitch(
            model, input_path, level=req.clean_level, inference_mode=inference_mode
        )
        merged_roles = _collapse_to_single_piano(raw_midi)
        print("[transcribe] raw notes (single piano):", _count_notes(merged_roles))

        bpm = _estimate_bpm(
            input_path,
            max_audio_seconds=(
                120.0
                if inference_mode == "quality"
                else (75.0 if inference_mode == "fast" else 45.0)
            ),
        )
        ts_max = (
            120.0
            if inference_mode == "quality"
            else (75.0 if inference_mode == "fast" else 50.0)
        )
        ts_num, ts_den = _estimate_time_signature(input_path, max_audio_seconds=ts_max)
        time_signature_str = f"{ts_num}/{ts_den}"

        cleaned_midi = _clean_midi(merged_roles, req.clean_level, bpm=bpm)
        cleaned_midi = _arrange_playable_piano(cleaned_midi, req.clean_level)
        # Second sustain pass after arrangement (merges duplicated slices into longer tones).
        gap2 = 0.15 if req.clean_level == "simple" else (0.09 if req.clean_level == "detailed" else 0.12)
        for inst in cleaned_midi.instruments:
            if not getattr(inst, "is_drum", False) and inst.notes:
                inst.notes = _consolidate_sustains(inst.notes, merge_gap=gap2, min_overlap=0.0)
        cleaned_midi = _scale_velocities(cleaned_midi)
        print(
            "[transcribe] arranged piano notes:",
            _count_notes(cleaned_midi),
            "bpm=",
            bpm,
            "time_signature=",
            time_signature_str,
        )

        try:
            cleaned_midi.time_signature_changes = [
                pretty_midi.TimeSignature(ts_num, ts_den, 0.0)
            ]
        except Exception:
            pass

        try:
            tempo_pm = pretty_midi.PrettyMIDI(initial_tempo=float(bpm))
            tempo_pm.instruments = list(cleaned_midi.instruments)
            if getattr(cleaned_midi, "time_signature_changes", None):
                tempo_pm.time_signature_changes = list(
                    cleaned_midi.time_signature_changes
                )
            cleaned_midi = tempo_pm
        except Exception:
            pass

        midi_id = uuid.uuid4().hex
        midi_path = MEDIA_ROOT / f"{midi_id}.mid"
        cleaned_midi.write(str(midi_path))

        base_url = os.environ.get("TRANSCRIBER_PUBLIC_BASE_URL")
        if not base_url:
            base_url = "http://localhost:8000"

        midi_url = f"{base_url.rstrip('/')}/media/{midi_path.name}"

        return TranscriptionResponse(
            midi_url=midi_url,
            pdf_url=None,
            time_signature=time_signature_str,
        )
    finally:
        try:
            if input_path.exists():
                input_path.unlink()
        except Exception:
            pass
