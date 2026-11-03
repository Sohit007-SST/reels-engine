"""Procedural sound effects (numpy only; no samples, no licensing risk).

Effects: whoosh, pop, hit, riser, ding, click.
  riser ends on its peak, so the mixer places it to END at the cue time (see src/media/mix.ts).

Usage:
  sfx_gen.py --name whoosh --out whoosh.wav [--seed 11]
  sfx_gen.py --all --out-dir assets/sfx

Output: 48 kHz stereo PCM16 WAV, peak -3 dBFS. Same seed => same file.
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
PEAK = 10 ** (-3 / 20)
NAMES = ("whoosh", "pop", "hit", "riser", "ding", "click")


def filt(sig, kind, cutoff, order=2):
    return sosfilt(butter(order, cutoff, btype=kind, fs=SR, output="sos"), sig)


def t_axis(dur):
    return np.arange(int(dur * SR)) / SR


def sweep_noise(rng, dur, f_start, f_end, blocks=48):
    """Noise through a band-pass whose centre moves from f_start to f_end (block-wise, crossfaded)."""
    n = int(dur * SR)
    noise = rng.standard_normal(n + SR // 10)
    out = np.zeros(n)
    edges = np.linspace(0, n, blocks + 1).astype(int)
    centres = np.geomspace(f_start, f_end, blocks)
    xf = 256
    for b in range(blocks):
        lo, hi = edges[b], min(n, edges[b + 1] + xf)
        c = centres[b]
        band = filt(noise[max(0, lo - 2048) : hi], "bandpass", (c / 1.6, min(c * 1.6, SR / 2 - 100)))
        band = band[lo - max(0, lo - 2048) :]
        w = np.ones(hi - lo)
        if b > 0:
            w[:xf] = np.linspace(0, 1, xf)
        if b < blocks - 1 and hi - lo > xf:
            w[-xf:] = np.linspace(1, 0, xf)
        out[lo:hi] += band[: hi - lo] * w
    return out


def whoosh(rng):
    dur = 0.65
    t = t_axis(dur)
    sig = sweep_noise(rng, dur, 300, 4500)
    env = np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 2
    pan = np.linspace(-0.8, 0.8, t.size)
    mono = sig * env
    return np.stack([mono * np.cos((pan + 1) * np.pi / 4), mono * np.sin((pan + 1) * np.pi / 4)], 1)


def pop(rng):
    dur = 0.12
    t = t_axis(dur)
    f = 300 + 700 * np.exp(-t / 0.015)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.03)
    click = filt(rng.standard_normal(t.size), "highpass", 3000) * np.exp(-t / 0.002) * 0.3
    mono = body + click
    return np.stack([mono, mono], 1)


def hit(rng):
    dur = 1.1
    t = t_axis(dur)
    f = 45 + 110 * np.exp(-t / 0.05)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.35)
    crack = filt(rng.standard_normal(t.size), "bandpass", (200, 3000)) * np.exp(-t / 0.04) * 0.5
    tail = filt(rng.standard_normal(t.size), "lowpass", 500) * np.exp(-t / 0.4) * 0.15
    mono = np.tanh(2.0 * (body + crack + tail))
    return np.stack([mono, mono * 0.97], 1)


def riser(rng):
    dur = 1.5
    t = t_axis(dur)
    env = (t / dur) ** 2.2
    noise = sweep_noise(rng, dur, 400, 9000) * 0.8
    f = np.geomspace(200, 1600, t.size)
    tone = 0.35 * np.sin(2 * np.pi * np.cumsum(f) / SR) + 0.15 * np.sin(2 * np.pi * np.cumsum(f * 1.5) / SR)
    mono = (noise + tone) * env
    mono[-int(0.01 * SR) :] *= np.linspace(1, 0, int(0.01 * SR))
    return np.stack([mono, mono], 1)


def ding(rng):
    dur = 1.4
    t = t_axis(dur)
    f0 = 1320.0
    mono = np.zeros(t.size)
    for ratio, amp, dec in ((1.0, 1.0, 0.6), (2.76, 0.45, 0.3), (5.4, 0.2, 0.15), (8.93, 0.08, 0.08)):
        mono += amp * np.sin(2 * np.pi * f0 * ratio * t) * np.exp(-t / dec)
    mono[: int(0.002 * SR)] *= np.linspace(0, 1, int(0.002 * SR))
    return np.stack([mono, mono], 1)


def click(rng):
    dur = 0.04
    t = t_axis(dur)
    mono = filt(rng.standard_normal(t.size), "bandpass", (1500, 6000)) * np.exp(-t / 0.004)
    mono += 0.5 * np.sin(2 * np.pi * 2200 * t) * np.exp(-t / 0.006)
    return np.stack([mono, mono], 1)


EFFECTS = {"whoosh": whoosh, "pop": pop, "hit": hit, "riser": riser, "ding": ding, "click": click}


def render(name: str, out: Path, seed: int) -> dict:
    import soundfile as sf

    if name not in EFFECTS:
        fail(f"unknown sfx {name!r}; expected one of {NAMES}", code=2)
    rng = np.random.default_rng(seed + NAMES.index(name))
    sig = EFFECTS[name](rng)
    peak = float(np.max(np.abs(sig)))
    if peak > 0:
        sig = sig * (PEAK / peak)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".tmp.wav")
    sf.write(str(tmp), sig.astype(np.float32), SR, subtype="PCM_16")
    os.replace(tmp, out)
    info = sf.info(str(out))
    log("info", "sfx rendered", name=name)
    return {
        "name": name,
        "path": str(out),
        "seed": seed,
        "sampleRate": SR,
        "durationMs": round(info.frames * 1000 / info.samplerate, 3),
        # Riser builds up to its end; place it so it ENDS at the cut.
        "anchor": "end" if name == "riser" else "start",
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", choices=NAMES)
    ap.add_argument("--out")
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--out-dir")
    args = ap.parse_args()
    if args.all:
        if not args.out_dir:
            fail("--all needs --out-dir", code=2)
        emit({"ok": True, "effects": [render(n, Path(args.out_dir) / f"{n}.wav", args.seed) for n in NAMES]})
        return
    if not args.name or not args.out:
        fail("need --name and --out (or --all --out-dir)", code=2)
    emit({"ok": True, **render(args.name, Path(args.out), args.seed)})


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as err:  # noqa: BLE001
        fail(f"sfx failed: {type(err).__name__}: {err}")
