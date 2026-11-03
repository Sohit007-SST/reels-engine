import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OwnerInspiration, loadInspiration } from '../../src/config';

describe('owner inspiration file', () => {
  it('the committed brand/inspiration.json validates', async () => {
    const insp = await loadInspiration();
    expect(insp?.schemaVersion).toBe(1);
  });

  it('missing file means no inspiration (null), not an error', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'insp-'));
    expect(await loadInspiration(path.join(dir, 'nope.json'))).toBeNull();
  });

  it('rejects an invalid useFor and fills defaults', async () => {
    expect(() =>
      OwnerInspiration.parse({ schemaVersion: 1, inspiration: [{ whatILike: 'x', useFor: 'bad' }] }),
    ).toThrow();
    const ok = OwnerInspiration.parse({ schemaVersion: 1 });
    expect(ok).toEqual({ schemaVersion: 1, feedback: [], inspiration: [], topicIdeas: [], avoid: [] });
  });

  it('a broken file fails loudly instead of being silently ignored', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'insp-'));
    const f = path.join(dir, 'inspiration.json');
    await writeFile(f, '{"schemaVersion": 2}');
    await expect(loadInspiration(f)).rejects.toThrow();
  });
});
