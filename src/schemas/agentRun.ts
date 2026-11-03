import { z } from 'zod';
import { IsoDateTime, SchemaV1 } from './common';

export const AGENT_NAMES = [
  'trend-scout',
  'hook-master',
  'script-writer',
  'visual-director',
  'qa-reviewer',
  'community-manager',
  'growth-analyst',
] as const;
export const AgentName = z.enum(AGENT_NAMES);
export type AgentName = z.infer<typeof AgentName>;

/** Record of one agent invocation (G3: model, prompt version, inputs, validity, duration). */
export const AgentRunRecord = z.object({
  schemaVersion: SchemaV1,
  runId: z.string().min(1),
  agent: AgentName,
  promptVersion: z.string().min(1),
  model: z.string().min(1),
  startedAt: IsoDateTime,
  durationMs: z.number().nonnegative(),
  /** Paths or ids of the inputs (never inline secrets). */
  inputRefs: z.array(z.string()),
  outputRef: z.string().nullable(),
  /** Tools the agent was allowed to use. */
  tools: z.array(z.string()),
  maxTurns: z.number().int().positive(),
  /** 1 = first try valid; 2 = valid after one repair; invalid after 2 => rejected. */
  attempts: z.number().int().min(1).max(2),
  valid: z.boolean(),
  validationErrors: z.array(z.string()),
  exitCode: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type AgentRunRecord = z.infer<typeof AgentRunRecord>;
