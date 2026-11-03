/**
 * Claude web search source: trend-scout (WebSearch + WebFetch only) looks up this week's
 * AI-video trends in the niche and returns pattern analyses (no copied wording, no media).
 * Uses one agent call; isolated like every other source.
 */
import { z } from 'zod';
import { runAgent, type ClaudeRunner } from '../claude/runAgent';
import { shortHash } from '../lib/ids';
import { HttpUrl, TrendAnalysis, type Trend } from '../schemas';
import type { TrendSource, TrendSourceContext } from './index';

export const WebSearchTrendsOutput = z.strictObject({
  trends: z
    .array(
      z.strictObject({
        sourceUrl: HttpUrl.nullable(),
        analysis: TrendAnalysis,
      }),
    )
    .max(5),
});

export function webSearchSource(opts: {
  enabled?: boolean;
  model?: string;
  runner?: ClaudeRunner;
  recordPath?: (ctx: TrendSourceContext) => string | undefined;
}): TrendSource {
  return {
    name: 'web_search',
    enabled: () => opts.enabled !== false,
    async fetch(ctx) {
      const recordPath = opts.recordPath?.(ctx);
      const res = await runAgent({
        agent: 'trend-scout',
        runId: ctx.runId,
        instruction: [
          `Niche: ${ctx.niche}. Today is ${ctx.date}.`,
          'Use web search to find up to 5 short-form video trends from the last 7 days that fit this niche',
          '(AI-generated visuals, explainer reels, what-if stories). For each, return the source URL you',
          'learned it from (or null) and a pattern analysis. Patterns only: never quote hooks or captions.',
        ].join(' '),
        schema: WebSearchTrendsOutput,
        inputRefs: ['web_search'],
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.runner ? { runner: opts.runner } : {}),
        ...(recordPath ? { recordPath } : {}),
      });
      if (!res.ok || !res.output)
        throw new Error(`trend-scout web search rejected: ${res.record.error ?? ''}`);
      return res.output.trends.map((t): Trend => ({
        schemaVersion: 1,
        id: `web_search:${shortHash(`${ctx.date}:${t.analysis.topic.toLowerCase()}`)}`,
        source: 'web_search',
        sourceRef: t.sourceUrl ?? 'claude_web_search',
        permalink: t.sourceUrl,
        capturedAt: ctx.now.toISOString(),
        postedAt: null,
        captionText: null,
        metrics: { views: null, likes: null, comments: null, followers: null },
        viralScore: null,
        viralScoreIsProxy: false,
        sampleSize: 0,
        confidence: 'low',
        analysis: t.analysis,
      }));
    },
  };
}
