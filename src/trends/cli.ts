/**
 * `npm run trends [-- --date YYYY-MM-DD --geo IN --no-analyze --no-web --data-dir data]`
 * Collects every enabled source (isolated), lets trend-scout analyse the top items and writes
 * data/trends/<date>.json. Read-only: no external writes.
 */
import path from 'node:path';
import { loadBrand, loadConfig, loadWatchlist, PROJECT_ROOT } from '../config';
import { agentRecordPath } from '../claude/runAgent';
import { newRunId } from '../lib/ids';
import { runMain } from '../lib/cli';
import { createLogger } from '../lib/logger';
import { istDate } from '../lib/time';
import {
  businessDiscoverySource,
  googleTrendsSource,
  ownInsightsSource,
  runTrends,
  webSearchSource,
  youtubeSource,
} from './index';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

runMain('trends', async () => {
  const args = process.argv.slice(2);
  const cfg = loadConfig();
  const brand = await loadBrand();
  const watchlist = await loadWatchlist();
  const now = new Date();
  const date = flag(args, '--date') ?? istDate(now);
  const runId = newRunId('trends', now);
  const dataDir = path.resolve(PROJECT_ROOT, flag(args, '--data-dir') ?? 'data');
  const logger = createLogger({ runId, stage: 'trends' });
  const model = cfg.settings.claudeModel ?? undefined;

  const sources = [
    businessDiscoverySource({
      watchlist,
      igUserId: cfg.secrets.IG_USER_ID,
      accessToken: cfg.secrets.META_PAGE_ACCESS_TOKEN,
      graphVersion: cfg.settings.metaGraphVersion,
    }),
    ownInsightsSource({ reader: null, handle: brand.handle }),
    youtubeSource({ apiKey: cfg.secrets.YOUTUBE_API_KEY }),
    googleTrendsSource({ geo: flag(args, '--geo') ?? 'IN' }),
    webSearchSource({
      enabled: !args.includes('--no-web'),
      ...(model ? { model } : {}),
      recordPath: (ctx) => agentRecordPath(dataDir, ctx.date, ctx.runId, 'trend-scout', 'web'),
    }),
  ];

  const { file, path: out } = await runTrends({
    ctx: { runId, date, niche: brand.niche, now, logger },
    sources,
    dataDir,
    analyze: args.includes('--no-analyze')
      ? false
      : {
          ...(model ? { model } : {}),
          recordPath: agentRecordPath(dataDir, date, runId, 'trend-scout', 'analysis'),
        },
  });
  const summary = {
    file: path.relative(PROJECT_ROOT, out),
    trends: file.trends.length,
    analysed: file.trends.filter((t) => t.analysis !== null).length,
    sources: file.sources.map((s) => `${s.source}=${s.status}(${s.itemCount})`),
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  return 0;
});
