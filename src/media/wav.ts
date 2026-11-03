/**
 * Minimal PCM16 WAV reader/writer (the format Kokoro output is written in).
 * Durations are measured from the sample count, never estimated.
 */
import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../lib/store';

export interface Pcm16Audio {
  sampleRate: number;
  channels: number;
  /** Interleaved samples. */
  data: Int16Array;
}

export class WavFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WavFormatError';
  }
}

export function frames(audio: Pcm16Audio): number {
  return Math.floor(audio.data.length / audio.channels);
}

export function durationMs(audio: Pcm16Audio): number {
  return (frames(audio) * 1000) / audio.sampleRate;
}

export function parseWav(buf: Buffer): Pcm16Audio {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new WavFormatError('not a RIFF/WAVE file');
  }
  let off = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      let format = buf.readUInt16LE(body);
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24); // WAVE_FORMAT_EXTENSIBLE subformat
      fmt = {
        format,
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) throw new WavFormatError('data chunk before fmt chunk');
      if (fmt.format !== 1 || fmt.bits !== 16) {
        throw new WavFormatError(
          `unsupported WAV encoding (format ${fmt.format}, ${fmt.bits}-bit); need PCM16`,
        );
      }
      const len = Math.min(size, buf.length - body) & ~1;
      const data = new Int16Array(len / 2);
      for (let i = 0; i < data.length; i++) data[i] = buf.readInt16LE(body + i * 2);
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, data };
    }
    off = body + size + (size % 2);
  }
  throw new WavFormatError('no data chunk');
}

export async function readWav(filePath: string): Promise<Pcm16Audio> {
  return parseWav(await readFile(filePath));
}

export function encodeWav(audio: Pcm16Audio): Buffer {
  const dataBytes = audio.data.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(audio.channels, 22);
  buf.writeUInt32LE(audio.sampleRate, 24);
  buf.writeUInt32LE(audio.sampleRate * audio.channels * 2, 28);
  buf.writeUInt16LE(audio.channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < audio.data.length; i++) buf.writeInt16LE(audio.data[i] ?? 0, 44 + i * 2);
  return buf;
}

export async function writeWav(filePath: string, audio: Pcm16Audio): Promise<void> {
  await writeFileAtomic(filePath, encodeWav(audio));
}

/** Join clips (same rate/channels) with `gapMs` of silence between them. Returns start offsets (ms). */
export function concatWithGaps(
  clips: Pcm16Audio[],
  gapMs: number,
): { audio: Pcm16Audio; startsMs: number[] } {
  const first = clips[0];
  if (!first) throw new WavFormatError('nothing to concatenate');
  for (const c of clips) {
    if (c.sampleRate !== first.sampleRate || c.channels !== first.channels) {
      throw new WavFormatError('clips differ in sample rate or channel count');
    }
  }
  const gapFrames = Math.round((gapMs / 1000) * first.sampleRate);
  const totalFrames = clips.reduce((n, c) => n + frames(c), 0) + gapFrames * (clips.length - 1);
  const data = new Int16Array(totalFrames * first.channels);
  const startsMs: number[] = [];
  let pos = 0;
  clips.forEach((c, i) => {
    startsMs.push((pos * 1000) / first.sampleRate);
    data.set(c.data.subarray(0, frames(c) * c.channels), pos * first.channels);
    pos += frames(c) + (i < clips.length - 1 ? gapFrames : 0);
  });
  return { audio: { sampleRate: first.sampleRate, channels: first.channels, data }, startsMs };
}

/**
 * Speech onset/offset (ms) by short-window RMS against a threshold relative to the clip peak.
 * Independent of the recognizer, so QA can use it to check caption timing.
 */
export function speechBounds(
  audio: Pcm16Audio,
  opts: { windowMs?: number; thresholdDb?: number } = {},
): { onsetMs: number; offsetMs: number } | null {
  const win = Math.max(1, Math.round(((opts.windowMs ?? 10) / 1000) * audio.sampleRate));
  const n = frames(audio);
  const rms: number[] = [];
  for (let s = 0; s < n; s += win) {
    let acc = 0;
    let cnt = 0;
    for (let f = s; f < Math.min(n, s + win); f++) {
      for (let ch = 0; ch < audio.channels; ch++) {
        const v = (audio.data[f * audio.channels + ch] ?? 0) / 32768;
        acc += v * v;
        cnt++;
      }
    }
    rms.push(Math.sqrt(acc / Math.max(1, cnt)));
  }
  const peak = rms.reduce((m, r) => (r > m ? r : m), 0);
  if (peak <= 0) return null;
  const thr = peak * 10 ** ((opts.thresholdDb ?? -35) / 20);
  const firstIdx = rms.findIndex((r) => r >= thr);
  let lastIdx = -1;
  for (let i = rms.length - 1; i >= 0; i--) {
    if ((rms[i] ?? 0) >= thr) {
      lastIdx = i;
      break;
    }
  }
  if (firstIdx < 0 || lastIdx < 0) return null;
  const msPerWin = (win * 1000) / audio.sampleRate;
  return { onsetMs: firstIdx * msPerWin, offsetMs: Math.min((lastIdx + 1) * msPerWin, durationMs(audio)) };
}
