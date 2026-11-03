/** Small local-file helpers for render: image dimensions (PNG/JPEG/WebP) and a WAV writer for tests/smoke. */
import { promises as fs } from 'node:fs';

export interface ImageSize {
  width: number;
  height: number;
  type: 'png' | 'jpeg' | 'webp';
}

/** Read pixel dimensions from an image header. Returns null for unsupported/corrupt files. */
export function imageSizeFromBuffer(buf: Uint8Array): ImageSize | null {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  // PNG: 8-byte signature, then IHDR width/height (big endian).
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('ascii', 12, 16) === 'IHDR') {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), type: 'png' };
  }
  // JPEG: walk segments to the first SOFn marker.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7), type: 'jpeg' };
      i += 2 + len;
    }
    return null;
  }
  // WebP: RIFF....WEBP + VP8 / VP8L / VP8X chunk.
  if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8 ')
      return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, type: 'webp' };
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, type: 'webp' };
    }
    if (chunk === 'VP8X')
      return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1, type: 'webp' };
  }
  return null;
}

export async function imageSize(filePath: string): Promise<ImageSize | null> {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return imageSizeFromBuffer(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

/**
 * 16-bit mono PCM WAV with a speech-like amplitude envelope (syllable pulses), used by the smoke
 * render and tests so the audio-driven mascot mouth has something to react to. Not real speech.
 */
export function speechLikeWav(seconds: number, sampleRate = 48_000, freq = 220): Buffer {
  const n = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.max(0, Math.sin(2 * Math.PI * 4 * t)) * 0.5;
    const s = env * (Math.sin(2 * Math.PI * freq * t) + 0.3 * Math.sin(2 * Math.PI * freq * 2.01 * t));
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(s * 20000))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
