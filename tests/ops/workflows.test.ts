import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadBrand, PROJECT_ROOT } from '../../src/config';
import { replaceScheduleBlock, slotToCron, slotsToSchedule } from '../../src/cli/gen-publish-cron';

const WF = path.join(PROJECT_ROOT, '.github', 'workflows');
const read = (f: string) => readFileSync(path.join(WF, f), 'utf8');
type Wf = {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, { 'timeout-minutes'?: number; permissions?: Record<string, string> }>;
};
const files = readdirSync(WF).filter((f) => f.endsWith('.yml'));

describe('workflow files', () => {
  it('all required workflows exist and parse', () => {
    for (const f of ['ci.yml', 'ci-spike.yml', 'produce.yml', 'publish.yml', 'analyze.yml', 'learn.yml']) {
      expect(files).toContain(f);
    }
    for (const f of files) expect(() => parse(read(f)) as Wf).not.toThrow();
  });

  it.each(files)(
    '%s: dispatch, concurrency (no cancel), timeouts, minimal permissions, no inline secrets',
    (f) => {
      const text = read(f);
      const wf = parse(text) as Wf;
      expect(wf.concurrency?.['cancel-in-progress']).toBe(false);
      for (const job of Object.values(wf.jobs)) expect(job['timeout-minutes']).toBeGreaterThan(0);
      expect(wf.permissions).toBeTruthy();
      if (f.startsWith('ci')) expect(wf.permissions?.contents).toBe('read');
      if (f !== 'ci.yml') expect('workflow_dispatch' in wf.on).toBe(true);
      expect(text).not.toMatch(/EAA[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}/);
      expect(text).not.toMatch(/git push (-f|--force)/);
    },
  );

  it('scheduled pipelines honour the kill switch and use the spec crons', () => {
    const crons: Record<string, string> = {
      'produce.yml': '47 23 * * *',
      'analyze.yml': '53 17 * * *',
      'learn.yml': '37 16 * * 0',
    };
    for (const [f, cron] of Object.entries(crons)) {
      expect(read(f)).toContain(`cron: '${cron}'`);
    }
    for (const f of ['produce.yml', 'publish.yml', 'analyze.yml', 'learn.yml']) {
      expect(read(f)).toContain('kill-switch.sh');
      expect(read(f)).toContain('commit-state.sh');
    }
  });

  it('publish and analyze do not install Remotion or Python', () => {
    for (const f of ['publish.yml', 'analyze.yml']) {
      const t = read(f);
      expect(t).not.toMatch(/setup-python|remotion: 'true'|pip install/);
    }
  });
});

describe('gen-publish-cron', () => {
  it('converts IST slots to odd-minute UTC crons', () => {
    expect(slotToCron('08:30').cron).toBe('1 3 * * *');
    expect(slotToCron('13:00').cron).toBe('31 7 * * *');
    for (const s of ['00:00', '05:30', '23:59', '12:15']) {
      expect(Number(slotToCron(s).cron.split(' ')[0]) % 2).toBe(1);
    }
  });
  it('publish.yml schedule is in sync with brand.json (no drift)', async () => {
    const text = read('publish.yml');
    const brand = await loadBrand();
    expect(replaceScheduleBlock(text, slotsToSchedule(brand))).toBe(text);
    const wf = parse(text) as { on: { schedule: Array<{ cron: string }> } };
    expect(wf.on.schedule.length).toBe(slotsToSchedule(brand).length);
  });
});
