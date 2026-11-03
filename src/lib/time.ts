/**
 * Time helpers. India Standard Time is a fixed UTC+05:30 (no daylight saving),
 * so conversions are pure arithmetic and do not depend on the host timezone.
 */

export const IST_OFFSET_MINUTES = 330;
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60_000;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export interface IstParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

/** Wall-clock parts of `d` in IST. */
export function toIstParts(d: Date = new Date()): IstParts {
  const shifted = new Date(d.getTime() + IST_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  return {
    date: `${year}-${pad(month)}-${pad(day)}`,
    time: `${pad(hour)}:${pad(minute)}`,
    year,
    month,
    day,
    hour,
    minute,
    second: shifted.getUTCSeconds(),
    weekday: shifted.getUTCDay(),
  };
}

/** "YYYY-MM-DD" for `d` in IST. */
export function istDate(d: Date = new Date()): string {
  return toIstParts(d).date;
}

/** "YYYY-MM-DD HH:MM IST" (for progress files and reports). */
export function formatIst(d: Date = new Date()): string {
  const p = toIstParts(d);
  return `${p.date} ${p.time} IST`;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Convert an IST wall-clock date + "HH:MM" to the exact UTC instant. */
export function istToUtc(date: string, time: string): Date {
  const dm = DATE_RE.exec(date);
  const tm = TIME_RE.exec(time);
  if (!dm || !tm) throw new Error(`invalid IST date/time: ${date} ${time}`);
  const utcMs =
    Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2])) - IST_OFFSET_MS;
  const out = new Date(utcMs);
  // Reject impossible dates like 2026-02-31 (Date.UTC would roll them over).
  if (istDate(out) !== date) throw new Error(`invalid calendar date: ${date}`);
  return out;
}

/** UTC "HH:MM" for an IST "HH:MM" (day may shift; see utcCronForIst). */
export function istTimeToUtcTime(time: string): { time: string; dayShift: -1 | 0 } {
  const tm = TIME_RE.exec(time);
  if (!tm) throw new Error(`invalid time: ${time}`);
  let mins = Number(tm[1]) * 60 + Number(tm[2]) - IST_OFFSET_MINUTES;
  let dayShift: -1 | 0 = 0;
  if (mins < 0) {
    mins += 1440;
    dayShift = -1;
  }
  return { time: `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`, dayShift };
}

/** GitHub Actions cron (UTC) for a daily IST time, e.g. "05:17" -> "47 23 * * *". */
export function utcCronForIst(time: string): string {
  const { time: utc } = istTimeToUtcTime(time);
  const [h, m] = utc.split(':').map(Number);
  return `${m} ${h} * * *`;
}

/** ISO-8601 week label "YYYY-WW" for the IST date of `d` (used by week-YYYY-WW.md). */
export function isoWeekLabel(d: Date = new Date()): string {
  const p = toIstParts(d);
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-${pad(week)}`;
}

/** Add whole days to a YYYY-MM-DD string. */
export function addDays(date: string, days: number): string {
  const dm = DATE_RE.exec(date);
  if (!dm) throw new Error(`invalid date: ${date}`);
  const d = new Date(Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]) + days));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function hoursBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 3_600_000;
}

/** Injectable clock for deterministic tests. */
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();
