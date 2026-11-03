/**
 * renderReel(): ReelSpec + measured VoiceTrack (+ audio, + Tier B images) -> H.264/AAC 48 kHz MP4
 * and the text bounds report. Local only: no network writes (the browser loads Google Fonts and
 * the staged assets from Remotion's local server).
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import type { VideoConfig } from 'remotion';
import { createLogger } from '../lib/logger';
import { ReelSpec } from '../schemas/reelSpec';
import { VoiceTrack, type RenderReport } from '../schemas/media';
import { buildRenderProps, type TimingsLike } from '../../remotion/buildProps';
import {
  ReelLayout,
  ReelRenderProps,
  type ReelRenderPropsInput,
  type SceneImage,
} from '../../remotion/props';
import { VIDEO, type SafeZonePct } from '../../remotion/theme';
import { browserExecutable, ensureRenderBrowser, getBundle, stageFile } from './bundle';
import { imageSize } from './files';
import { probeMedia, type MediaProbe } from './probe';
import { buildRenderReport, writeRenderReports } from './report';

export const AUDIO_SAMPLE_RATE = 48_000;
export const MAX_BYTES = VIDEO.maxBytes;
export const MAX_SECONDS = VIDEO.maxSeconds;

/**
 * Render concurrency: RENDER_CONCURRENCY wins; on 2-core runners use both cores; elsewhere leave
 * headroom for the encoder (75% of cores, max 8).
 */
export function tunedConcurrency(cpus = os.cpus().length, env: NodeJS.ProcessEnv = process.env): number {
  const fromEnv = Number(env.RENDER_CONCURRENCY);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return Math.min(fromEnv, Math.max(1, cpus));
  if (cpus <= 2) return Math.max(1, cpus);
  return Math.max(2, Math.min(8, Math.floor(cpus * 0.75)));
}

export interface RenderReelInput {
  spec: ReelSpec;
  /** Final mix (or voice) audio; null renders a silent AAC track (previews/tests only). */
  audioPath: string | null;
  timings: TimingsLike;
  outPath: string;
  /** Local Tier B image paths by beat index. */
  images?: Record<number, string>;
  showSafeZone?: boolean;
  showCaptions?: boolean;
  mascotEnabled?: boolean;
  safeZone?: SafeZonePct;
  /** Inclusive frame range (smoke renders). */
  frameRange?: [number, number] | null;
  concurrency?: number;
  /** Where render-report.json / text-bounds.json go (default: next to outPath). */
  reportDir?: string;
  runId?: string;
}

export interface RenderReelResult {
  outputPath: string;
  report: RenderReport;
  reportPath: string;
  boundsPath: string;
  renderMs: number;
  probe: MediaProbe | null;
  /** Spec limits that the output breaks (QA owns the final verdict). */
  warnings: string[];
}

export interface PreparedReel {
  serveUrl: string;
  inputProps: ReelRenderProps;
  composition: VideoConfig;
  layout: ReelLayout;
}

async function stageImages(serveUrl: string, ns: string, images: Record<number, string> | undefined) {
  const staged: Record<number, SceneImage> = {};
  for (const [k, file] of Object.entries(images ?? {})) {
    const size = await imageSize(file);
    if (!size) throw new Error(`unsupported or unreadable image for beat ${k}: ${path.basename(file)}`);
    const src = await stageFile(serveUrl, file, ns, `img-${k}.${size.type === 'jpeg' ? 'jpg' : size.type}`);
    staged[Number(k)] = { src, width: size.width, height: size.height };
  }
  return staged;
}

/** Validate inputs, bundle, stage assets and let calculateMetadata() measure the layout in the browser. */
export async function prepareReel(input: Omit<RenderReelInput, 'outPath'>): Promise<PreparedReel> {
  const spec = ReelSpec.parse(input.spec);
  const timings = VoiceTrack.pick({ beats: true, words: true, totalMs: true, gapMs: true }).parse(
    input.timings,
  );
  await ensureRenderBrowser();
  const serveUrl = await getBundle();
  const ns = `${spec.id}-${Date.now().toString(36)}`;
  const audioSrc = input.audioPath
    ? await stageFile(serveUrl, input.audioPath, ns, `audio${path.extname(input.audioPath) || '.wav'}`)
    : null;
  const images = await stageImages(serveUrl, ns, input.images);
  const raw: ReelRenderPropsInput = buildRenderProps(spec, timings, {
    audioSrc,
    images,
    showSafeZone: input.showSafeZone ?? false,
    showCaptions: input.showCaptions ?? true,
    mascotEnabled: input.mascotEnabled ?? true,
    ...(input.safeZone ? { safeZone: input.safeZone } : {}),
  });
  const inputProps = ReelRenderProps.parse(raw);
  const composition = await selectComposition({
    serveUrl,
    id: 'Reel',
    inputProps,
    browserExecutable: browserExecutable(),
    logLevel: 'warn',
    timeoutInMilliseconds: 120_000,
  });
  const resolved = ReelRenderProps.parse(composition.props);
  if (!resolved.layout) throw new Error('calculateMetadata() did not return a layout');
  return { serveUrl, inputProps, composition, layout: ReelLayout.parse(resolved.layout) };
}

