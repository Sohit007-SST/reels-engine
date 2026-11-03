"""Word timestamps with local faster-whisper (MIT), CPU int8. Timestamps ONLY.

Caption text always comes from the script; the TypeScript aligner (src/media/timings.ts)
maps these recognized words onto the canonical script words.

Usage:
  timings_whisper.py --audio voice.wav [--model small|base] [--lang en] [--prompt "script text"]
  timings_whisper.py --download-only [--model small]

Prints ONE JSON object on stdout:
  {"ok": true, "model": "small", "language": "en", "durationMs": 31234.0,
   "words": [{"word": "What", "startMs": 120.0, "endMs": 340.0, "probability": 0.98}, ...]}
The model is downloaded once (Hugging Face hub, read-only, no token) into models/whisper/.
"""

from __future__ import annotations

import argparse
import os
import time

from media_common import MODELS_DIR, emit, fail, file_lock, log

ALLOWED_MODELS = ("tiny", "base", "small", "tiny.en", "base.en", "small.en")
WHISPER_DIR = MODELS_DIR / "whisper"


def load_model(name: str):
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "30")
    os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "60")
    from faster_whisper import WhisperModel

    WHISPER_DIR.mkdir(parents=True, exist_ok=True)
    last: Exception | None = None
    with file_lock(WHISPER_DIR / f".{name}.lock"):
        for attempt in range(1, 4):  # bounded retries for the one-time download
            try:
                return WhisperModel(name, device="cpu", compute_type="int8", download_root=str(WHISPER_DIR))
            except Exception as err:  # noqa: BLE001
                last = err
                log("warn", "whisper load failed", attempt=attempt, error=str(err)[:200])
                if attempt < 3:
                    time.sleep(2 * attempt)
    raise RuntimeError(f"could not load whisper model {name}: {last}")


def load_audio_16k(path: str):
    """Decode with soundfile and resample to 16 kHz mono float32.

    faster-whisper's own decoder uses PyAV, whose pinned version (av 19) rejects an
    argument faster-whisper 1.2.1 passes; feeding a numpy array avoids PyAV entirely.
    """
    from math import gcd

    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly

    data, sr = sf.read(path, dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    if sr != 16_000:
        g = gcd(int(sr), 16_000)
        mono = resample_poly(mono, 16_000 // g, int(sr) // g).astype(np.float32)
    return mono


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--audio")
    ap.add_argument("--model", default=os.environ.get("WHISPER_MODEL", "small"))
    ap.add_argument("--lang", default="en")
    ap.add_argument("--prompt", default=None, help="optional script text to bias recognition")
    ap.add_argument("--download-only", action="store_true")
    args = ap.parse_args()

    if args.model not in ALLOWED_MODELS:
        fail(f"model must be one of {ALLOWED_MODELS}", code=2)

    t0 = time.monotonic()
    model = load_model(args.model)
    log("info", "whisper loaded", model=args.model, loadMs=round((time.monotonic() - t0) * 1000))
    if args.download_only:
        emit({"ok": True, "model": args.model, "dir": str(WHISPER_DIR)})
        return
    if not args.audio or not os.path.exists(args.audio):
        fail("--audio must point to an existing file", code=2)

    t1 = time.monotonic()
    segments, info = model.transcribe(
        load_audio_16k(args.audio),
        language=args.lang,
        word_timestamps=True,
        beam_size=5,
        vad_filter=False,
        condition_on_previous_text=False,
        initial_prompt=args.prompt,
    )
    words = []
    for seg in segments:
        for w in seg.words or []:
            text = w.word.strip()
            if not text:
                continue
            words.append(
                {
                    "word": text,
                    "startMs": round(float(w.start) * 1000, 1),
                    "endMs": round(float(w.end) * 1000, 1),
                    "probability": round(float(w.probability), 4),
                }
            )
    log("info", "transcribed", words=len(words), ms=round((time.monotonic() - t1) * 1000))
    emit(
        {
            "ok": True,
            "model": args.model,
            "language": info.language,
            "durationMs": round(float(info.duration) * 1000, 1),
            "words": words,
        }
    )


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as err:  # noqa: BLE001
        fail(f"timings failed: {type(err).__name__}: {err}")
