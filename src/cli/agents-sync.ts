/**
 * `npm run agents:sync` (T4.2): render .claude/agents/<name>.md from the canonical agents/<name>.md.
 * `npm run agents:sync -- --check` writes nothing and exits 1 when any copy drifted or is orphaned.
 */
import path from 'node:path';
import { PROJECT_ROOT } from '../config';
import { syncAgents } from '../claude/agents';
import { runMain } from '../lib/cli';

runMain('agents:sync', async () => {
  const check = process.argv.slice(2).includes('--check');
  const res = await syncAgents({ check });
  const rel = (p: string) => path.relative(PROJECT_ROOT, p);
  const summary = {
    mode: check ? 'check' : 'write',
    written: res.written.map(rel),
    unchanged: res.unchanged.length,
    drifted: res.drifted.map(rel),
    orphans: res.orphans.map(rel),
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  if (check && (res.drifted.length > 0 || res.orphans.length > 0)) return 1;
  return 0;
});
