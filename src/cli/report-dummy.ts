/**
 * `npm run report:dummy` (T1.5): writes a dummy daily report to out/runs/ (not progress/runs/,
 * so dummy output never pollutes the real record). Pass --dir <path> to choose another folder.
 */
import path from 'node:path';
import { PROJECT_ROOT } from '../config';
import { runMain } from '../lib/cli';
import { newRunId } from '../lib/ids';
import { createLogger } from '../lib/logger';
import { dummyRunReport, writeDailyReport } from '../lib/runReport';
import { istDate } from '../lib/time';

runMain('report:dummy', async () => {
  const i = process.argv.indexOf('--dir');
  const dir =
    i > -1 && process.argv[i + 1]
      ? path.resolve(process.argv[i + 1] as string)
      : path.join(PROJECT_ROOT, 'out', 'runs');
  const now = new Date();
  const runId = newRunId('dummy', now);
  const logger = createLogger({ runId, stage: 'report' });
  const file = await writeDailyReport(dummyRunReport(runId, istDate(now), now), dir);
  logger.info('dummy report written', { file: path.relative(PROJECT_ROOT, file) });
  process.stdout.write(file + '\n');
});
