"""Procedural music beds (numpy only; no samples, no licensing risk).

Moods:
  wonder  - slow lydian pads, soft bell arpeggio, sub bass (60 BPM)
  tension - minor drone, pulsing eighth-note bass, ticking hats, low booms (90 BPM)
  upbeat  - light beat (kick/clap/hats), plucky chord stabs, bass (112 BPM)

Usage:
  music_gen.py --mood wonder --duration-ms 32000 --out bed.wav [--seed 7]
  music_gen.py --all-moods --out-dir assets/music --duration-ms 64000

Output: 48 kHz stereo PCM16 WAV, faded in/out, normalized to -20 LUFS integrated
(peak <= -3 dBFS) so the mixer can apply predictable gain. Same seed => same file.
Prints ONE JSON object on stdout.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import numpy as np
from scipy.signal import butter, sosfilt

from media_common import emit, fail, log

SR = 48_000
TARGET_LUFS = -20.0
PEAK_LIMIT = 10 ** (-3 / 20)
MOODS = ("wonder", "tension", "upbeat")


def midi_hz(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


def envelope(n: int, a: float, r: float, sr: int = SR) -> np.ndarray:
    env = np.ones(n, dtype=np.float64)
    na, nr = min(n, int(a * sr)), min(n, int(r * sr))
    if na > 0:
        env[:na] = np.linspace(0, 1, na) ** 2
    if nr > 0:
        env[n - nr :] *= np.linspace(1, 0, nr) ** 2
    return env


def tone(freq: float, dur: float, harmonics=((1, 1.0), (2, 0.35), (3, 0.15)), detune_cents=0.0, phase=0.0):
    n = max(1, int(dur * SR))
    t = np.arange(n) / SR
    f = freq * 2 ** (detune_cents / 1200)
    out = np.zeros(n)
    for mult, amp in harmonics:
        if f * mult < SR / 2 - 1000:
            out += amp * np.sin(2 * np.pi * f * mult * t + phase * mult)
    return out


def pluck(freq: float, dur: float, decay: float):
    n = max(1, int(dur * SR))
    t = np.arange(n) / SR
    sig = tone(freq, dur, ((1, 1.0), (2, 0.5), (3, 0.25), (4, 0.12)))
    return sig * np.exp(-t / decay) * envelope(n, 0.003, 0.02)


def add(buf: np.ndarray, start_s: float, sig: np.ndarray, gain=1.0, pan=0.0) -> None:
    i = int(start_s * SR)
    if i >= buf.shape[0] or i < 0:
        return
    j = min(buf.shape[0], i + sig.shape[0])
    seg = sig[: j - i] * gain
    left = np.cos((pan + 1) * np.pi / 4)
    right = np.sin((pan + 1) * np.pi / 4)
    buf[i:j, 0] += seg * left
    buf[i:j, 1] += seg * right


def filt(sig: np.ndarray, kind: str, cutoff, order=2) -> np.ndarray:
    sos = butter(order, cutoff, btype=kind, fs=SR, output="sos")
    return sosfilt(sos, sig)


def kick(rng):
    n = int(0.35 * SR)
    t = np.arange(n) / SR
    f = 50 + 90 * np.exp(-t / 0.04)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-t / 0.12)


def clap(rng):
    n = int(0.2 * SR)
    t = np.arange(n) / SR
    noise = filt(rng.standard_normal(n), "bandpass", (900, 4000))
    return noise * np.exp(-t / 0.05) * 0.6


def hat(rng, length=0.05):
    n = int(length * SR)
    t = np.arange(n) / SR
    return filt(rng.standard_normal(n), "highpass", 7000) * np.exp(-t / (length / 3)) * 0.35


def boom(rng):
    n = int(1.6 * SR)
    t = np.arange(n) / SR
    f = 38 + 40 * np.exp(-t / 0.15)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t / 0.6)
    noise = filt(rng.standard_normal(n), "lowpass", 300) * np.exp(-t / 0.2) * 0.3
    return np.tanh(1.5 * (body + noise))


def pad_chord(buf, start, dur, notes, gain, rng):
    for k, m in enumerate(notes):
        for det, pan in ((-7, -0.6), (7, 0.6)):
            sig = tone(midi_hz(m), dur + 1.0, ((1, 1.0), (2, 0.25), (3, 0.08)), det, rng.uniform(0, 6.28))
            sig *= envelope(sig.shape[0], min(1.5, dur / 2), 1.2)
            add(buf, start, sig, gain / len(notes), pan * (0.4 + 0.15 * k))


def gen_wonder(total: float, rng) -> tuple[np.ndarray, int]:
    bpm, bar = 60, 4.0
    buf = np.zeros((int(total * SR) + SR * 2, 2))
    prog = [(62, [62, 66, 69, 73]), (67, [67, 71, 73, 78]), (59, [59, 62, 66, 69, 73]), (57, [57, 64, 69, 71])]
    t, k = 0.0, 0
    while t < total:
        root, chord = prog[k % len(prog)]
        pad_chord(buf, t, bar, chord, 0.55, rng)
        add(buf, t, tone(midi_hz(root - 24), bar + 0.5, ((1, 1.0),)) * envelope(int((bar + 0.5) * SR), 0.8, 1.0), 0.25)
        for step in range(8):  # soft bell arpeggio, eighth notes at 60 BPM
            if rng.random() < 0.7:
                m = chord[(step * 2 + k) % len(chord)] + 12
                add(buf, t + step * 0.5, pluck(midi_hz(m), 1.2, 0.35), 0.10, rng.uniform(-0.7, 0.7))
        t += bar
        k += 1
    return buf, bpm


def gen_tension(total: float, rng) -> tuple[np.ndarray, int]:
    bpm = 90
    beat = 60 / bpm
    bar = beat * 4
    buf = np.zeros((int(total * SR) + SR * 2, 2))
    roots = [45, 45, 41, 44]
    t, k = 0.0, 0
    while t < total:
        root = roots[k % len(roots)]
        pad_chord(buf, t, bar, [root + 12, root + 15, root + 19, root + 13 if k % 4 == 3 else root + 22], 0.35, rng)
        for e in range(8):
            b = pluck(midi_hz(root - 12), beat / 2, 0.08)
            add(buf, t + e * beat / 2, filt(b, "lowpass", 600), 0.5 if e % 2 == 0 else 0.3)
        for s in range(16):
            add(buf, t + s * beat / 4, hat(rng, 0.03), 0.25 if s % 4 == 2 else 0.12, 0.3)
        if k % 2 == 0:
            add(buf, t, boom(rng), 0.45)
        t += bar
        k += 1
    return buf, bpm


def gen_upbeat(total: float, rng) -> tuple[np.ndarray, int]:
    bpm = 112
    beat = 60 / bpm
    bar = beat * 4
    buf = np.zeros((int(total * SR) + SR * 2, 2))
    prog = [[60, 64, 67], [55, 59, 62, 67], [57, 60, 64], [53, 57, 60, 65]]
    t, k = 0.0, 0
    while t < total:
        chord = prog[k % len(prog)]
        for b in range(4):
            add(buf, t + b * beat, kick(rng), 0.8)
            if b in (1, 3):
                add(buf, t + b * beat, clap(rng), 0.45, 0.1)
            for h in range(2):
                add(buf, t + b * beat + h * beat / 2, hat(rng), 0.25 if h else 0.15, -0.3)
        for s in (0, 1.5, 2, 3, 3.5):
            for m in chord:
                add(buf, t + s * beat, pluck(midi_hz(m + 12), beat * 0.9, 0.12), 0.09, rng.uniform(-0.4, 0.4))
        for s in (0, 1, 2, 2.5, 3):
            add(buf, t + s * beat, filt(pluck(midi_hz(chord[0] - 12), beat * 0.8, 0.15), "lowpass", 400), 0.55)
        pad_chord(buf, t, bar, [m + 12 for m in chord], 0.12, rng)
        t += bar
        k += 1
    return buf, bpm


GENERATORS = {"wonder": gen_wonder, "tension": gen_tension, "upbeat": gen_upbeat}


def normalize(buf: np.ndarray) -> tuple[np.ndarray, float]:
    import pyloudnorm as pyln

    meter = pyln.Meter(SR)
    lufs = float(meter.integrated_loudness(buf))
    if np.isfinite(lufs):
        buf = buf * 10 ** ((TARGET_LUFS - lufs) / 20)
    peak = float(np.max(np.abs(buf)))
    if peak > PEAK_LIMIT:
        buf = buf * (PEAK_LIMIT / peak)
    return buf, float(meter.integrated_loudness(buf))


def render(mood: str, duration_ms: int, out: Path, seed: int) -> dict:
    import soundfile as sf

    if mood not in GENERATORS:
        fail(f"unknown mood {mood!r}; expected one of {MOODS}", code=2)
    if not 1000 <= duration_ms <= 180_000:
        fail("duration-ms must be 1000..180000", code=2)
    rng = np.random.default_rng(seed)
    total = duration_ms / 1000
    buf, bpm = GENERATORS[mood](total, rng)
    buf = buf[: int(total * SR)]
    buf = filt(buf.T, "highpass", 30).T  # remove DC / sub rumble
    fade = envelope(buf.shape[0], min(1.0, total / 4), min(1.5, total / 4))
    buf = buf * fade[:, None]
    buf, lufs = normalize(buf)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".tmp.wav")
    sf.write(str(tmp), buf.astype(np.float32), SR, subtype="PCM_16")
    os.replace(tmp, out)
    info = sf.info(str(out))
    log("info", "music rendered", mood=mood, durationMs=duration_ms, lufs=round(lufs, 2))
    return {
        "mood": mood,
        "path": str(out),
        "bpm": bpm,
        "seed": seed,
        "sampleRate": SR,
        "durationMs": round(info.frames * 1000 / info.samplerate, 3),
        "integratedLufs": round(lufs, 2),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mood", choices=MOODS)
    ap.add_argument("--duration-ms", type=int, default=32_000)
    ap.add_argument("--out")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--all-moods", action="store_true")
    ap.add_argument("--out-dir")
    args = ap.parse_args()

    if args.all_moods:
        if not args.out_dir:
            fail("--all-moods needs --out-dir", code=2)
        tracks = [render(m, args.duration_ms, Path(args.out_dir) / f"{m}.wav", args.seed) for m in MOODS]
        emit({"ok": True, "tracks": tracks})
        return
    if not args.mood or not args.out:
        fail("need --mood and --out (or --all-moods --out-dir)", code=2)
    emit({"ok": True, **render(args.mood, args.duration_ms, Path(args.out), args.seed)})


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as err:  # noqa: BLE001
        fail(f"music failed: {type(err).__name__}: {err}")
