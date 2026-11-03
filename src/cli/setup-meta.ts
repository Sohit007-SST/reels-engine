/**
 * `npm run setup:meta` (T1.6, manual step M6).
 *
 * 1. Asks for the short-lived User token from Graph API Explorer (typed/pasted with echo OFF).
 * 2. Exchanges it for a long-lived User token (GET /oauth/access_token, grant_type=fb_exchange_token).
 * 3. Lists the Pages that user manages (GET /me/accounts) -> long-lived Page token + Page ID +
 *    linked Instagram professional account ID (instagram_business_account).
 * 4. Writes META_PAGE_ACCESS_TOKEN, FB_PAGE_ID, IG_USER_ID into api_keys/.env (mode 600).
 *
 * Read-only: only GET requests to graph.facebook.com. Nothing is posted or changed on Meta.
 * No token or ID is ever printed; Page names and the IG username are shown so you can confirm.
 * Docs (checked 2026-11-03): https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived/
 */
import path from 'node:path';
import { DEFAULT_ENV_FILE, PROJECT_ROOT, loadConfig, requireSecret, type Config } from '../config';
import { getJson } from '../lib/http';
import { redact, registerSecret } from '../lib/redact';
import { isMainModule, parseArgs, promptTerminal, upsertEnvValues, type PromptFn } from './ops-shared';

const TIMEOUT_MS = 15_000;
const RETRY = { maxAttempts: 3, deadlineMs: 45_000 } as const;

export class SetupError extends Error {
  constructor(message: string) {
    super(redact(message));
    this.name = 'SetupError';
  }
}

interface PageEntry {
  id?: string;
  name?: string;
  access_token?: string;
  instagram_business_account?: { id?: string };
}

export interface SetupMetaDeps {
  cfg: Config;
  prompt: PromptFn;
  out: (line: string) => void;
  envFile: string;
  templateFile: string;
  graphVersion?: string;
}

export interface SetupMetaResult {
  pageName: string;
  igUsername: string | null;
  keysWritten: string[];
  pageTokenExpires: 'never' | 'unknown' | string;
}

