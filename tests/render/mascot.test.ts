import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportMascotSvgs } from '../../src/render/mascotExport';

describe('mascot export', () => {
  it('writes 4 distinct original SVG expressions', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mascot-'));
    const files = await exportMascotSvgs(dir);
    expect(files).toHaveLength(4);
    const bodies = await Promise.all(files.map((f) => fs.readFile(f, 'utf8')));
    for (const b of bodies) expect(b).toMatch(/^<svg[^>]*xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(new Set(bodies).size).toBe(4);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
