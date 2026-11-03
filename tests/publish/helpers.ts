/** MOCKED Instagram / Telegram fakes and a temp data dir for publish-side tests. No network. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { InstagramClient, ContainerStatusCode } from '../../src/instagram/client';
import { sha256 } from '../../src/lib/ids';
import type { Approval } from '../../src/schemas/approval';
import type { QueueItem } from '../../src/schemas/queue';
import { dataPaths, type DataPaths } from '../../src/state/paths';
import { enqueueRendered, transitionItem } from '../../src/state/queue';
import type { ArtifactStore } from '../../src/state/artifacts';
import type { TelegramClient, TelegramUpdate } from '../../src/telegram/index';

export const NOW = new Date('2026-11-03T08:00:00.000Z');
export const CAPTION = 'Octopuses have three hearts. Which fact surprised you?';

export async function tmpEnv(): Promise<{ paths: DataPaths; video: string; sha: string; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reels-pub-'));
  const paths = dataPaths(path.join(root, 'data'), {
    outDir: path.join(root, 'out'),
    reportsDir: path.join(root, 'reports'),
  });
  const video = path.join(root, 'reel.mp4');
  const bytes = 'fake-mp4-bytes';
  await fs.writeFile(video, bytes);
  return { paths, video, sha: sha256(bytes), root };
}

export function store(video: string | null): ArtifactStore {
  return { kind: 'local', fetch: async () => video };
}

/** Enqueue a rendered reel and walk it to `to` (auto mode transitions). */
export async function seedItem(
  env: { paths: DataPaths; video: string; sha: string },
  reelId = '2026-11-03-01',
  to: 'QA_PASSED' | 'APPROVED' = 'APPROVED',
  scheduledAt = new Date(NOW.getTime() - 60_000).toISOString(),
): Promise<QueueItem> {
  await enqueueRendered(env.paths, {
    reelId,
    placement: 'main',
    slot: { date: '2026-11-03', time: '13:00' },
    scheduledAt,
    artifact: {
      name: `reel-${reelId}`,
      sha256: env.sha,
      sizeBytes: 14,
      localPath: env.video,
      retainedUntil: new Date(NOW.getTime() + 7 * 86_400_000).toISOString(),
    },
    captionVersion: 1,
    now: NOW,
  });
  let item = await transitionItem(env.paths, reelId, 'QA_PASSED', { publishMode: 'auto', now: NOW });
  if (to === 'APPROVED')
    item = await transitionItem(env.paths, reelId, 'APPROVED', { publishMode: 'auto', now: NOW });
  return item;
}

export interface RemoteContainer {
  status: ContainerStatusCode;
  uploaded: boolean;
  mediaId: string | null;
  caption: string;
}

/** Shared "Instagram" state that survives across simulated process crashes. */
export interface Remote {
  containers: Map<string, RemoteContainer>;
  media: Array<{ id: string; timestamp: string; permalink: string | null; caption: string | null }>;
  calls: string[];
  publishCount: number;
  quotaUsage: number;
  nextId: number;
}

export function newRemote(): Remote {
  return { containers: new Map(), media: [], calls: [], publishCount: 0, quotaUsage: 0, nextId: 1 };
}

export class CrashError extends Error {}

/** crashAt: "<method>:before" (no remote effect) or "<method>:after" (effect happened, response lost). */
export function fakeInstagram(
  remote: Remote,
  crashAt: string | null = null,
  now: () => Date = () => NOW,
): InstagramClient {
  const maybe = (point: string): void => {
    if (crashAt === point) throw new CrashError(`simulated crash at ${point}`);
  };
  const c = (id: string): RemoteContainer => {
    const x = remote.containers.get(id);
    if (!x) throw new Error(`no container ${id}`);
    return x;
  };
  const unused = async (): Promise<never> => {
    throw new Error('not used in tests');
  };
  return {
    async createReelContainer(input) {
      remote.calls.push('createReelContainer');
      maybe('createReelContainer:before');
      const id = `c${remote.nextId++}`;
      remote.containers.set(id, {
        status: 'IN_PROGRESS',
        uploaded: false,
        mediaId: null,
        caption: input.caption,
      });
      maybe('createReelContainer:after');
      return { containerId: id, uploadUri: null };
    },
    async uploadResumable(id) {
      remote.calls.push('uploadResumable');
      maybe('uploadResumable:before');
      c(id).uploaded = true;
      maybe('uploadResumable:after');
    },
    async getContainerStatus(id) {
      remote.calls.push('getContainerStatus');
      const x = c(id);
      const statusCode: ContainerStatusCode = x.mediaId
        ? 'PUBLISHED'
        : x.status === 'IN_PROGRESS' && x.uploaded
          ? 'FINISHED'
          : x.status;
      return { statusCode, status: null };
    },
    async publishContainer(id) {
      remote.calls.push('publishContainer');
      maybe('publishContainer:before');
      const x = c(id);
      if (x.mediaId) throw new Error('container already published');
      remote.publishCount++;
      remote.quotaUsage++;
      x.mediaId = `m${remote.nextId++}`;
      remote.media.unshift({
        id: x.mediaId,
        timestamp: now().toISOString(),
        permalink: `https://ig.example/p/${x.mediaId}`,
        caption: x.caption,
      });
      maybe('publishContainer:after');
      return { mediaId: x.mediaId };
    },
    async getMediaPermalink(mediaId) {
      return `https://ig.example/p/${mediaId}`;
    },
    async getPublishingLimit() {
      remote.calls.push('getPublishingLimit');
      return { quotaUsage: remote.quotaUsage, quotaTotal: 50 };
    },
    async getRecentMedia(limit) {
      remote.calls.push('getRecentMedia');
      return remote.media.slice(0, limit);
    },
    getReelInsights: unused,
    getComments: unused,
    replyToComment: unused,
    businessDiscovery: unused,
    getAccountInfo: unused,
  };
}

export interface FakeTelegram extends TelegramClient {
  sent: string[];
  previews: Array<{ reelId: string; approval: Approval | null }>;
  updates: TelegramUpdate[];
  answers: string[];
}

export function fakeTelegram(): FakeTelegram {
  const t: FakeTelegram = {
    sent: [],
    previews: [],
    updates: [],
    answers: [],
    async notify(text) {
      t.sent.push(text);
    },
    async sendPreview(input) {
      t.previews.push({ reelId: input.reelId, approval: input.approval });
      return { messageId: 100 + t.previews.length };
    },
    async getUpdates(offset) {
      const u = t.updates.filter((x) => offset === undefined || x.updateId >= offset);
      return u;
    },
    async answerCallback(_id, text) {
      t.answers.push(text);
    },
  };
  return t;
}
