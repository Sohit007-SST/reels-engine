/**
 * Upload owner-confirmed keys from api_keys/.env to GitHub Actions secrets (T7.1 / M11).
 *
 *   npm run github:secrets -- --names CLAUDE_CODE_OAUTH_TOKEN,TELEGRAM_BOT_TOKEN --confirmed
 *
 * - Only names on GITHUB_SECRET_ALLOWLIST are accepted (META_APP_ID / META_APP_SECRET never).
 * - Values are piped to `gh secret set NAME` on stdin: never printed, never on the command line.
 * - Prints only "NAME uploaded" / "NAME missing in env file" / "NAME refused".
 * - Without --confirmed it only prints the plan (dry run).
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import { DEFAULT_ENV_FILE, GITHUB_SECRET_ALLOWLIST } from '../config';

export type SecretPlanRow = { name: string; action: 'upload' | 'missing' | 'refused' };

export function planSecrets(names: string[], env: Record<string, string>): SecretPlanRow[] {
  const allow = new Set<string>(GITHUB_SECRET_ALLOWLIST);
  return names.map((name) => {
    if (!allow.has(name)) return { name, action: 'refused' };
    const v = env[name];
    return { name, action: v && v.trim() ? 'upload' : 'missing' };
  });
}

function ghSecretSet(name: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', ['secret', 'set', name], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // gh's stderr never contains the value (it was sent on stdin), but keep only the first line.
      if (code === 0) resolve();
      else reject(new Error(`gh secret set ${name} failed: ${err.split('\n')[0] ?? ''}`));
    });
    child.stdin.end(value);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf('--names');
  const names = (i >= 0 ? (args[i + 1] ?? '') : '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!names.length) {
    console.log('Usage: npm run github:secrets -- --names NAME1,NAME2 [--confirmed]');
    console.log(`Allowed: ${GITHUB_SECRET_ALLOWLIST.join(', ')}`);
    process.exit(2);
  }
  const envFile = process.env.ENV_FILE ?? DEFAULT_ENV_FILE;
  const env = parse(await readFile(envFile, 'utf8'));
  const plan = planSecrets(names, env);
  const confirmed = args.includes('--confirmed');
  let failed = false;
  for (const row of plan) {
    if (row.action !== 'upload') {
      console.log(
        `${row.name.padEnd(26)} ${row.action === 'refused' ? 'refused (not on allowlist)' : 'missing in env file'}`,
      );
      failed = failed || row.action === 'refused';
      continue;
    }
    if (!confirmed) {
      console.log(`${row.name.padEnd(26)} would upload (add --confirmed)`);
      continue;
    }
    try {
      await ghSecretSet(row.name, env[row.name] as string);
      console.log(`${row.name.padEnd(26)} uploaded`);
    } catch (e) {
      failed = true;
      console.log(`${row.name.padEnd(26)} FAILED: ${(e as Error).message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
