/**
 * Locations of every operational state file under data/ (spec 4 + 6).
 * One schema-versioned JSON file per reel per stage. Tests pass a temp root.
 */
import path from 'node:path';
import { PROJECT_ROOT } from '../config';

export interface DataPaths {
  root: string;
  queueDir: string;
  ledgerDir: string;
  approvalsDir: string;
  engageDir: string;
  metricsDir: string;
  proposalsDir: string;
  runsDir: string;
  telegramDir: string;
  specsDir: string;
  trendsDir: string;
  controlFile: string;
  usageFile: string;
  requestsFile: string;
  /** Human-readable reports (progress/runs/). */
  reportsDir: string;
  /** Local render/artifact area (gitignored). */
  outDir: string;
}

/** Build the path set. `root` defaults to $DATA_DIR or <project>/data. */
export function dataPaths(
  root: string = process.env.DATA_DIR ?? path.join(PROJECT_ROOT, 'data'),
  opts: { reportsDir?: string; outDir?: string } = {},
): DataPaths {
  return {
    root,
    queueDir: path.join(root, 'queue'),
    ledgerDir: path.join(root, 'ledger'),
    approvalsDir: path.join(root, 'approvals'),
    engageDir: path.join(root, 'engage'),
    metricsDir: path.join(root, 'metrics'),
    proposalsDir: path.join(root, 'proposals'),
    runsDir: path.join(root, 'runs'),
    telegramDir: path.join(root, 'telegram'),
    specsDir: path.join(root, 'specs'),
    trendsDir: path.join(root, 'trends'),
    controlFile: path.join(root, 'control.json'),
    usageFile: path.join(root, 'usage.json'),
    requestsFile: path.join(root, 'requests.json'),
    reportsDir: opts.reportsDir ?? path.join(PROJECT_ROOT, 'progress', 'runs'),
    outDir: opts.outDir ?? path.join(PROJECT_ROOT, 'out'),
  };
}
