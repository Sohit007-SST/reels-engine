import { mkdtempSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  fileExists,
  readJson,
  readJsonOrNull,
  StoreError,
  updateJsonAtomic,
  withFileLock,
  writeJsonAtomic,
} from '../../src/lib/store';

const S = z.object({ schemaVersion: z.literal(1), n: z.number() });
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'store-'));

describe('atomic store', () => {
  it('writes and reads validated JSON, creating directories', async () => {
    const f = path.join(tmp(), 'a', 'b', 'x.json');
    await writeJsonAtomic(f, { schemaVersion: 1, n: 5 }, S);
    expect(await readJson(f, S)).toEqual({ schemaVersion: 1, n: 5 });
    expect((await fs.readFile(f, 'utf8')).endsWith('\n')).toBe(true);
  });

  it('refuses to write invalid data and leaves the old file intact', async () => {
    const f = path.join(tmp(), 'x.json');
    await writeJsonAtomic(f, { schemaVersion: 1, n: 1 }, S);
    await expect(writeJsonAtomic(f, { schemaVersion: 2, n: 'x' }, S)).rejects.toThrow(StoreError);
    expect(await readJson(f, S)).toEqual({ schemaVersion: 1, n: 1 });
  });

  it('leaves no temp files behind', async () => {
    const d = tmp();
    const f = path.join(d, 'x.json');
    for (let i = 0; i < 5; i++) await writeJsonAtomic(f, { schemaVersion: 1, n: i }, S);
    expect(await fs.readdir(d)).toEqual(['x.json']);
  });

  it('a failed rename (simulated crash) keeps the previous content and cleans up', async () => {
    const d = tmp();
    const f = path.join(d, 'x.json');
    await writeJsonAtomic(f, { schemaVersion: 1, n: 1 }, S);
    const target = path.join(d, 'dir-target');
    await fs.mkdir(path.join(target, 'occupied'), { recursive: true }); // rename onto non-empty dir fails
    await expect(writeJsonAtomic(target, { schemaVersion: 1, n: 2 }, S)).rejects.toThrow(StoreError);
    expect(await readJson(f, S)).toEqual({ schemaVersion: 1, n: 1 });
    expect((await fs.readdir(d)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('readers never see a partial file during many concurrent writes', async () => {
    const f = path.join(tmp(), 'x.json');
    const big = (n: number) => ({ schemaVersion: 1 as const, n, pad: 'y'.repeat(200_000) });
    const B = S.extend({ pad: z.string() });
    await writeJsonAtomic(f, big(0), B);
    const writes = Array.from({ length: 20 }, (_, i) => writeJsonAtomic(f, big(i + 1), B));
    const reads = Array.from({ length: 40 }, () => readJson(f, B));
    const results = await Promise.all([...writes, ...reads]);
    for (const r of results.slice(20)) expect((r as { pad: string }).pad.length).toBe(200_000);
  });

  it('readJsonOrNull returns null for missing files and validates otherwise', async () => {
    const d = tmp();
    expect(await readJsonOrNull(path.join(d, 'nope.json'), S)).toBeNull();
    await fs.writeFile(path.join(d, 'bad.json'), '{"schemaVersion":1,');
    await expect(readJson(path.join(d, 'bad.json'), S)).rejects.toThrow(/invalid JSON/);
    expect(await fileExists(path.join(d, 'bad.json'))).toBe(true);
  });

  it('updateJsonAtomic serializes concurrent read-modify-write', async () => {
    const f = path.join(tmp(), 'counter.json');
    await Promise.all(
      Array.from({ length: 15 }, () =>
        updateJsonAtomic(f, S, (cur) => ({ schemaVersion: 1 as const, n: (cur?.n ?? 0) + 1 }), {
          timeoutMs: 20_000,
          pollMs: 5,
        }),
      ),
    );
    expect((await readJson(f, S)).n).toBe(15);
  });

  it('withFileLock times out instead of waiting forever', async () => {
    const f = path.join(tmp(), 'l.json');
    await withFileLock(f, async () => {
      await expect(withFileLock(f, async () => 1, { timeoutMs: 100, pollMs: 10 })).rejects.toThrow(
        /lock timeout/,
      );
    });
  });
});
