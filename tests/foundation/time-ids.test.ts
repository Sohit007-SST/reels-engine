import { describe, expect, it } from 'vitest';
import { newRunId, reelId, RUN_ID_RE, sha256, shortHash } from '../../src/lib/ids';
import {
  addDays,
  formatIst,
  istDate,
  istTimeToUtcTime,
  istToUtc,
  isoWeekLabel,
  toIstParts,
  utcCronForIst,
} from '../../src/lib/time';

describe('time (IST <-> UTC)', () => {
  it('converts UTC to IST wall clock across midnight', () => {
    const d = new Date('2026-11-04T23:47:00Z');
    expect(toIstParts(d)).toMatchObject({ date: '2026-11-05', time: '05:17' });
    expect(formatIst(d)).toBe('2026-11-05 05:17 IST');
    expect(istDate(new Date('2026-11-05T18:29:59Z'))).toBe('2026-11-05');
    expect(istDate(new Date('2026-11-05T18:30:00Z'))).toBe('2026-11-06');
  });

  it('converts IST slot to UTC instant', () => {
    expect(istToUtc('2026-11-05', '08:30').toISOString()).toBe('2026-11-05T03:00:00.000Z');
    expect(istToUtc('2026-11-05', '05:17').toISOString()).toBe('2026-11-04T23:47:00.000Z');
    expect(() => istToUtc('2026-02-31', '08:30')).toThrow();
    expect(() => istToUtc('2026-11-05', '25:00')).toThrow();
  });

  it('produces the spec cron lines (section 8)', () => {
    expect(utcCronForIst('05:17')).toBe('47 23 * * *');
    expect(utcCronForIst('23:23')).toBe('53 17 * * *');
    expect(utcCronForIst('22:07')).toBe('37 16 * * *');
    expect(istTimeToUtcTime('05:17').dayShift).toBe(-1);
  });

  it('iso week label and addDays', () => {
    expect(isoWeekLabel(new Date('2026-11-05T06:00:00Z'))).toBe('2026-45');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('ids', () => {
  it('run ids are unique and well-formed', () => {
    const a = newRunId('produce', new Date('2026-11-04T23:47:00Z'));
    expect(a).toMatch(RUN_ID_RE);
    expect(a.startsWith('produce-20261105-051700-')).toBe(true);
    expect(newRunId('produce')).not.toBe(newRunId('produce'));
  });
  it('reel ids', () => {
    expect(reelId('2026-11-05', 1)).toBe('2026-11-05-01');
    expect(() => reelId('2026-11-05', 0)).toThrow();
    expect(() => reelId('bad', 1)).toThrow();
  });
  it('hashes', () => {
    expect(sha256('abc')).toHaveLength(64);
    expect(shortHash('abc')).toHaveLength(10);
  });
});
