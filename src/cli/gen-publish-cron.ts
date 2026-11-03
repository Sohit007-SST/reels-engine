/**
 * Generates the `schedule:` crons of .github/workflows/publish.yml from the slots in brand/brand.json.
 *
 *   tsx src/cli/gen-publish-cron.ts            # rewrite the generated block in publish.yml
 *   tsx src/cli/gen-publish-cron.ts --check    # exit 1 if publish.yml is out of date (CI)
 *   tsx src/cli/gen-publish-cron.ts --reels-per-day 3   # only that cadence's slots
 *
 * Rules (spec 8): IST slot -> UTC cron; runs land on ODD minutes (an even UTC minute moves one
 * minute LATER, so a run never starts before its slot). By default the union of every slot list
 * in brand.json is scheduled, so changing REELS_PER_DAY needs no workflow edit; the publish run
 * processes "everything due" and is a cheap no-op when nothing is due.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT, loadBrand } from '../config';
import { writeFileAtomic } from '../lib/store';
import { istTimeToUtcTime } from '../lib/time';
import type { Brand } from '../schemas';
import { isMainModule, parseArgs } from './ops-shared';

export const PUBLISH_WORKFLOW = path.join(PROJECT_ROOT, '.github', 'workflows', 'publish.yml');
export const BEGIN_MARKER = '# BEGIN GENERATED SLOTS';
export const END_MARKER = '# END GENERATED SLOTS';

export interface SlotCron {
  ist: string;
  utc: string;
  cron: string;
}

/** IST "HH:MM" -> odd-minute UTC cron at or just after the slot. */
export function slotToCron(ist: string): SlotCron {
  const { time } = istTimeToUtcTime(ist);
  let [h, m] = time.split(':').map(Number) as [number, number];
  if (m % 2 === 0) {
    m += 1;
    if (m === 60) {
      m = 0;
      h = (h + 1) % 24;
    }
  }
  const utc = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  return { ist, utc, cron: `${m} ${h} * * *` };
}

export function slotsToSchedule(brand: Brand, reelsPerDay?: number): SlotCron[] {
  let slots: string[];
  if (reelsPerDay !== undefined) {
    const exact = brand.slots[String(reelsPerDay)];
    if (!exact) throw new Error(`brand.json has no slot list for ${reelsPerDay} reels per day`);
    slots = exact;
  } else {
    slots = Object.values(brand.slots).flat();
  }
  const unique = [...new Set(slots)].sort();
  const seen = new Set<string>();
  const out: SlotCron[] = [];
  for (const s of unique) {
    const c = slotToCron(s);
    if (seen.has(c.cron)) continue;
    seen.add(c.cron);
    out.push(c);
  }
  return out;
}

export function renderScheduleBlock(crons: SlotCron[], indent = '    '): string {
  return [
    `${indent}${BEGIN_MARKER} (from brand/brand.json slots; regenerate: npx tsx src/cli/gen-publish-cron.ts)`,
    ...crons.map((c) => `${indent}- cron: '${c.cron}' # ${c.ist} IST slot (${c.utc} UTC)`),
    `${indent}${END_MARKER}`,
  ].join('\n');
}

/** Replace the marker block (inclusive) in workflow text; throws if markers are missing. */
export function replaceScheduleBlock(yamlText: string, crons: SlotCron[]): string {
  const lines = yamlText.split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith(BEGIN_MARKER));
  const end = lines.findIndex((l, i) => i > start && l.trim().startsWith(END_MARKER));
  if (start < 0 || end < 0) throw new Error('publish.yml is missing the GENERATED SLOTS markers');
  const indent = /^(\s*)/.exec(lines[start] ?? '')?.[1] ?? '    ';
  const block = renderScheduleBlock(crons, indent).split('\n');
  return [...lines.slice(0, start), ...block, ...lines.slice(end + 1)].join('\n');
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { flags, values } = parseArgs(argv);
  const rpd = values.get('reels-per-day');
  const file = values.get('file') ?? PUBLISH_WORKFLOW;
  const brand = await loadBrand();
  const crons = slotsToSchedule(brand, rpd !== undefined ? Number(rpd) : undefined);
  const current = await readFile(file, 'utf8');
  const next = replaceScheduleBlock(current, crons);
  if (flags.has('check')) {
    if (next !== current) {
      process.stderr.write(
        'publish.yml schedule is out of date with brand/brand.json slots. Run: npx tsx src/cli/gen-publish-cron.ts\n',
      );
      return 1;
    }
    process.stdout.write(`publish.yml schedule matches brand.json (${crons.length} slots).\n`);
    return 0;
  }
  if (next !== current) await writeFileAtomic(file, next);
  process.stdout.write(`publish.yml schedule: ${crons.map((c) => `${c.ist} IST -> ${c.cron}`).join('; ')}\n`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`gen-publish-cron failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
