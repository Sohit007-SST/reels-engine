/**
 * Originality QA (spec 2.5 + 7.7): several independent signals, never just one.
 *
 *  1. word 5-gram containment: share of OUR 5-word sequences that also appear in a corpus text
 *  2. longest common run of words (catches a copied sentence inside otherwise new text)
 *  3. embedding cosine similarity (injectable embedder; deterministic local fallback below)
 *  4. an injectable judge (the agents module can plug in Claude) for BORDERLINE cases only
 *
 * Corpus = trend captions (untrusted data, only ever compared, never executed) + our last 60 reels.
 * Common creator phrases ("follow for part 2", "what if", ...) and the disclosure line are removed
 * before comparing so boilerplate never counts as copying.
 *
 * Thresholds were calibrated on tests/fixtures/qa/originality (copied + paraphrased caught,
 * same-topic original and common phrases pass).
 */
import { z } from 'zod';
import type { QaCheck, ReelSpec } from '../schemas';
import { createLogger } from '../lib/logger';
import { serializeError } from '../lib/redact';

export interface OriginalityCorpus {
  /** Trend captions (untrusted) and our last 60 reels' scripts. */
  texts: Array<{ id: string; source: 'trend' | 'own'; text: string }>;
}

export interface OriginalityResult {
  maxNgramOverlap: number;
  maxEmbeddingSimilarity: number | null;
  verdict: 'original' | 'borderline' | 'copied';
  closestId: string | null;
  checks: QaCheck[];
}

export type Embedder = (texts: string[]) => Promise<number[][]>;

export const JudgeVerdict = z.object({
  verdict: z.enum(['original', 'copied', 'unsure']),
  reason: z.string().max(1000),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdict>;

export interface JudgeInput {
  ours: string;
  closest: { id: string; source: 'trend' | 'own'; text: string };
  signals: { ngramContainment: number; longestRun: number; embeddingSimilarity: number | null };
}
export type OriginalityJudge = (input: JudgeInput) => Promise<unknown>;

export interface OriginalityThresholds {
  ngramN: number;
  copiedContainment: number;
  borderlineContainment: number;
  copiedRun: number;
  borderlineRun: number;
  copiedEmbedding: number;
  borderlineEmbedding: number;
}

/** Calibrated for the deterministic local embedder. Override when injecting a model embedder. */
export const DEFAULT_ORIGINALITY_THRESHOLDS: OriginalityThresholds = {
  ngramN: 5,
  copiedContainment: 0.3,
  borderlineContainment: 0.08,
  copiedRun: 10,
  borderlineRun: 7,
  copiedEmbedding: 0.8,
  borderlineEmbedding: 0.25,
};

export const MAX_OWN_REELS = 60;

export interface OriginalityOptions {
  embedder?: Embedder | null;
  judge?: OriginalityJudge | null;
  thresholds?: Partial<OriginalityThresholds>;
  /** Extra boilerplate to ignore. */
  ignorePhrases?: string[];
  /** brand.disclosure.captionLine: removed from our caption and ignored everywhere. */
  disclosureLine?: string;
}

/** Phrases every creator uses; they are never evidence of copying. */
export const COMMON_PHRASES = [
  'follow for part 2',
  'follow for part two',
  'follow for more',
  'follow for daily',
  'like and subscribe',
  'like and follow',
  'save this for later',
  'save this',
  'share this with a friend',
  'send this to a friend',
  'tag a friend',
  'comment below',
  'drop a comment',
  'let me know in the comments',
  'tell me in the comments',
  'wait for it',
  'watch till the end',
  'watch until the end',
  'stay tuned',
  'link in bio',
  'did you know',
  'what if',
  'you wont believe',
  'turn on notifications',
  'part 2',
  'part two',
];

// ---------------------------------------------------------------- text utils

export function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’ʼ']/g, '')
    .replace(/#[\p{L}\p{N}_]+/gu, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const BREAK = '\u0000';

/** Normalized tokens with boilerplate phrases replaced by a break marker (no n-gram crosses it). */
export function contentTokens(text: string, ignore: string[] = []): string[] {
  let t = ` ${normalizeText(text)} `;
  const phrases = [...COMMON_PHRASES, ...ignore.map(normalizeText)]
    .filter((p) => p.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const p of phrases) t = t.split(` ${p} `).join(` ${BREAK} `);
  return t.split(' ').filter((w) => w.length > 0);
}

export function ngrams(tokens: string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= tokens.length; i++) {
    const slice = tokens.slice(i, i + n);
    if (slice.includes(BREAK)) continue;
    out.add(slice.join(' '));
  }
  return out;
}

/** Share of `ours` n-grams present in `theirs` (0..1). */
export function containment(ours: Set<string>, theirs: Set<string>): number {
  if (ours.size === 0) return 0;
  let hit = 0;
  for (const g of ours) if (theirs.has(g)) hit++;
  return hit / ours.size;
}

/** Longest run of identical consecutive tokens (break markers never match). */
export function longestCommonRun(a: string[], b: string[]): number {
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    const ai = a[i - 1];
    for (let j = 1; j <= b.length; j++) {
      if (ai !== BREAK && ai === b[j - 1]) {
        cur[j] = (prev[j - 1] ?? 0) + 1;
        if ((cur[j] ?? 0) > best) best = cur[j] ?? 0;
      }
    }
    prev = cur;
  }
  return best;
}

// ---------------------------------------------------------------- local embedder

const STOPWORDS = new Set(
  (
    'a an the and or but if then so of to in on at by for with from into onto over under about as is are was were be been being ' +
    'it its this that these those there here we you your our they them their he she his her i me my mine us ' +
    'do does did done have has had having can could would should will shall may might must not no yes just ' +
    'very really more most less least than too also even still only own same such what which who whom whose ' +
    'when where why how all any both each few other some again once up down out off'
  ).split(' '),
);

function stem(w: string): string {
  if (w.length <= 4) return w;
  for (const suf of [
    'ations',
    'ation',
    'ingly',
    'ings',
    'ing',
    'edly',
    'ied',
    'ies',
    'ed',
    'ly',
    'es',
    's',
  ]) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) return w.slice(0, -suf.length);
  }
  return w;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const LOCAL_EMBED_DIM = 2048;