export async function setupMeta(deps: SetupMetaDeps): Promise<SetupMetaResult> {
  const { cfg, out } = deps;
  const ver = deps.graphVersion ?? cfg.settings.metaGraphVersion;
  if (!ver || !/^v\d+\.\d+$/.test(ver)) {
    throw new SetupError(
      "META_GRAPH_VERSION is not set. Put the current version from Meta's changelog (like v23.0) in api_keys/.env, or pass --graph-version vNN.N.",
    );
  }
  const appId = requireSecret(cfg, 'META_APP_ID');
  const appSecret = requireSecret(cfg, 'META_APP_SECRET');
  const base = `https://graph.facebook.com/${ver}`;
  const opts = { provider: 'meta', timeoutMs: TIMEOUT_MS, retry: RETRY };

  out('Paste the short-lived token from Graph API Explorer (M6 step 5). Nothing will show while you paste.');
  const shortToken = (await deps.prompt('Token: ', { hidden: true })).trim();
  registerSecret(shortToken);
  if (shortToken.length < 20 || /\s/.test(shortToken)) {
    throw new SetupError('That does not look like an access token. Copy it again from the Access Token box.');
  }

  // 2) short-lived user token -> long-lived user token (read-only GET)
  const exchangeUrl =
    `${base}/oauth/access_token?grant_type=fb_exchange_token` +
    `&client_id=${encodeURIComponent(appId)}` +
    `&client_secret=${encodeURIComponent(appSecret)}` +
    `&fb_exchange_token=${encodeURIComponent(shortToken)}`;
  let longUser: string;
  try {
    const ex = await getJson<{ access_token?: string; expires_in?: number }>(exchangeUrl, {
      ...opts,
      purpose: 'exchange_token',
    });
    if (!ex.access_token) throw new SetupError('Meta did not return a long-lived token.');
    longUser = ex.access_token;
    registerSecret(longUser);
  } catch (err) {
    throw new SetupError(
      `Token exchange failed (${(err as Error).message}). The token may have expired (they last ~1-2 hours) or the app ID/secret is wrong: redo M6 steps 1-5.`,
    );
  }
  out('Step 1/3 done: long-lived user token received.');

  // 3) pages the user manages -> page token + ids
  const pagesRes = await getJson<{ data?: PageEntry[] }>(
    `${base}/me/accounts?fields=id,name,access_token,instagram_business_account`,
    { ...opts, headers: { authorization: `Bearer ${longUser}` }, purpose: 'me_accounts' },
  );
  const pages = (pagesRes.data ?? []).filter((p) => p.id && p.access_token);
  for (const p of pages) registerSecret(p.access_token);
  const withIg = pages.filter((p) => p.instagram_business_account?.id);
  if (pages.length === 0) {
    throw new SetupError(
      'No Facebook Pages found for this login. Make sure you selected your Page when generating the token (M6 step 4) and that pages_show_list was added.',
    );
  }
  if (withIg.length === 0) {
    throw new SetupError(
      'Your Page(s) have no linked Instagram professional account. Do M4 (link the Page to Instagram), then redo M6.',
    );
  }
  let chosen = withIg[0] as PageEntry;
  if (withIg.length > 1) {
    out('Several Pages have a linked Instagram account:');
    withIg.forEach((p, i) => out(`  ${i + 1}. ${p.name ?? '(unnamed page)'}`));
    const ans = await deps.prompt(`Which one? (1-${withIg.length}): `);
    const idx = Number(ans) - 1;
    const pick = withIg[idx];
    if (!Number.isInteger(idx) || !pick) throw new SetupError('Invalid choice; run setup:meta again.');
    chosen = pick;
  }
  const pageToken = chosen.access_token as string;
  const pageId = chosen.id as string;
  const igId = chosen.instagram_business_account?.id as string;
  registerSecret(pageId);
  registerSecret(igId);
  out(`Step 2/3 done: Page "${chosen.name ?? '(unnamed)'}" selected.`);

  // confirm the IG account (read-only) and the page token's expiry
  let igUsername: string | null;
  try {
    const ig = await getJson<{ username?: string }>(`${base}/${encodeURIComponent(igId)}?fields=username`, {
      ...opts,
      headers: { authorization: `Bearer ${pageToken}` },
      purpose: 'ig_username',
    });
    igUsername = ig.username ?? null;
  } catch {
    igUsername = null;
  }
  let pageTokenExpires: SetupMetaResult['pageTokenExpires'] = 'unknown';
  try {
    const dbg = await getJson<{ data?: { expires_at?: number } }>(
      `${base}/debug_token?input_token=${encodeURIComponent(pageToken)}&access_token=${encodeURIComponent(`${appId}|${appSecret}`)}`,
      { ...opts, purpose: 'debug_token' },
    );
    const e = dbg.data?.expires_at;
    if (e === 0) pageTokenExpires = 'never';
    else if (typeof e === 'number') pageTokenExpires = new Date(e * 1000).toISOString();
  } catch {
    /* expiry stays unknown */
  }

  const keysWritten = await upsertEnvValues(
    deps.envFile,
    { META_PAGE_ACCESS_TOKEN: pageToken, FB_PAGE_ID: pageId, IG_USER_ID: igId },
    { templateFile: deps.templateFile },
  );
  out(
    `Step 3/3 done: saved ${keysWritten.join(', ')} to ${path.relative(PROJECT_ROOT, deps.envFile)} (values not shown).`,
  );
  out(
    `Instagram account: ${igUsername ? `@${igUsername}` : '(username not readable yet)'}. Page token expiry: ${pageTokenExpires}.`,
  );
  out('Next: run `npm run doctor -- --live` (M6 step 7).');
  return { pageName: chosen.name ?? '', igUsername, keysWritten, pageTokenExpires };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs(argv);
  const cfg = loadConfig();
  const envFile = cfg.envFile ?? DEFAULT_ENV_FILE;
  const gv = values.get('graph-version');
  await setupMeta({
    cfg,
    prompt: promptTerminal,
    out: (l) => process.stdout.write(`${redact(l)}\n`),
    envFile,
    templateFile: path.join(PROJECT_ROOT, 'api_keys', '.env.example'),
    ...(gv ? { graphVersion: gv } : {}),
  });
  return 0;
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(
        `setup:meta failed: ${redact(err instanceof Error ? err.message : String(err))}\n`,
      );
      process.exitCode = 1;
    },
  );
}
