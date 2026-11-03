"""Kokoro-82M (Apache-2.0) text-to-speech via kokoro-onnx, one WAV per beat.

Usage:
  tts_kokoro.py --job job.json
      job = {"voice": "af_heart", "speed": 1.08, "lang": "en-us",
             "beats": [{"index": 0, "text": "...", "outPath": "/abs/beat-00.wav"}, ...]}
  tts_kokoro.py --text "Hello" --out /abs/hello.wav [--voice af_heart --speed 1.08 --lang en-us]
  tts_kokoro.py --download-only

Prints ONE JSON object on stdout:
  {"ok": true, "sampleRate": 24000, "model": "...", "voice": "...", "beats":
     [{"index": 0, "path": "...", "samples": N, "durationMs": 1234.5}]}
Durations are MEASURED from the written audio (sample count / rate), never estimated.
Hindi: pass Devanagari text with --lang hi (espeak-ng phonemizer).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from media_common import MODELS_DIR, emit, ensure_file, fail, log

RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
VARIANTS = {
    # name: (file, sha256 pin or None)
    "fp32": ("kokoro-v1.0.onnx", "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5"),
    "fp16": ("kokoro-v1.0.fp16.onnx", None),
    "int8": ("kokoro-v1.0.int8.onnx", None),
}
VOICES = ("voices-v1.0.bin", "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d")
KOKORO_DIR = MODELS_DIR / "kokoro"


def model_paths(variant: str) -> tuple[Path, Path]:
    if variant not in VARIANTS:
        fail(f"unknown KOKORO_VARIANT {variant!r}; expected one of {sorted(VARIANTS)}", code=2)
    fname, pin = VARIANTS[variant]
    model = ensure_file(f"{RELEASE}/{fname}", KOKORO_DIR / fname, pin)
    voices = ensure_file(f"{RELEASE}/{VOICES[0]}", KOKORO_DIR / VOICES[0], VOICES[1])
    return model, voices


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--job")
    ap.add_argument("--text")
    ap.add_argument("--out")
    ap.add_argument("--voice", default="af_heart")
    ap.add_argument("--speed", type=float, default=1.08)
    ap.add_argument("--lang", default="en-us")
    ap.add_argument("--variant", default=os.environ.get("KOKORO_VARIANT", "fp32"))
    ap.add_argument("--download-only", action="store_true")
    args = ap.parse_args()

    try:
        model_path, voices_path = model_paths(args.variant)
    except Exception as err:  # noqa: BLE001
        fail(f"model download failed: {err}", code=3)
        return

    if args.download_only:
        emit({"ok": True, "model": model_path.name, "voices": voices_path.name, "dir": str(KOKORO_DIR)})
        return

    if args.job:
        job = json.loads(Path(args.job).read_text(encoding="utf-8"))
    elif args.text is not None and args.out:
        job = {
            "voice": args.voice,
            "speed": args.speed,
            "lang": args.lang,
            "beats": [{"index": 0, "text": args.text, "outPath": args.out}],
        }
    else:
        fail("need --job, or --text with --out, or --download-only", code=2)
        return

    voice = str(job.get("voice") or args.voice)
    speed = float(job.get("speed") or args.speed)
    lang = str(job.get("lang") or args.lang)
    beats = job.get("beats") or []
    if not beats:
        fail("job has no beats", code=2)
    if not 0.5 <= speed <= 2.0:
        fail(f"speed {speed} out of range 0.5-2.0", code=2)

    import numpy as np
    import soundfile as sf
    from kokoro_onnx import Kokoro

    t0 = time.monotonic()
    kokoro = Kokoro(str(model_path), str(voices_path))
    if voice not in kokoro.get_voices():
        fail(f"unknown voice {voice!r}", code=2)
    log("info", "kokoro loaded", model=model_path.name, loadMs=round((time.monotonic() - t0) * 1000))

    results = []
    for beat in beats:
        text = str(beat["text"]).strip()
        out = Path(beat["outPath"])
        if not text:
            fail(f"beat {beat.get('index')} has empty text", code=2)
        t1 = time.monotonic()
        samples, sr = kokoro.create(text, voice=voice, speed=speed, lang=lang)
        samples = np.asarray(samples, dtype=np.float32).reshape(-1)
        if samples.size == 0:
            fail(f"beat {beat.get('index')} produced no audio", code=4)
        peak = float(np.max(np.abs(samples)))
        if peak > 0.99:  # keep headroom; never clip the int16 conversion
            samples = samples * (0.99 / peak)
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_name(out.name + ".tmp.wav")
        sf.write(str(tmp), samples, sr, subtype="PCM_16")
        os.replace(tmp, out)
        info = sf.info(str(out))
        duration_ms = info.frames * 1000.0 / info.samplerate
        results.append(
            {
                "index": int(beat["index"]),
                "path": str(out),
                "samples": int(info.frames),
                "sampleRate": int(info.samplerate),
                "durationMs": round(duration_ms, 3),
                "synthMs": round((time.monotonic() - t1) * 1000),
            }
        )
        log("info", "beat synthesized", index=beat["index"], durationMs=round(duration_ms))

    emit(
        {
            "ok": True,
            "sampleRate": results[0]["sampleRate"],
            "model": model_path.name,
            "variant": args.variant,
            "voice": voice,
            "speed": speed,
            "lang": lang,
            "beats": results,
        }
    )


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as err:  # noqa: BLE001
        fail(f"tts failed: {type(err).__name__}: {err}")