export async function renderReel(input: RenderReelInput): Promise<RenderReelResult> {
  const log = createLogger({
    stage: 'render',
    reelId: input.spec.id,
    ...(input.runId ? { runId: input.runId } : {}),
  });
  const outputPath = path.resolve(input.outPath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const prepared = await log.time('prepare', () => prepareReel(input));
  const concurrency = input.concurrency ?? tunedConcurrency();
  const started = Date.now();
  await log.time(
    'renderMedia',
    () =>
      renderMedia({
        serveUrl: prepared.serveUrl,
        composition: prepared.composition,
        inputProps: prepared.composition.props,
        codec: 'h264',
        audioCodec: 'aac',
        audioBitrate: '192k',
        pixelFormat: 'yuv420p',
        crf: 20,
        x264Preset: 'medium',
        enforceAudioTrack: true,
        concurrency,
        outputLocation: outputPath,
        overwrite: true,
        frameRange: input.frameRange ?? null,
        browserExecutable: browserExecutable(),
        logLevel: 'warn',
        timeoutInMilliseconds: 120_000,
      }),
    { concurrency, frames: prepared.composition.durationInFrames },
  );
  const renderMs = Date.now() - started;
  const report = buildRenderReport({
    reelId: input.spec.id,
    outputPath,
    layout: prepared.layout,
    sceneTypes: input.spec.beats.map((b) => b.sceneType),
    safeZone: prepared.inputProps.safeZone,
    coverOffsetMs: input.spec.coverOffsetMs,
    renderMs,
  });
  const { reportPath, boundsPath } = await writeRenderReports(
    input.reportDir ?? path.dirname(outputPath),
    report,
    prepared.layout,
  );

  const probe = await probeMedia(outputPath).catch(() => null);
  const warnings: string[] = [];
  if (probe) {
    if (probe.width !== VIDEO.width || probe.height !== VIDEO.height)
      warnings.push(`size ${probe.width}x${probe.height}`);
    if (probe.videoCodec !== 'h264') warnings.push(`video codec ${probe.videoCodec}`);
    if (probe.audioCodec !== 'aac') warnings.push(`audio codec ${probe.audioCodec}`);
    if (probe.sampleRate !== AUDIO_SAMPLE_RATE) warnings.push(`audio sample rate ${probe.sampleRate}`);
    if ((probe.durationSec ?? 0) > MAX_SECONDS)
      warnings.push(`duration ${probe.durationSec}s > ${MAX_SECONDS}s`);
    if ((probe.bytes ?? 0) > MAX_BYTES) warnings.push(`size ${probe.bytes} bytes > ${MAX_BYTES}`);
  }
  for (const w of warnings) log.warn('output outside spec limits', { problem: w });
  log.info('rendered', { renderMs, bytes: probe?.bytes ?? null, durationSec: probe?.durationSec ?? null });
  return { outputPath, report, reportPath, boundsPath, renderMs, probe, warnings };
}

export interface SceneStill {
  index: number;
  sceneType: string;
  renderedAs: string;
  frame: number;
  path: string;
}

/**
 * Render one PNG still per scene at a representative frame (after entrance animations), used by
 * tests and previews. Frame = scene start + min(60 % of the scene, 1.2 s).
 */
export async function renderSceneStills(
  input: Omit<RenderReelInput, 'outPath' | 'frameRange'> & { outDir: string; sceneIndexes?: number[] },
): Promise<SceneStill[]> {
  const prepared = await prepareReel(input);
  await fs.mkdir(input.outDir, { recursive: true });
  const out: SceneStill[] = [];
  const indexes = input.sceneIndexes ?? prepared.layout.timeline.map((t) => t.index);
  for (const i of indexes) {
    const t = prepared.layout.timeline[i];
    const sl = prepared.layout.scenes[i];
    if (!t || !sl) throw new Error(`no scene ${i}`);
    const frame = t.startFrame + Math.min(Math.floor(t.frames * 0.6), Math.round(VIDEO.fps * 1.2));
    const file = path.join(input.outDir, `scene-${String(i).padStart(2, '0')}-${sl.renderedAs}.png`);
    await renderStill({
      serveUrl: prepared.serveUrl,
      composition: prepared.composition,
      inputProps: prepared.composition.props,
      frame,
      output: file,
      imageFormat: 'png',
      overwrite: true,
      browserExecutable: browserExecutable(),
      logLevel: 'warn',
      timeoutInMilliseconds: 120_000,
    });
    out.push({ index: i, sceneType: sl.sceneType, renderedAs: sl.renderedAs, frame, path: file });
  }
  return out;
}
