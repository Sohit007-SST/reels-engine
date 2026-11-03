import { z } from 'zod';
import { IsoDate, IsoDateTime, SchemaV1, Sha256 } from './common';

export const AssetKind = z.enum(['image', 'clip', 'voice', 'music', 'sfx', 'font', 'svg', 'other']);

/**
 * Provenance for every generated or supplied asset (spec 7.5). An asset whose
 * commercial-use status is unknown is BLOCKED (see isAssetUsable).
 */
export const AssetProvenance = z.object({
  schemaVersion: SchemaV1,
  assetId: z.string().min(1),
  kind: AssetKind,
  path: z.string().min(1),
  sha256: Sha256,
  provider: z.string().min(1),
  model: z.string().nullable(),
  modelVersion: z.string().nullable(),
  license: z.string().min(1),
  commercialUse: z.enum(['allowed', 'unknown', 'disallowed']),
  termsCheckedAt: IsoDate.nullable(),
  prompt: z.string().nullable(),
  promptHash: z.string().nullable(),
  createdAt: IsoDateTime,
  reelId: z.string().nullable(),
});
export type AssetProvenance = z.infer<typeof AssetProvenance>;

export function isAssetUsable(p: AssetProvenance): boolean {
  return p.commercialUse === 'allowed' && p.termsCheckedAt !== null;
}
