import os
import tempfile
import uuid
import ssl
import wave
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


def _validated_clean_level(level: str) -> str:
    """`clean_level` must be exactly `simple` or `balanced` (case-insensitive trim)."""
    key = str(level).strip().lower()
    if key not in ("simple", "balanced"):
        raise HTTPException(
            status_code=400,
            detail="clean_level must be 'simple' or 'balanced'.",
        )
    return key


class TranscriptionRequest(BaseModel):
    audio_url: str
    # Ignored (kept for API compatibility with older clients).
    use_separation: bool = True
    clean_level: str = "balanced"  # only "simple" | "balanced" — validated in handler


class TranscriptionResponse(BaseModel):
    midi_url: str
    raw_midi_url: str | None = None
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


def _supabase_storage_env() -> tuple[str, str, str] | None:
    """
    Return `(supabase_url, service_role_key, bucket)` when configured.
    Returns None when Supabase Storage is fully disabled.
    Raises HTTPException when partially configured.
    """
    supabase_url = (
        os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
        or os.environ.get("SUPABASE_URL")
        or ""
    ).strip().rstrip("/")
    service_role_key = (
        os.environ.get("SUPABASE_SECRET_KEY")
        or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or ""
    ).strip()
    bucket = (os.environ.get("SUPABASE_STORAGE_BUCKET") or "").strip()

    any_set = bool(supabase_url or service_role_key or bucket)
    all_set = bool(supabase_url and service_role_key and bucket)

    if not any_set:
        return None
    if not all_set:
        missing: list[str] = []
        if not supabase_url:
            missing.append("NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL)")
        if not service_role_key:
            missing.append("SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY)")
        if not bucket:
            missing.append("SUPABASE_STORAGE_BUCKET")
        raise HTTPException(
            status_code=500,
            detail=(
                "Supabase Storage is partially configured. Missing env(s): "
                + ", ".join(missing)
            ),
        )
    return (supabase_url, service_role_key, bucket)


def _upload_to_supabase_storage(file_path: Path) -> str:
    """
    Upload file to Supabase Storage and return its public URL.
    """
    cfg = _supabase_storage_env()
    if cfg is None:
        raise HTTPException(
            status_code=500,
            detail="Supabase Storage upload requested but storage is not configured.",
        )

    supabase_url, service_role_key, bucket = cfg
    prefix = (os.environ.get("SUPABASE_STORAGE_PREFIX") or "midi").strip().strip("/")
    object_path = f"{prefix}/{file_path.name}" if prefix else file_path.name
    upload_url = f"{supabase_url}/storage/v1/object/{bucket}/{object_path}"

    headers = {
        "Authorization": f"Bearer {service_role_key}",
        "apikey": service_role_key,
        "x-upsert": "true",
        "Content-Type": "application/octet-stream",
    }

    with file_path.open("rb") as f:
        response = requests.post(
            upload_url,
            headers=headers,
            data=f,
            timeout=90,
        )

    if response.status_code not in (200, 201):
        body = (response.text or "").strip()
        if len(body) > 240:
            body = body[:240] + "..."
        raise HTTPException(
            status_code=500,
            detail=(
                f"Failed to upload MIDI to Supabase Storage "
                f"(status {response.status_code}). {body}"
            ),
        )

    return f"{supabase_url}/storage/v1/object/public/{bucket}/{object_path}"


def _download_audio_to_temp(audio_url: str, max_audio_seconds: float = 300.0) -> Path:
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
    is_instagram = False
    is_spotify = False
    if parsed and parsed.hostname:
        host = parsed.hostname.lower()
        if "youtube.com" in host or "youtu.be" in host:
            is_youtube = True
        elif "tiktok.com" in host:
            is_tiktok = True
        elif "instagram.com" in host:
            is_instagram = True
        elif "spotify.com" in host:
            is_spotify = True

    # Use yt-dlp for platforms that yt-dlp supports well (YouTube, TikTok, etc.)
    if is_youtube or is_tiktok or is_instagram:
        # Use yt-dlp metadata to fail early on over-length sources.
        if max_audio_seconds > 0.0:
            metadata_opts = {
                "noplaylist": True,
                "proxy": "",
                "quiet": True,
                "no_warnings": True,
            }
            try:
                with YoutubeDL(metadata_opts) as ydl:
                    info = ydl.extract_info(audio_url, download=False)
                duration = info.get("duration") if isinstance(info, dict) else None
                if isinstance(duration, (int, float)) and duration > max_audio_seconds:
                    raise HTTPException(
                        status_code=400,
                        detail=_duration_limit_error_detail(
                            float(duration), max_audio_seconds
                        ),
                    )
            except HTTPException:
                raise
            except Exception:
                # If metadata probing fails, continue and rely on post-download guard.
                pass

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


def _estimate_audio_duration_seconds(audio_path: Path) -> float | None:
    """
    Best-effort source duration probe in seconds.
    Returns None if duration cannot be determined reliably.
    """
    # Prefer header metadata via soundfile when available.
    if SOUNDFILE_AVAILABLE and sf is not None:
        try:
            info = sf.info(str(audio_path))
            dur = float(getattr(info, "duration", 0.0) or 0.0)
            if dur > 0.0:
                return dur
        except Exception:
            pass

    # librosa can usually infer duration for many codecs.
    if LIBROSA_AVAILABLE:
        try:
            dur = float(librosa.get_duration(path=str(audio_path)))
            if dur > 0.0:
                return dur
        except Exception:
            pass

    # Stdlib fallback for WAV files.
    try:
        with wave.open(str(audio_path), "rb") as wf:
            fr = wf.getframerate()
            if fr and fr > 0:
                return float(wf.getnframes()) / float(fr)
    except Exception:
        pass

    return None


