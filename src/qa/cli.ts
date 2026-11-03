/**
 * `npm run qa -- --spec s.json [--render-report out/<id>/render-report.json] [--video x.mp4]
 *   [--voice-track v.json] [--corpus c.json] [--mode dry_run|approval|auto] [--data-dir data]
 *   [--verify-facts]`
 * Runs the full QA (no visual reviewer here: the agents module plugs one in, so the verdict is at
 * best "flagged"). Writes data/qa/<DATE>/<id>.json. Exit 0 = pass/flagged, 1 = fail.
 * --verify-facts fetches fact sources (GET only, via the shared http wrapper).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadBlocklist, loadBrand } from '../config';
import { runMain } from '../lib/cli';
import { createLogger } from '../lib/logger';
import { Blocklist, Brand, ReelSpec, RenderReport, VoiceTrack } from '../schemas';
import { runQA, writeQaReport } from './index';
import type { OriginalityCorpus } from './originality';

const readJson = async (p: string): Promise<unknown> => JSON.parse(await readFile(p, 'utf8')) as unknown;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      spec: { type: 'string' },
      'render-report': { type: 'string' },
      video: { type: 'string' },
      'voice-track': { type: 'string' },
      corpus: { type: 'string' },
      mode: { type: 'string', default: 'dry_run' },
      'data-dir': { type: 'string', default: 'data' },
      'verify-facts': { type: 'boolean', default: false },
    },
  });
  if (!values.spec) {
    process.stderr.write('usage: npm run qa -- --spec spec.json [--render-report r.json] [--video x.mp4]\n');
    return 2;
  }
  const mode = values.mode;
  if (mode !== 'dry_run' && mode !== 'approval' && mode !== 'auto') {
    process.stderr.write(`invalid --mode ${mode}\n`);
    return 2;
  }
  const spec = ReelSpec.parse(await readJson(values.spec));
  const log = createLogger({ stage: 'qa.cli', reelId: spec.id });
  const rrPath = values['render-report'] ?? path.join('out', spec.id, 'render-report.json');
  const renderReport = RenderReport.parse(await readJson(rrPath));
  const voiceTrack = values['voice-track'] ? VoiceTrack.parse(await readJson(values['voice-track'])) : null;
  const corpus: OriginalityCorpus = values.corpus
    ? ((await readJson(values.corpus)) as OriginalityCorpus)
    : { texts: [] };
  const [brand, blocklist] = await Promise.all([loadBrand(), loadBlocklist()]);
  const b = Brand.parse(brand);
  const out = await runQA({
    videoPath: values.video ?? renderReport.outputPath,
    brand: b,
    blocklist: Blocklist.parse(blocklist),
    renderReport,
    voiceTrack,
    spec,
    corpus,
    publishMode: mode,
    framesDir: path.join('out', spec.id, 'frames'),
    reviewer: null,
    originality: { disclosureLine: b.disclosure.captionLine },
    facts: { mode: values['verify-facts'] ? 'verify' : 'check' },
  });
  const p = await writeQaReport(values['data-dir'], out.report);
  log.info('qa report written', { path: p, verdict: out.report.verdict, dropped: out.dropped });
  for (const c of out.report.checks.filter((x) => x.status === 'fail' || x.status === 'warn')) {
    process.stdout.write(`${c.status.toUpperCase()} ${c.id}: ${c.message}\n`);
  }
  process.stdout.write(`verdict: ${out.report.verdict}\n`);
  return out.report.verdict === 'fail' ? 1 : 0;
}

runMain('qa', main);