function features(text: string, ignore: string[]): string[] {
  const words = contentTokens(text, ignore).filter((w) => w !== BREAK && !STOPWORDS.has(w));
  const stems = words.map(stem);
  const feats: string[] = [];
  for (const s of stems) {
    feats.push(`w:${s}`);
    const padded = `_${s}_`;
    for (let i = 0; i + 4 <= padded.length; i++) feats.push(`c:${padded.slice(i, i + 4)}`);
  }
  for (let i = 0; i + 1 < stems.length; i++) feats.push(`b:${stems[i]} ${stems[i + 1]}`);
  return feats;
}

/**
 * Deterministic local "embedding": hashed TF-IDF over stemmed content words, word bigrams and
 * character 4-grams. IDF comes from the texts embedded together, so niche words shared by every
 * reel (e.g. "space") weigh less than distinctive ones. No network, no model, fully reproducible.
 */
export function localEmbed(texts: string[], ignore: string[] = []): number[][] {
  const feats = texts.map((t) => features(t, ignore));
  const df = new Map<string, number>();
  for (const f of feats) for (const k of new Set(f)) df.set(k, (df.get(k) ?? 0) + 1);
  const N = texts.length;
  return feats.map((f) => {
    const v = new Array<number>(LOCAL_EMBED_DIM).fill(0);
    const tf = new Map<string, number>();
    for (const k of f) tf.set(k, (tf.get(k) ?? 0) + 1);
    for (const [k, c] of tf) {
      const idf = Math.log((N + 1) / ((df.get(k) ?? 0) + 1)) + 1;
      const weight = (k.startsWith('c:') ? 0.35 : k.startsWith('b:') ? 1.2 : 1) * (1 + Math.log(c)) * idf;
      const idx = fnv1a(k) % LOCAL_EMBED_DIM;
      v[idx] = (v[idx] ?? 0) + weight;
    }
    return v;
  });
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

// ---------------------------------------------------------------- spec text

/**
 * The substantive text of a reel: hook + all beats except the CTA beat + caption body.
 * Hashtags, the disclosure line and the comment question are excluded (boilerplate).
 */
export function reelText(spec: ReelSpec, disclosureLine?: string): string {
  const parts: string[] = [spec.hook.spoken];
  for (const b of spec.beats) {
    if (b.role === 'cta') continue;
    parts.push(b.voiceover);
  }
  const caption = spec.caption
    .split(/\r?\n/)
    .filter((line) => {
      const l = line.trim();
      if (l === '') return false;
      if (/^(#[\p{L}\p{N}_]+\s*)+$/u.test(l)) return false;
      if (disclosureLine && normalizeText(l) === normalizeText(disclosureLine)) return false;
      if (spec.commentQuestion && normalizeText(l) === normalizeText(spec.commentQuestion)) return false;
      return true;
    })
    .join('\n');
  parts.push(caption);
  return parts.join('\n');
}

/** Trend texts + the most recent MAX_OWN_REELS of our own (array order = oldest..newest). */
export function boundedCorpus(corpus: OriginalityCorpus, selfId?: string): OriginalityCorpus['texts'] {
  const trend = corpus.texts.filter((t) => t.source === 'trend' && t.text.trim() !== '');
  const own = corpus.texts.filter((t) => t.source === 'own' && t.id !== selfId && t.text.trim() !== '');
  return [...trend, ...own.slice(-MAX_OWN_REELS)];
}

// ---------------------------------------------------------------- main

export interface TextSignals {
  id: string;
  source: 'trend' | 'own';
  containment: number;
  longestRun: number;
  embedding: number | null;
}

export function classify(
  s: Pick<TextSignals, 'containment' | 'longestRun' | 'embedding'>,
  t: OriginalityThresholds,
): 'original' | 'borderline' | 'copied' {
  if (s.containment >= t.copiedContainment || s.longestRun >= t.copiedRun) return 'copied';
  if (s.embedding !== null && s.embedding >= t.copiedEmbedding) return 'copied';
  if (s.containment >= t.borderlineContainment || s.longestRun >= t.borderlineRun) return 'borderline';
  if (s.embedding !== null && s.embedding >= t.borderlineEmbedding) return 'borderline';
  return 'original';
}

const RANK = { original: 0, borderline: 1, copied: 2 } as const;

const check = (
  id: string,
  status: QaCheck['status'],
  message: string,
  details: Record<string, unknown> = {},
): QaCheck => ({ id, category: 'originality', status, message, details, beatIndex: null });

/** Compare one text against a corpus. Exposed for calibration tests and for ideas/hook dedupe. */
export async function compareText(
  ours: string,
  corpusTexts: OriginalityCorpus['texts'],
  opts: OriginalityOptions = {},
): Promise<{
  signals: TextSignals[];
  embedderUsed: 'injected' | 'local' | 'none';
  embedderError: string | null;
}> {
  const t = { ...DEFAULT_ORIGINALITY_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const ignore = opts.ignorePhrases ?? [];
  const ourTokens = contentTokens(ours, ignore);
  const ourGrams = ngrams(ourTokens, t.ngramN);

  let vectors: number[][] | null = null;
  let embedderUsed: 'injected' | 'local' | 'none' = 'none';
  let embedderError: string | null = null;
  const all = [ours, ...corpusTexts.map((c) => c.text)];
  if (corpusTexts.length > 0) {
    if (opts.embedder) {
      try {
        const v = await opts.embedder(all);
        if (!Array.isArray(v) || v.length !== all.length) throw new Error('embedder returned wrong count');
        vectors = v;
        embedderUsed = 'injected';
      } catch (err) {
        embedderError = serializeError(err).message;
      }
    }
    if (vectors === null) {
      vectors = localEmbed(all, ignore);
      embedderUsed = 'local';
    }
  }

  const signals = corpusTexts.map((c, i) => {
    const toks = contentTokens(c.text, ignore);
    const first = vectors?.[0];
    const other = vectors?.[i + 1];
    return {
      id: c.id,
      source: c.source,
      containment: containment(ourGrams, ngrams(toks, t.ngramN)),
      longestRun: longestCommonRun(ourTokens, toks),
      embedding: first && other ? cosine(first, other) : null,
    };
  });
  return { signals, embedderUsed, embedderError };
}

export async function checkOriginality(
  spec: ReelSpec,
  corpus: OriginalityCorpus,
  opts: OriginalityOptions = {},
): Promise<OriginalityResult> {
  const log = createLogger({ stage: 'qa.originality', reelId: spec.id });
  // A model embedder has its own scale; the default thresholds belong to the local embedder.
  const t = { ...DEFAULT_ORIGINALITY_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const ours = reelText(spec, opts.disclosureLine);
  if (opts.disclosureLine)
    opts = { ...opts, ignorePhrases: [...(opts.ignorePhrases ?? []), opts.disclosureLine] };
  const texts = boundedCorpus(corpus, spec.id);
  const checks: QaCheck[] = [];

  const { signals, embedderUsed, embedderError } = await compareText(ours, texts, opts);
  if (embedderError) {
    checks.push(
      check('originality.embedder', 'warn', `embedder failed, used local fallback: ${embedderError}`),
    );
  }

  let verdict: OriginalityResult['verdict'] = 'original';
  let closest: TextSignals | null = null;
  let closestScore = -1;
  for (const s of signals) {
    const v = classify(s, t);
    const score = RANK[v] * 10 + Math.max(s.containment, s.embedding ?? 0, s.longestRun / t.copiedRun);
    if (RANK[v] > RANK[verdict]) verdict = v;
    if (score > closestScore) {
      closestScore = score;
      closest = s;
    }
  }
  const maxNgram = signals.reduce((m, s) => Math.max(m, s.containment), 0);
  const maxRun = signals.reduce((m, s) => Math.max(m, s.longestRun), 0);
  const maxEmb = signals.some((s) => s.embedding !== null)
    ? signals.reduce((m, s) => Math.max(m, s.embedding ?? 0), 0)
    : null;

  checks.push(
    check(
      'originality.ngram',
      maxNgram >= t.copiedContainment || maxRun >= t.copiedRun
        ? 'fail'
        : maxNgram >= t.borderlineContainment || maxRun >= t.borderlineRun
          ? 'warn'
          : 'pass',
      `max ${t.ngramN}-gram overlap ${(maxNgram * 100).toFixed(1)}%, longest shared run ${maxRun} words`,
      { maxContainment: maxNgram, maxRun, compared: signals.length },
    ),
  );
  checks.push(
    maxEmb === null
      ? check('originality.embedding', 'skip', 'empty corpus; nothing to compare')
      : check(
          'originality.embedding',
          maxEmb >= t.copiedEmbedding ? 'fail' : maxEmb >= t.borderlineEmbedding ? 'warn' : 'pass',
          `max embedding similarity ${maxEmb.toFixed(3)} (${embedderUsed} embedder)`,
          { maxSimilarity: maxEmb, embedder: embedderUsed },
        ),
  );

  // Agent judgment only for borderline cases.
  if (verdict === 'borderline' && opts.judge && closest) {
    const ref = texts.find((x) => x.id === closest?.id);
    if (ref) {
      try {
        const raw = await opts.judge({
          ours,
          closest: ref,
          signals: {
            ngramContainment: closest.containment,
            longestRun: closest.longestRun,
            embeddingSimilarity: closest.embedding,
          },
        });
        const j = JudgeVerdict.safeParse(raw);
        if (!j.success) {
          checks.push(check('originality.judge', 'warn', 'judge returned invalid output; stays borderline'));
        } else if (j.data.verdict === 'copied') {
          verdict = 'copied';
          checks.push(
            check('originality.judge', 'fail', `judge: copied (${j.data.reason})`, { closestId: ref.id }),
          );
        } else if (j.data.verdict === 'original') {
          verdict = 'original';
          checks.push(
            check('originality.judge', 'pass', `judge: original (${j.data.reason})`, { closestId: ref.id }),
          );
        } else {
          checks.push(
            check('originality.judge', 'warn', `judge unsure (${j.data.reason}); stays borderline`),
          );
        }
      } catch (err) {
        log.warn('originality judge failed', { err });
        checks.push(
          check(
            'originality.judge',
            'warn',
            `judge failed: ${serializeError(err).message}; stays borderline`,
          ),
        );
      }
    }
  }

  checks.push(
    check(
      'originality.verdict',
      verdict === 'copied' ? 'fail' : verdict === 'borderline' ? 'warn' : 'pass',
      verdict === 'original'
        ? 'original'
        : `${verdict}: closest ${closest?.source ?? '?'} text ${closest?.id ?? '?'}`,
      {
        verdict,
        closestId: closest?.id ?? null,
        closestSource: closest?.source ?? null,
        signals: closest
          ? { containment: closest.containment, longestRun: closest.longestRun, embedding: closest.embedding }
          : null,
      },
    ),
  );
  return {
    maxNgramOverlap: maxNgram,
    maxEmbeddingSimilarity: maxEmb,
    verdict,
    closestId: closest?.id ?? null,
    checks,
  };
}