def _duration_limit_error_detail(actual_seconds: float, max_seconds: float) -> str:
    """Build a user-facing duration error in minutes and seconds."""
    actual_min = actual_seconds / 60.0
    max_min = max_seconds / 60.0
    return (
        f"Audio is too long ({actual_min:.1f} mins). "
        f"Max allowed is {max_min:.1f} mins"
    )


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
    - Simple: lighter texture (fewer simultaneous notes per hand).
    - Balanced: fuller arrangement while still thinned vs raw model output.
    """
    if level == "simple":
        # Keep easy mode clearly lighter than balanced in dense buckets,
        # but preserve one extra RH note so melody turns are less likely to vanish.
        max_rh, max_lh = 3, 2
    else:
        max_rh, max_lh = 4, 3

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
                        # Prioritize melodic continuity + top-line identity.
                        if prev_rh_pitch is None:
                            contour = max(
                                rh, key=lambda n: (n.pitch, n.velocity, n.end - n.start)
                            )
                        else:
                            contour = min(
                                rh,
                                key=lambda n: (
                                    abs(n.pitch - prev_rh_pitch),
                                    -n.velocity,
                                    -n.pitch,
                                ),
                            )
                        top = max(rh, key=lambda n: (n.pitch, n.velocity, n.end - n.start))
                        rh_keep = []
                        seen = set()
                        for cand in (contour, top):
                            key = (cand.pitch, round(cand.start, 4), round(cand.end, 4))
                            if key in seen:
                                continue
                            rh_keep.append(cand)
                            seen.add(key)
                            if len(rh_keep) >= max_rh:
                                break

                        if len(rh_keep) < max_rh:
                            remaining = sorted(
                                rh,
                                key=lambda n: (
                                    n.velocity,
                                    n.end - n.start,
                                    -abs(n.pitch - contour.pitch),
                                ),
                                reverse=True,
                            )
                            for n in remaining:
                                key = (n.pitch, round(n.start, 4), round(n.end, 4))
                                if key in seen:
                                    continue
                                rh_keep.append(n)
                                seen.add(key)
                                if len(rh_keep) >= max_rh:
                                    break
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


def _clone_pretty_midi(pm: pretty_midi.PrettyMIDI) -> pretty_midi.PrettyMIDI:
    """
    Lightweight deep-copy for note content so later arrangement passes can compare
    against a stable reference without mutating the same note objects.
    """
    out = pretty_midi.PrettyMIDI()
    for ins in pm.instruments:
        new_ins = pretty_midi.Instrument(
            program=ins.program,
            is_drum=ins.is_drum,
            name=ins.name,
        )
        for n in ins.notes:
            new_ins.notes.append(
                pretty_midi.Note(
                    velocity=int(max(1, min(127, n.velocity))),
                    pitch=int(max(0, min(127, n.pitch))),
                    start=float(max(0.0, n.start)),
                    end=float(max(n.start + 0.02, n.end)),
                )
            )
        new_ins.notes.sort(key=lambda n: (n.start, n.pitch, n.end))
        out.instruments.append(new_ins)
    return out


def _extract_vocal_anchor_ids(
    notes: list,
    bpm: float,
    level: str,
    split_pitch: int = 60,
) -> set:
    """
    Identify likely lead/vocal contour anchors from the raw note stream.
    We use top right-hand notes in short windows as melody proxies and keep
    their object identities through early cleanup passes.
    """
    if not notes:
        return set()

    tempo = max(40.0, min(240.0, bpm))
    sec_per_beat = 60.0 / tempo
    window = sec_per_beat * (0.42 if level == "simple" else 0.34)
    min_dur = max(0.045, sec_per_beat * 0.08)
    min_vel = 10 if level == "simple" else 6

    right = sorted(
        [
            n
            for n in notes
            if n.pitch >= split_pitch
            and n.velocity >= min_vel
            and (n.end - n.start) >= min_dur
        ],
        key=lambda n: (n.start, n.pitch, n.end),
    )
    if not right:
        return set()

    kept_ids = set()
    i = 0
    while i < len(right):
        t0 = right[i].start
        j = i + 1
        while j < len(right) and right[j].start <= t0 + window:
            j += 1
        bucket = right[i:j]
        chosen = max(bucket, key=lambda n: (n.pitch, n.velocity, n.end - n.start))
        kept_ids.add(id(chosen))
        i = j

    return kept_ids


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
        min_duration = 0.055
        min_velocity = 10
        max_notes_per_chord = 3
        # Keep repeated strikes manageable without erasing phrase identity.
        min_rearticulation = 0.16
        max_chord_span = 14
        sustain_merge_gap = 0.24
        max_left_hand_notes = 2
        max_right_hand_notes = 3
    else:  # balanced — closer to the transcription, still cleaned for playback
        min_duration = 0.055
        min_velocity = 8
        max_notes_per_chord = 6
        min_rearticulation = 0.048
        max_chord_span = 26
        sustain_merge_gap = 0.095
        max_left_hand_notes = 3
        max_right_hand_notes = 3

    tempo = max(40.0, min(240.0, bpm))
    seconds_per_beat = 60.0 / tempo
    if level == "simple":
        # Keep 16th grid so rhythmic character is preserved.
        grid = seconds_per_beat / 4.0  # 16th notes
    else:
        grid = seconds_per_beat / 4.0  # 16th notes

    chord_snap_sec = (
        min(0.032, max(0.020, seconds_per_beat * 0.055))
        if level == "simple"
        else min(0.028, max(0.018, seconds_per_beat * 0.048))
    )
    gap_fill_sec = 0.07 if level == "simple" else 0.026
    velocity_alpha = 0.48 if level == "simple" else 0.58

    for instrument in pm.instruments:
        source_notes = list(instrument.notes)
        vocal_anchor_ids = _extract_vocal_anchor_ids(
            source_notes,
            bpm=tempo,
            level=level,
            split_pitch=60,
        )
        cleaned = []
        for note in source_notes:
            dur = note.end - note.start
            is_vocal_anchor = id(note) in vocal_anchor_ids
            if dur < min_duration or note.velocity < min_velocity:
                if not is_vocal_anchor:
                    continue
                note.end = max(note.end, note.start + min_duration)
                note.velocity = int(max(note.velocity, min_velocity))
            if note.end <= note.start:
                continue
            cleaned.append(note)
        instrument.notes = cleaned
        if not instrument.notes:
            continue

        instrument.notes.sort(key=lambda n: (n.start, n.pitch))

        # Remove isolated blip notes (much shorter than median, no nearby same-pitch)
        blip_ratio = 0.32 if level == "simple" else 0.48
        if len(instrument.notes) > 4:
            durations = [n.end - n.start for n in instrument.notes]
            median_dur = float(np.median(durations))
            kept = []
            for i, note in enumerate(instrument.notes):
                if id(note) in vocal_anchor_ids:
                    kept.append(note)
                    continue
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

        # Quantize to grid.
        # Use ceil for note end so quantization does not shorten sustains and
        # accidentally introduce tiny gaps between events.
        for note in instrument.notes:
            note.start = round(note.start / grid) * grid
            note.end = max(note.start + min_duration, np.ceil(note.end / grid) * grid)

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

        # Note-end smoothing: extend note end slightly to avoid choppy gaps.
        # We bridge by same-pitch first, and fall back to next onset in the same hand.
        hand_gap_fill_sec = gap_fill_sec * (2.2 if level == "simple" else 1.8)
        for i, note in enumerate(instrument.notes):
            end_candidates = [note.end]
            same_hand_next = None
            note_is_right = note.pitch >= 60
            for other in instrument.notes:
                if other.start <= note.start:
                    continue
                if same_hand_next is None and (other.pitch >= 60) == note_is_right:
                    same_hand_next = other
                if other.pitch == note.pitch:
                    gap = other.start - note.end
                    if 0 < gap <= gap_fill_sec:
                        end_candidates.append(other.start - 0.005)
                    break
            if same_hand_next is not None:
                gap_hand = same_hand_next.start - note.end
                if 0 < gap_hand <= hand_gap_fill_sec:
                    end_candidates.append(same_hand_next.start - 0.006)
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
            preserve_note_ids=vocal_anchor_ids,
        )
        instrument.notes = _enforce_hand_density(
            instrument.notes,
            chord_snap_sec=chord_snap_sec,
            split_pitch=60,
            max_left=max_left_hand_notes,
            max_right=max_right_hand_notes,
            preserve_note_ids=vocal_anchor_ids,
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
            instrument.notes,
            level=level,
            bpm=tempo,
            preserve_note_ids=vocal_anchor_ids,
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
    preserve_note_ids: set | None = None,
) -> list:
    """
    Cap simultaneous density per hand region to keep passages playable.
    """
    if not notes:
        return notes

    protected = preserve_note_ids or set()
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
            locked = [n for n in left if id(n) in protected]
            rest = [n for n in left if id(n) not in protected]
            rest = sorted(
                rest,
                key=lambda n: ((n.velocity * 2.0) + (n.end - n.start), -abs(n.pitch - 48)),
                reverse=True,
            )
            keep = locked + rest[: max(0, max_left - len(locked))]
            left = sorted(keep, key=lambda n: (n.start, n.pitch, n.end))
        if len(right) > max_right:
            locked = [n for n in right if id(n) in protected]
            rest = [n for n in right if id(n) not in protected]
            rest = sorted(
                rest,
                key=lambda n: ((n.velocity * 2.0) + (n.end - n.start), -abs(n.pitch - 72)),
                reverse=True,
            )
            keep = locked + rest[: max(0, max_right - len(locked))]
            right = sorted(keep, key=lambda n: (n.start, n.pitch, n.end))

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


def _prune_decorative_notes(
    notes: list,
    level: str,
    bpm: float,
    preserve_note_ids: set | None = None,
) -> list:
    """
    Drop very short, quiet notes that sit alone in time+pitch space — typical
    Basic-Pitch 'sparkles' that make the part feel busy and unplayable.
    Keeps notes on strong beats, clear melodic neighbors, or high-register peaks
    (avoids deleting brief climax / belt notes that have no nearby pitch).
    """
    if len(notes) < 2:
        return notes

    protected = preserve_note_ids or set()
    tempo = max(40.0, min(240.0, bpm))
    sec_per_beat = 60.0 / tempo

    if level == "simple":
        # Easy mode should still keep phrase-defining support notes.
        max_dur, max_vel, t_win, p_win = 0.08, 24, 0.15, 5
    else:
        max_dur, max_vel, t_win, p_win = 0.10, 32, 0.18, 6

    beat_tol = max(sec_per_beat * 0.11, 0.035)

    def on_strong_beat(t: float) -> bool:
        pos = (t / sec_per_beat) % 4.0
        if pos <= beat_tol or pos >= 4.0 - beat_tol:
            return True
        return abs(pos - 2.0) <= beat_tol

    sorted_n = sorted(notes, key=lambda n: (n.start, n.pitch))
    # Do not over-thin sparse regions; these anchors keep phrases from dropping out.
    sparse_anchor_gap = sec_per_beat * (1.2 if level == "simple" else 0.85)
    out = []
    for idx, n in enumerate(sorted_n):
        if id(n) in protected:
            out.append(n)
            continue
        dur = n.end - n.start
        if dur >= max_dur or n.velocity >= max_vel:
            out.append(n)
            continue
        if on_strong_beat(n.start):
            out.append(n)
            continue
        prev_dt = (
            (n.start - sorted_n[idx - 1].start) if idx > 0 else float("inf")
        )
        next_dt = (
            (sorted_n[idx + 1].start - n.start)
            if idx < len(sorted_n) - 1
            else float("inf")
        )
        if min(prev_dt, next_dt) >= sparse_anchor_gap:
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


def _bridge_phrase_gaps(notes: list, level: str, bpm: float, split_pitch: int = 60) -> list:
    """
    Extend nearby note tails across short idle gaps so phrases sound connected.
    Keeps articulation by only bridging small inter-onset spaces.
    """
    if not notes:
        return notes

    tempo = max(40.0, min(240.0, bpm))
    sec_per_beat = 60.0 / tempo
    max_bridge_gap = sec_per_beat * (1.2 if level == "simple" else 0.55)
    release_pad = 0.004 if level == "simple" else 0.012

    sorted_notes = sorted(notes, key=lambda n: (n.start, n.pitch, n.end))

    def process_hand(hand_notes: list) -> None:
        hand_notes.sort(key=lambda n: (n.start, n.pitch, n.end))
        for i in range(len(hand_notes) - 1):
            cur = hand_notes[i]
            nxt = hand_notes[i + 1]
            gap = nxt.start - cur.end
            if gap <= 0 or gap > max_bridge_gap:
                continue
            target_end = max(
                cur.end,
                min(nxt.start - release_pad, cur.end + (gap * 0.9)),
            )
            cur.end = max(cur.start + 0.02, target_end)

    left = [n for n in sorted_notes if n.pitch < split_pitch]
    right = [n for n in sorted_notes if n.pitch >= split_pitch]
    process_hand(left)
    process_hand(right)

    return sorted(sorted_notes, key=lambda n: (n.start, n.pitch, n.end))


def _limit_local_onset_bursts(
    notes: list,
    bpm: float,
    level: str,
    split_pitch: int = 60,
) -> list:
    """
    Smooth short-note "flurries" by capping onset density inside short rolling
    windows. Keeps melodic contour anchors and stronger attacks so identity stays
    recognizable while improving playability.
    """
    if not notes:
        return notes

    tempo = max(40.0, min(240.0, bpm))
    sec_per_beat = 60.0 / tempo
    if level == "simple":
        # Keep anti-flurry behavior, but preserve enough contour to stay recognizable.
        window = sec_per_beat * 0.42
        max_right, max_left = 3, 2
    else:
        window = sec_per_beat * 0.3
        max_right, max_left = 3, 3

    notes_sorted = sorted(notes, key=lambda n: (n.start, n.pitch, n.end))

    def on_strong_beat(t: float) -> bool:
        pos = (t / sec_per_beat) % 4.0
        return abs(pos - 0.0) <= 0.14 or abs(pos - 2.0) <= 0.14

    def score_note(n: pretty_midi.Note) -> float:
        dur = max(0.0, n.end - n.start)
        strong = 6.0 if on_strong_beat(n.start) else 0.0
        return (n.velocity * 1.8) + (dur * 40.0) + strong

    def thin_hand(hand_notes: list, keep_high_anchor: bool) -> list:
        if not hand_notes:
            return []
        hand_notes = sorted(hand_notes, key=lambda n: (n.start, n.pitch, n.end))
        out = []
        i = 0
        while i < len(hand_notes):
            t0 = hand_notes[i].start
            j = i + 1
            while j < len(hand_notes) and hand_notes[j].start <= t0 + window:
                j += 1
            bucket = hand_notes[i:j]
            max_bucket = max_right if keep_high_anchor else max_left
            if len(bucket) <= max_bucket:
                out.extend(bucket)
                i = j
                continue

            anchors = []
            if keep_high_anchor:
                anchors.append(max(bucket, key=lambda n: (n.pitch, n.velocity)))
            else:
                anchors.append(min(bucket, key=lambda n: (n.pitch, -n.velocity)))

            selected = []
            seen = set()
            for n in anchors:
                k = (n.pitch, round(n.start, 4), round(n.end, 4))
                if k not in seen:
                    selected.append(n)
                    seen.add(k)

            remaining = [
                n
                for n in sorted(bucket, key=score_note, reverse=True)
                if (n.pitch, round(n.start, 4), round(n.end, 4)) not in seen
            ]
            slots = max(0, max_bucket - len(selected))
            selected.extend(remaining[:slots])
            if level == "simple" and selected:
                # In easy mode, favor legato continuity over dense re-attacks:
                # when we drop local flurry notes, let kept notes hold longer.
                bucket_max_end = max(n.end for n in bucket)
                hold_cap = window * 1.25
                for keep in selected:
                    keep.end = max(keep.end, min(bucket_max_end, keep.start + hold_cap))
            out.extend(selected)
            i = j

        # Final dedup by near-identical key in case adjacent windows overlap by identity.
        uniq = {}
        for n in out:
            k = (n.pitch, round(n.start, 4), round(n.end, 4))
            if k not in uniq or n.velocity > uniq[k].velocity:
                uniq[k] = n
        return sorted(uniq.values(), key=lambda n: (n.start, n.pitch, n.end))

    left = [n for n in notes_sorted if n.pitch < split_pitch]
    right = [n for n in notes_sorted if n.pitch >= split_pitch]
    thinned = thin_hand(left, keep_high_anchor=False) + thin_hand(right, keep_high_anchor=True)
    return sorted(thinned, key=lambda n: (n.start, n.pitch, n.end))


def _shape_simple_legato_from_reference(
    arranged_notes: list,
    reference_notes: list,
    bpm: float,
    split_pitch: int = 60,
) -> list:
    """
    In simple mode, lengthen kept notes using nearby reference-note sustains so
    we reduce re-attacks while staying closer to the source phrasing.
    """
    if not arranged_notes or not reference_notes:
        return arranged_notes

    tempo = max(40.0, min(240.0, bpm))
    sec_per_beat = 60.0 / tempo
    start_tol = sec_per_beat * 0.35
    pitch_tol = 2
    release_pad = 0.007
    max_extra_hold = sec_per_beat * 1.35

    arranged = sorted(arranged_notes, key=lambda n: (n.start, n.pitch, n.end))
    ref = sorted(reference_notes, key=lambda n: (n.start, n.pitch, n.end))

    def process_hand(hand_notes: list, hand_ref: list) -> None:
        if not hand_notes:
            return

        for i, n in enumerate(hand_notes):
            next_start = hand_notes[i + 1].start if i < len(hand_notes) - 1 else None
            hold_cap = n.start + max_extra_hold
            if next_start is not None:
                hold_cap = min(hold_cap, max(n.start + 0.02, next_start - release_pad))

            best_same = None
            best_near = None
            for r in hand_ref:
                if r.end <= n.end:
                    continue
                dt = abs(r.start - n.start)
                if dt > start_tol:
                    continue

                if r.pitch == n.pitch:
                    if best_same is None or r.end > best_same.end:
                        best_same = r
                elif abs(r.pitch - n.pitch) <= pitch_tol:
                    if best_near is None or r.end > best_near.end:
                        best_near = r

            guide = best_same or best_near
            if guide is None:
                continue
            n.end = max(n.end, min(hold_cap, guide.end))
            n.end = max(n.end, n.start + 0.02)

    left = [n for n in arranged if n.pitch < split_pitch]
    right = [n for n in arranged if n.pitch >= split_pitch]
    ref_left = [n for n in ref if n.pitch < split_pitch]
    ref_right = [n for n in ref if n.pitch >= split_pitch]
    process_hand(left, ref_left)
    process_hand(right, ref_right)

    return sorted(arranged, key=lambda n: (n.start, n.pitch, n.end))


def _restore_gap_anchors(
    arranged_notes: list,
    reference_notes: list,
    bpm: float,
    level: str,
    split_pitch: int = 60,
) -> list:
    """
    Anti-silence safety net: if arranged output is locally silent while reference
    material has activity, inject lightweight anchor notes to preserve continuity.
    """
    if not reference_notes:
        return arranged_notes

    tempo = max(40.0, min(240.0, bpm))
    sec_per_beat = 60.0 / tempo
    if level == "simple":
        # Keep phrase continuity, but avoid rebuilding dense texture.
        window = sec_per_beat * 0.75
        min_ref_presence = sec_per_beat * 0.18
        min_added_dur = max(0.14, sec_per_beat * 0.28)
        max_added_dur = max(0.34, sec_per_beat * 0.7)
        step = window
    else:
        window = sec_per_beat * 0.7
        min_ref_presence = sec_per_beat * 0.14
        min_added_dur = max(0.10, sec_per_beat * 0.2)
        max_added_dur = max(0.3, sec_per_beat * 0.75)
        step = window * 0.6

    arranged = sorted(arranged_notes or [], key=lambda n: (n.start, n.pitch, n.end))
    ref = sorted(reference_notes, key=lambda n: (n.start, n.pitch, n.end))
    if not ref:
        return arranged

    def has_activity(notes: list, t0: float, t1: float) -> bool:
        for n in notes:
            if n.end <= t0:
                continue
            if n.start >= t1:
                break
            overlap = min(n.end, t1) - max(n.start, t0)
            if overlap >= min_ref_presence or (n.start >= t0 and n.start < t1):
                return True
        return False

    injected = []
    first_t = ref[0].start
    last_t = max((n.end for n in ref), default=first_t)
    t = first_t
    while t <= last_t:
        t1 = t + window
        if has_activity(ref, t, t1) and not has_activity(arranged, t, t1):
            local_ref = [
                n
                for n in ref
                if n.start < t1
                and n.end > t
                and (n.end - n.start) >= max(0.045, sec_per_beat * 0.08)
                and n.velocity >= (18 if level == "simple" else 14)
            ]
            if local_ref:
                chosen = []
                if level == "simple":
                    rh = [n for n in local_ref if n.pitch >= split_pitch]
                    lh = [n for n in local_ref if n.pitch < split_pitch]
                    if rh:
                        chosen.append(max(rh, key=lambda n: (n.pitch, n.velocity, n.end - n.start)))
                    # Only add LH anchor when there is no RH candidate, to avoid
                    # rebuilding dense two-hand textures in easy mode.
                    if lh and not chosen:
                        chosen.append(min(lh, key=lambda n: (n.pitch, -n.velocity)))
                else:
                    chosen.append(
                        max(
                            local_ref,
                            key=lambda n: (
                                (n.velocity * 1.8) + ((n.end - n.start) * 60.0) + (n.pitch * 0.06)
                            ),
                        )
                    )
                for base in chosen:
                    st = max(t, base.start)
                    raw_dur = max(min_added_dur, min(base.end - st, max_added_dur))
                    en = st + raw_dur
                    injected.append(
                        pretty_midi.Note(
                            velocity=int(
                                max(34 if level == "simple" else 32, min(98, base.velocity))
                            ),
                            pitch=int(base.pitch),
                            start=float(st),
                            end=float(max(st + min_added_dur, en)),
                        )
                    )
        t += step

    if not injected:
        return arranged

    all_notes = arranged + injected
    all_notes.sort(key=lambda n: (n.start, n.pitch, n.end))

    # Dedup near-identical inserts against existing notes.
    deduped = []
    for n in all_notes:
        if (
            deduped
            and deduped[-1].pitch == n.pitch
            and abs(deduped[-1].start - n.start) <= 0.018
            and abs(deduped[-1].end - n.end) <= 0.08
        ):
            if n.velocity > deduped[-1].velocity:
                deduped[-1] = n
            continue
        deduped.append(n)
    return deduped


def _enforce_max_onset_gap(
    arranged_notes: list,
    reference_notes: list,
    bpm: float,
    level: str,
) -> list:
    """
    Hard continuity guard: if arranged output has large onset-to-onset holes but
    reference has attacks in-between, inject lightweight anchors.
    """
    if not arranged_notes or not reference_notes:
        return arranged_notes

    tempo = max(40.0, min(240.0, bpm))
    sec_per_beat = 60.0 / tempo
    max_onset_gap = sec_per_beat * (1.8 if level == "simple" else 1.35)
    min_anchor_dur = max(0.07, sec_per_beat * 0.11)
    max_anchor_dur = max(0.26, sec_per_beat * 0.62)

    arranged = sorted(arranged_notes, key=lambda n: (n.start, n.pitch, n.end))
    ref = sorted(reference_notes, key=lambda n: (n.start, n.pitch, n.end))
    ref = [
        n
        for n in ref
        if (n.end - n.start) >= min_anchor_dur * 0.7 and n.velocity >= 12
    ]
    if not ref:
        return arranged

    injected = []
    for i in range(len(arranged) - 1):
        left = arranged[i].start
        right = arranged[i + 1].start
        gap = right - left
        if gap <= max_onset_gap:
            continue

        candidates = [
            n for n in ref
            if (left + 0.02) < n.start < (right - 0.02)
        ]
        if not candidates:
            continue

        # Add at most one anchor in simple mode (keep texture sparse).
        if level == "simple":
            count = 1
        else:
            count = min(2, max(1, int(gap / max_onset_gap)))
        for k in range(1, count + 1):
            target = left + (gap * (k / (count + 1)))
            chosen = min(
                candidates,
                key=lambda n: (
                    abs(n.start - target),
                    -n.velocity,
                    -(n.end - n.start),
                ),
            )
            st = float(chosen.start)
            en = float(min(chosen.end, st + max_anchor_dur))
            injected.append(
                pretty_midi.Note(
                    velocity=int(max(30, min(100, chosen.velocity))),
                    pitch=int(chosen.pitch),
                    start=st,
                    end=max(st + min_anchor_dur, en),
                )
            )

    if not injected:
        return arranged

    all_notes = sorted(arranged + injected, key=lambda n: (n.start, n.pitch, n.end))
    deduped = []
    for n in all_notes:
        if (
            deduped
            and deduped[-1].pitch == n.pitch
            and abs(deduped[-1].start - n.start) <= 0.016
            and abs(deduped[-1].end - n.end) <= 0.08
        ):
            if n.velocity > deduped[-1].velocity:
                deduped[-1] = n
            continue
        deduped.append(n)
    return deduped


def _enforce_playability(
    notes: list,
    chord_snap_sec: float,
    max_notes_per_chord: int,
    min_rearticulation: float,
    max_chord_span: int,
    preserve_note_ids: set | None = None,
) -> list:
    """
    Constrain transcription to human-playable density.
    """
    if not notes:
        return notes

    protected = preserve_note_ids or set()
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
        locked = [n for n in bucket if id(n) in protected]
        for n in sorted(locked, key=lambda x: (x.pitch, x.start, x.end)):
            key = (n.pitch, round(n.start, 4), round(n.end, 4))
            if key not in seen_ids:
                kept.append(n)
                seen_ids.add(key)
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
            left_locked = id(left) in protected
            right_locked = id(right) in protected
            if left_locked and right_locked:
                break
            if left_locked:
                kept = kept[:-1]
                continue
            if right_locked:
                kept = kept[1:]
                continue
            if left.velocity <= right.velocity:
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
            prev_locked = id(prev) in protected
            n_locked = id(n) in protected
            if prev_locked and not n_locked:
                continue
            if n_locked and not prev_locked:
                try:
                    thinned.remove(prev)
                except ValueError:
                    pass
                thinned.append(n)
                last_by_pitch[n.pitch] = n
                continue
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


def _collect_non_drum_notes(pm: pretty_midi.PrettyMIDI) -> list:
    out = []
    for instr in pm.instruments:
        if getattr(instr, "is_drum", False):
            continue
        out.extend(instr.notes)
    out.sort(key=lambda n: (n.start, n.pitch, n.end))
    return out


def _activity_gap_stats(pm: pretty_midi.PrettyMIDI) -> dict:
    """
    Summarize how continuous musical activity is in a MIDI candidate.
    Used to decide whether we should run a higher-recall rescue pass.
    """
    notes = _collect_non_drum_notes(pm)
    if len(notes) < 8:
        return {
            "note_count": len(notes),
            "activity_span": 0.0,
            "coverage_ratio": 1.0,
            "max_gap": 0.0,
            "gaps_over_300ms": 0,
        }

    first_start = float(notes[0].start)
    last_end = max(float(n.end) for n in notes)
    span = max(0.001, last_end - first_start)

    covered = 0.0
    gaps = []
    active_start = float(notes[0].start)
    active_end = max(float(notes[0].end), active_start + 1e-6)
    for n in notes[1:]:
        st = float(n.start)
        en = max(float(n.end), st + 1e-6)
        if st > active_end:
            covered += max(0.0, active_end - active_start)
            gaps.append(st - active_end)
            active_start, active_end = st, en
        else:
            active_end = max(active_end, en)
    covered += max(0.0, active_end - active_start)

    max_gap = max(gaps) if gaps else 0.0
    gaps_over_300ms = sum(1 for g in gaps if g >= 0.3)
    coverage_ratio = max(0.0, min(1.0, covered / span))
    return {
        "note_count": len(notes),
        "activity_span": span,
        "coverage_ratio": coverage_ratio,
        "max_gap": max_gap,
        "gaps_over_300ms": gaps_over_300ms,
    }


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
        if level != "simple":
            return primary
        # Easy mode still needs phrase-defining anchors; keep one conservative
        # recall pass, but avoid extra passes that hurt latency.
        simple_recall = _run_basic_pitch_pass(
            model,
            audio_path,
            onset_threshold=clamp01(0.40 + onset_bias),
            frame_threshold=clamp01(0.245 + frame_bias),
            minimum_note_length=clamp_len(70.0 * length_scale),
        )
        return _merge_midis(primary, simple_recall, start_tol=0.024, end_tol=0.045)

    sensitive = _run_basic_pitch_pass(
        model,
        audio_path,
        onset_threshold=clamp01(
            (0.385 if level == "simple" else 0.36) + onset_bias
        ),
        frame_threshold=clamp01(
            (0.225 if level == "simple" else 0.205) + frame_bias
        ),
        minimum_note_length=clamp_len(
            (60.0 if level == "simple" else 55.0) * length_scale
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
        minimum_note_length=clamp_len(48.0 * length_scale),
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


def _scale_velocities(pm: pretty_midi.PrettyMIDI, level: str) -> pretty_midi.PrettyMIDI:
    """
    Rescale velocities with a gentle curve so the middle range is slightly
    expanded (cleaner, more expressive playback).
    """
    if level == "simple":
        # Keep simple mode punchy and avoid near-silent tails.
        out_min, out_span, curve = 46, 62, 0.9
        quiet_floor = 52
        short_note_floor = 58
    else:
        # Balanced keeps wider dynamics, but still lifts very quiet notes.
        out_min, out_span, curve = 40, 74, 0.8
        quiet_floor = 46
        short_note_floor = 52

    for instrument in pm.instruments:
        if not instrument.notes:
            continue
        velocities = [n.velocity for n in instrument.notes]
        lo, hi = min(velocities), max(velocities)
        span = hi - lo if hi > lo else 1
        for note in instrument.notes:
            dur = max(0.0, note.end - note.start)
            n = (note.velocity - lo) / span
            n = n ** curve
            v = int(out_min + n * out_span)
            # Hard floor for audibility in DAWs/samplers.
            if v < quiet_floor:
                v = quiet_floor
            # Short notes can disappear perceptually; keep them a little louder.
            if dur <= 0.11 and v < short_note_floor:
                v = short_note_floor
            note.velocity = max(1, min(127, v))
    return pm


@app.post("/transcribe", response_model=TranscriptionResponse)
def transcribe(req: TranscriptionRequest) -> TranscriptionResponse:
    if not req.audio_url:
        raise HTTPException(status_code=400, detail="audio_url is required.")

    clean_level = _validated_clean_level(req.clean_level)
    max_audio_seconds = 300.0
    try:
        max_audio_seconds = float(
            os.environ.get("TRANSCRIBER_MAX_AUDIO_SECONDS", "300")
        )
    except Exception:
        max_audio_seconds = 300.0
    max_audio_seconds = max(0.0, max_audio_seconds)

    input_path = _download_audio_to_temp(
        req.audio_url,
        max_audio_seconds=max_audio_seconds,
    )

    try:
        # Post-download fallback guard (direct URLs / metadata-miss cases).
        source_duration = _estimate_audio_duration_seconds(input_path)
        if (
            max_audio_seconds > 0.0
            and source_duration is not None
            and source_duration > max_audio_seconds
        ):
            raise HTTPException(
                status_code=400,
                detail=_duration_limit_error_detail(source_duration, max_audio_seconds),
            )

        model = _get_basic_pitch_model()

        # Fast pipeline (no Demucs, one waveform): default = ultra.
        # TRANSCRIBER_MAX_QUALITY=1 → fast
        # TRANSCRIBER_DEEP_BP=1 → quality
        forced_mode = None
        if _env_truthy("TRANSCRIBER_DEEP_BP"):
            inference_mode = "quality"
            forced_mode = "quality"
        elif _env_truthy("TRANSCRIBER_MAX_QUALITY"):
            inference_mode = "fast"
            forced_mode = "fast"
        else:
            inference_mode = "ultra"

        print("[transcribe] full-mix Basic Pitch, inference_mode=", inference_mode)

        inferred_midi = _run_basic_pitch(
            model, input_path, level=clean_level, inference_mode=inference_mode
        )
        merged_roles = _collapse_to_single_piano(inferred_midi)
        print("[transcribe] raw notes (single piano):", _count_notes(merged_roles))

        # Recall-first rescue:
        # If default ultra mode produces suspiciously sparse continuity, do one
        # higher-recall pass and merge BEFORE cleanup/simplification.
        if forced_mode is None and inference_mode == "ultra":
            stats = _activity_gap_stats(merged_roles)
            should_rescue = (
                stats["activity_span"] >= 20.0
                and stats["note_count"] >= 40
                and (
                    (stats["coverage_ratio"] < 0.55 and stats["gaps_over_300ms"] >= 6)
                    or (stats["max_gap"] >= 1.2 and stats["gaps_over_300ms"] >= 3)
                )
            )
            if should_rescue:
                print("[transcribe] continuity rescue triggered", stats)
                rescue_raw = _run_basic_pitch(
                    model, input_path, level=clean_level, inference_mode="fast"
                )
                rescue_roles = _collapse_to_single_piano(rescue_raw)
                merged_roles = _merge_midis(
                    merged_roles,
                    rescue_roles,
                    start_tol=0.05,
                    end_tol=0.08,
                )
                print(
                    "[transcribe] rescue merged note count:",
                    _count_notes(merged_roles),
                )

        # Build raw export with maximal note recall and no cleanup/arrangement.
        # We always keep a clone of the pre-clean note stream as a baseline.
        raw_export_roles = _clone_pretty_midi(merged_roles)
        if inference_mode != "quality":
            try:
                print("[transcribe] raw export recall pass: quality")
                raw_quality = _run_basic_pitch(
                    model,
                    input_path,
                    level="balanced",
                    inference_mode="quality",
                )
                raw_quality_roles = _collapse_to_single_piano(raw_quality)
                raw_export_roles = _merge_midis(
                    raw_export_roles,
                    raw_quality_roles,
                    start_tol=0.045,
                    end_tol=0.07,
                )
                print(
                    "[transcribe] raw export note count (max recall):",
                    _count_notes(raw_export_roles),
                )
            except Exception as e:
                # If the extra quality pass fails, still return the baseline raw.
                print("[transcribe] raw quality pass failed; using baseline raw:", e)

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

        raw_midi = _clone_pretty_midi(raw_export_roles)
        cleaned_midi = _clean_midi(merged_roles, clean_level, bpm=bpm)
        # Use a less-thinned reference for continuity recovery. If we use already
        # cleaned notes here, some real connector activity is gone before we can
        # detect/fill arranged silent windows.
        reference_for_gaps_pm = _clone_pretty_midi(merged_roles)
        cleaned_midi = _arrange_playable_piano(cleaned_midi, clean_level)
        # Second sustain pass after arrangement (merges duplicated slices into longer tones).
        gap2 = 0.16 if clean_level == "simple" else 0.11
        for idx, inst in enumerate(cleaned_midi.instruments):
            if getattr(inst, "is_drum", False):
                continue
            ref_notes = (
                reference_for_gaps_pm.instruments[idx].notes
                if idx < len(reference_for_gaps_pm.instruments)
                else []
            )
            inst.notes = _restore_gap_anchors(
                inst.notes,
                ref_notes,
                bpm=bpm,
                level=clean_level,
            )
            inst.notes = _enforce_max_onset_gap(
                inst.notes,
                ref_notes,
                bpm=bpm,
                level=clean_level,
            )
            if inst.notes:
                inst.notes = _consolidate_sustains(inst.notes, merge_gap=gap2, min_overlap=0.0)
                inst.notes = _bridge_phrase_gaps(inst.notes, level=clean_level, bpm=bpm)
                inst.notes = _limit_local_onset_bursts(
                    inst.notes,
                    bpm=bpm,
                    level=clean_level,
                    split_pitch=60,
                )
                if clean_level == "simple":
                    inst.notes = _shape_simple_legato_from_reference(
                        inst.notes,
                        ref_notes,
                        bpm=bpm,
                        split_pitch=60,
                    )
                    # Re-merge and re-bridge after burst-thinning so easy mode
                    # feels connected (fewer choppy re-attacks).
                    inst.notes = _consolidate_sustains(
                        inst.notes,
                        merge_gap=max(gap2, 0.2),
                        min_overlap=0.0,
                    )
                    inst.notes = _bridge_phrase_gaps(
                        inst.notes,
                        level=clean_level,
                        bpm=bpm,
                    )
                    # Final continuity guard after aggressive easy-mode thinning:
                    # recover only key anchors when long onset holes appear.
                    inst.notes = _enforce_max_onset_gap(
                        inst.notes,
                        ref_notes,
                        bpm=bpm,
                        level=clean_level,
                    )
        cleaned_midi = _scale_velocities(cleaned_midi, clean_level)
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
        raw_midi_path = MEDIA_ROOT / f"{midi_id}-raw.mid"
        raw_midi.write(str(raw_midi_path))

        # Production path: upload generated files to Supabase Storage.
        # Dev fallback: keep serving from local `/media`.
        storage_cfg = _supabase_storage_env()
        if storage_cfg is not None:
            midi_url = _upload_to_supabase_storage(midi_path)
            raw_midi_url = _upload_to_supabase_storage(raw_midi_path)
        else:
            base_url = os.environ.get("TRANSCRIBER_PUBLIC_BASE_URL")
            if not base_url:
                base_url = "http://localhost:8000"
            midi_url = f"{base_url.rstrip('/')}/media/{midi_path.name}"
            raw_midi_url = f"{base_url.rstrip('/')}/media/{raw_midi_path.name}"

        return TranscriptionResponse(
            midi_url=midi_url,
            raw_midi_url=raw_midi_url,
            pdf_url=None,
            time_signature=time_signature_str,
        )
    finally:
        try:
            if input_path.exists():
                input_path.unlink()
        except Exception:
            pass