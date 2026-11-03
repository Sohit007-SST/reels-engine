import { z } from 'zod';
import { IsoDateTime, Score10, SchemaV1, wordCount } from './common';

export const HookScores = z.strictObject({
  scrollStop: Score10,
  brevity: Score10,
  curiosity: Score10,
  specificity: Score10,
  truthfulness: Score10,
  visualMatch: Score10,
});
export type HookScores = z.infer<typeof HookScores>;

/** One hook candidate written by hook-master (rubric in spec 7.2). */
export const Hook = z.strictObject({
  formulaId: z.string().min(1),
  spoken: z.string().min(1),
  onScreen: z
    .string()
    .min(1)
    .refine((s) => wordCount(s) <= 7, 'on-screen hook must be 7 words or fewer'),
  scores: HookScores,
  total: z.number().min(0).max(10),
  rationale: z.string().optional(),
});
export type Hook = z.infer<typeof Hook>;

export const IdeaScores = z.strictObject({
  trendVelocity: Score10,
  nicheFit: Score10,
  originality: Score10,
  feasibility: Score10,
  pastPerformance: Score10,
  /** Bonus from comment requests (data/requests.json), 0..3. */
  requestBonus: z.number().min(0).max(3).default(0),
});
export type IdeaScores = z.infer<typeof IdeaScores>;

export const IdeaStatus = z.enum(['new', 'chosen', 'backlog', 'used', 'dropped']);

/** data/ideas/DATE/<id>.json and data/backlog/<id>.json */
export const Idea = z.object({
  schemaVersion: SchemaV1,
  id: z.string().min(1),
  createdAt: IsoDateTime,
  title: z.string().min(1),
  premise: z.string().min(1),
  format: z.string().min(1),
  tags: z.array(z.string()),
  /** Trend ids this idea learned patterns from. */
  trendRefs: z.array(z.string()),
  scores: IdeaScores,
  totalScore: z.number().min(0),
  /** 10 scored hooks once hook-master has run; empty before. */
  hooks: z.array(Hook).max(20),
  primaryHookIndex: z.number().int().nonnegative().nullable(),
  alternateHookIndexes: z.array(z.number().int().nonnegative()).max(2),
  status: IdeaStatus,
  series: z.object({ name: z.string(), part: z.number().int().positive() }).nullable().default(null),
  dropReason: z.string().nullable().default(null),
});
export type Idea = z.infer<typeof Idea>;
