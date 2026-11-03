/**
 * Text bounds report (spec 7.6): every measured text box per scene plus the caption boxes,
 * in the shared RenderReport schema (src/schemas/media.ts) that QA checks against the safe zone.
 * A richer debug file (lines, regions, timeline) is written next to it as text-bounds.json.
 */
import path from 'node:path';
import { z } from 'zod';
import { writeJsonAtomic } from '../lib/store';
import { RenderReport, type TextBox } from '../schemas/media';
import type { LaidOutBox, ReelLayout } from '../../remotion/props';
import { rectInside, safeRect, safeZonePx, VIDEO, type SafeZonePct } from '../../remotion/theme';
import { msToFrame } from '../../remotion/timeline';

export const toTextBox = (b: LaidOutBox): TextBox => ({
  id: b.id,
  text: b.text,
  x: b.x,
  y: b.y,
  width: b.width,
  height: b.height,
  fontSize: b.fontSize,
  overflow: b.overflow,
});

export interface BuildReportInput {
  reelId: string;
  outputPath: string;
  layout: ReelLayout;
  sceneTypes: string[];
  safeZone: SafeZonePct | null;
  coverOffsetMs: number;
  renderMs: number | null;
  now?: Date;
  width?: number;
  height?: number;
  fps?: number;
}

export function buildRenderReport(input: BuildReportInput): RenderReport {
  const fps = input.fps ?? VIDEO.fps;
  const width = input.width ?? VIDEO.width;
  const height = input.height ?? VIDEO.height;
  const px = safeZonePx(input.safeZone ?? undefined, width, height);
  const lastFrame = input.layout.durationInFrames - 1;
  return RenderReport.parse({
    schemaVersion: 1,
    reelId: input.reelId,
    createdAt: (input.now ?? new Date()).toISOString(),
    outputPath: input.outputPath,
    width,
    height,
    fps,
    durationInFrames: input.layout.durationInFrames,
    safeZonePx: px,
    scenes: input.layout.timeline.map((t, i) => ({
      index: t.index,
      sceneType: input.sceneTypes[i] ?? input.layout.scenes[i]?.sceneType ?? 'unknown',
      startFrame: t.startFrame,
      endFrame: Math.min(lastFrame, t.startFrame + t.frames - 1),
      textBoxes: (input.layout.scenes[i]?.boxes ?? []).map(toTextBox),
    })),
    captionBoxes: input.layout.captions.map((c) => toTextBox(c.box)),
    coverFrame: Math.min(lastFrame, msToFrame(input.coverOffsetMs, fps)),
    renderMs: input.renderMs,
  });
}

/** Problems a QA reader would flag: boxes outside the safe rectangle or overflowing. Empty = clean. */
export function textBoundsProblems(report: RenderReport, sz: SafeZonePct | null = null): string[] {
  const rect = sz
    ? safeRect(sz, report.width, report.height)
    : {
        x: report.safeZonePx.left,
        y: report.safeZonePx.top,
        width: report.width - report.safeZonePx.left - report.safeZonePx.right,
        height: report.height - report.safeZonePx.top - report.safeZonePx.bottom,
      };
  const problems: string[] = [];
  const check = (where: string, b: TextBox) => {
    if (b.text && !rectInside(b, rect)) problems.push(`${where} ${b.id} outside safe zone`);
    if (b.overflow) problems.push(`${where} ${b.id} text overflow`);
  };
  report.scenes.forEach((s) => s.textBoxes.forEach((b) => check(`scene ${s.index}`, b)));
  report.captionBoxes.forEach((b) => check('caption', b));
  return problems;
}

export const TextBoundsDebug = z.object({
  schemaVersion: z.literal(1),
  reelId: z.string(),
  measuredWith: z.string(),
  layout: z.unknown(),
});

/** Write render-report.json (schema) and text-bounds.json (full layout) into `dir`. */
export async function writeRenderReports(
  dir: string,
  report: RenderReport,
  layout: ReelLayout,
): Promise<{ reportPath: string; boundsPath: string }> {
  const reportPath = path.join(dir, 'render-report.json');
  const boundsPath = path.join(dir, 'text-bounds.json');
  await writeJsonAtomic(reportPath, report, RenderReport);
  await writeJsonAtomic(
    boundsPath,
    { schemaVersion: 1, reelId: report.reelId, measuredWith: layout.measuredWith, layout },
    TextBoundsDebug,
  );
  return { reportPath, boundsPath };
}
