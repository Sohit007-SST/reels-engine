/**
 * Remotion bundle management (Node side).
 *
 * The bundle is built once per process (webpack is the slow part) into out/render-bundles/<id>/.
 * Per-reel assets (voice/mix audio, Tier B images) are staged into the bundle's public/ folder
 * AFTER bundling, so one bundle can render many reels; the scenes load them with staticFile().
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { ensureBrowser } from '@remotion/renderer';
import { PROJECT_ROOT } from '../config';
import { createLogger } from '../lib/logger';

const log = createLogger({ stage: 'render', provider: 'remotion' });

export const REMOTION_ENTRY = path.join(PROJECT_ROOT, 'remotion', 'index.ts');
export const BUNDLES_DIR = path.join(PROJECT_ROOT, 'out', 'render-bundles');

let bundlePromise: Promise<string> | null = null;
let browserPromise: Promise<void> | null = null;

/**
 * Optional system browser override (e.g. a CI image with Chrome preinstalled).
 * Default: Remotion's own Chrome Headless Shell in node_modules/.remotion (downloaded once).
 */
export const browserExecutable = (): string | null => process.env.REMOTION_BROWSER_EXECUTABLE?.trim() || null;

/** Make sure a headless browser exists (one-time free download of Chrome Headless Shell). */
export function ensureRenderBrowser(): Promise<void> {
  browserPromise ??= ensureBrowser({ browserExecutable: browserExecutable(), logLevel: 'warn' })
    .then(() => undefined)
    .catch((err: unknown) => {
      browserPromise = null;
      throw err;
    });
  return browserPromise;
}

/** Bundle remotion/index.ts once per process; returns the serve directory. */
export function getBundle(opts: { force?: boolean } = {}): Promise<string> {
  if (opts.force) bundlePromise = null;
  bundlePromise ??= (async () => {
    const outDir = path.join(BUNDLES_DIR, `${Date.now()}-${process.pid}`);
    await fs.mkdir(BUNDLES_DIR, { recursive: true });
    return log.time(
      'bundle',
      () =>
        bundle({
          entryPoint: REMOTION_ENTRY,
          outDir,
          // No project-level public dir: assets are staged per reel into the bundle.
          publicDir: path.join(PROJECT_ROOT, 'remotion', 'public'),
          onProgress: () => undefined,
        }),
      { outDir: path.relative(PROJECT_ROOT, outDir) },
    );
  })().catch((err: unknown) => {
    bundlePromise = null;
    throw err;
  });
  return bundlePromise;
}

/** Folder inside the bundle that staticFile() resolves against. */
export const bundlePublicDir = (serveDir: string): string => path.join(serveDir, 'public');

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Copy a local file into the bundle's public dir under <namespace>/<name> and return the
 * staticFile() path to put in the composition props.
 */
export async function stageFile(
  serveDir: string,
  sourcePath: string,
  namespace: string,
  name: string,
): Promise<string> {
  if (!SAFE_SEGMENT.test(namespace) || !SAFE_SEGMENT.test(name)) {
    throw new Error(`unsafe staged asset name: ${namespace}/${name}`);
  }
  const rel = `${namespace}/${name}`;
  const dest = path.join(bundlePublicDir(serveDir), namespace, name);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(sourcePath, dest);
  return rel;
}

/** Remove old bundles (keeps the newest `keep`). Only touches out/render-bundles/. */
export async function pruneBundles(keep = 2): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(BUNDLES_DIR);
  } catch {
    return 0;
  }
  const sorted = entries
    .filter((e) => /^\d+-\d+$/.test(e))
    .sort((a, b) => Number(b.split('-')[0]) - Number(a.split('-')[0]));
  const victims = sorted.slice(keep);
  for (const v of victims) await fs.rm(path.join(BUNDLES_DIR, v), { recursive: true, force: true });
  return victims.length;
}
