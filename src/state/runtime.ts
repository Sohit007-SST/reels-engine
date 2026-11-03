/**
 * Builds the runtime shared by the publish-side pipelines (publish, engage, analyze, learn,
 * report) from the validated config. Missing keys never crash a dry run: the matching client
 * is null and the pipeline reports what it skipped.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Config } from '../config';
import { createInstagramClient, type InstagramClient } from '../instagram/client';
import { newRunId, type RunIdKind } from '../lib/ids';
import { createLogger, type Logger } from '../lib/logger';
import { createTelegramClient, type TelegramClient } from '../telegram/index';
import { defaultArtifactStore, type ArtifactStore } from './artifacts';
import { dataPaths, type DataPaths } from './paths';

/** Graph API version used when META_GRAPH_VERSION is unset (latest per the changelog, read 2026-11-03). */
export const DEFAULT_GRAPH_VERSION = 'v26.0';

export interface Runtime {
  runId: string;
  paths: DataPaths;
  instagram: InstagramClient | null;
  telegram: TelegramClient | null;
  ownerChatId: string | null;
  artifacts: ArtifactStore;
  logger: Logger;
  skipped: string[];
}

export function buildRuntime(cfg: Config, kind: RunIdKind, paths: DataPaths = dataPaths()): Runtime {
  const runId = newRunId(kind);
  const logger = createLogger({ runId, stage: kind });
  const skipped: string[] = [];
  const s = cfg.secrets;
  let instagram: InstagramClient | null = null;
  if (s.META_PAGE_ACCESS_TOKEN && s.IG_USER_ID) {
    instagram = createInstagramClient({
      graphVersion: cfg.settings.metaGraphVersion ?? DEFAULT_GRAPH_VERSION,
      igUserId: s.IG_USER_ID,
      pageAccessToken: s.META_PAGE_ACCESS_TOKEN,
    });
  } else {
    skipped.push('Instagram: META_PAGE_ACCESS_TOKEN or IG_USER_ID is MISSING (owner step M6)');
  }
  let telegram: TelegramClient | null = null;
  if (s.TELEGRAM_BOT_TOKEN && s.TELEGRAM_CHAT_ID) {
    telegram = createTelegramClient({
      botToken: s.TELEGRAM_BOT_TOKEN,
      ownerChatId: s.TELEGRAM_CHAT_ID,
      dryRun: cfg.settings.publishMode === 'dry_run',
      previewDir: `${paths.outDir}/previews`,
    });
  } else {
    skipped.push('Telegram: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is MISSING (owner step M8)');
  }
  return {
    runId,
    paths,
    instagram,
    telegram,
    ownerChatId: s.TELEGRAM_CHAT_ID ?? null,
    artifacts: defaultArtifactStore(paths.outDir),
    logger,
    skipped,
  };
}

/** True when this module is the process entry point (so importing it in tests runs nothing). */
export function isEntryPoint(metaUrl: string): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return metaUrl === pathToFileURL(path.resolve(arg)).href;
  } catch {
    return false;
  }
}
