/** Read a capability status from progress/CAPABILITIES.md (the register is the gate, not a flag). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../config';

export const CAPABILITY_STATUSES = [
  'UNVERIFIED',
  'DOCS_VERIFIED',
  'LIVE_VERIFIED',
  'ACCOUNT_BLOCKED',
  'UNSUPPORTED',
  'DEPRECATED',
] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export const CAPABILITIES_FILE = path.join(PROJECT_ROOT, 'progress', 'CAPABILITIES.md');

/** Status of capability `id` (e.g. "C07"); UNVERIFIED when the file or row is missing. */
export function capabilityStatus(id: string, file = CAPABILITIES_FILE): CapabilityStatus {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return 'UNVERIFIED';
  }
  for (const line of text.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells[1] !== id) continue;
    const found = cells.find((c) => (CAPABILITY_STATUSES as readonly string[]).includes(c));
    return (found as CapabilityStatus | undefined) ?? 'UNVERIFIED';
  }
  return 'UNVERIFIED';
}
