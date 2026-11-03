/** ffprobe wrapper (local binary, bounded by a timeout). Returns null when ffprobe isn't installed. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface MediaProbe {
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  pixFmt: string | null;
  fps: number | null;
  audioCodec: string | null;
  sampleRate: number | null;
  durationSec: number | null;
  bytes: number | null;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  sample_rate?: string;
}

export async function ffprobeAvailable(bin = process.env.FFPROBE_BIN ?? 'ffprobe'): Promise<boolean> {
  try {
    await run(bin, ['-version'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export async function probeMedia(
  file: string,
  bin = process.env.FFPROBE_BIN ?? 'ffprobe',
): Promise<MediaProbe | null> {
  if (!(await ffprobeAvailable(bin))) return null;
  const { stdout } = await run(bin, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const json = JSON.parse(stdout) as {
    streams?: FfprobeStream[];
    format?: { duration?: string; size?: string };
  };
  const v = json.streams?.find((s) => s.codec_type === 'video');
  const a = json.streams?.find((s) => s.codec_type === 'audio');
  let fps: number | null = null;
  if (v?.r_frame_rate) {
    const [num, den] = v.r_frame_rate.split('/').map(Number);
    if (num && den) fps = num / den;
  }
  return {
    width: v?.width ?? null,
    height: v?.height ?? null,
    videoCodec: v?.codec_name ?? null,
    pixFmt: v?.pix_fmt ?? null,
    fps,
    audioCodec: a?.codec_name ?? null,
    sampleRate: a?.sample_rate ? Number(a.sample_rate) : null,
    durationSec: json.format?.duration ? Number(json.format.duration) : null,
    bytes: json.format?.size ? Number(json.format.size) : null,
  };
}
