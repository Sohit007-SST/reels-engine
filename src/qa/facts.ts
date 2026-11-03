/**
 * Fact QA (spec 7.3 + 7.7, PA-16): a URL alone is not evidence.
 *
 *  checkFacts(spec)    every claim must be SUPPORTED (with source URL, publisher, supporting quote
 *                      that is about the claim, and a verification stamp) or HYPOTHETICAL; CUT claims
 *                      must not appear in the script; anything else fails.
 *  verifyFacts(spec)   fetches each source through the shared http wrapper (timeout, bounded retry,
 *                      GET only = no external writes) and checks the supportingQuote really appears on
 *                      the page. Pages are untrusted data: only string-matched, never interpreted.
 */
import type { Fact, QaCheck, ReelSpec } from '../schemas';
import { httpRequest } from '../lib/http';
import { createLogger } from '../lib/logger';
import { serializeError } from '../lib/redact';
import { normalizeText } from './originality';

const check = (
  id: string,
  status: QaCheck['status'],
  message: string,
  details: Record<string, unknown> = {},
  beatIndex: number | null = null,
): QaCheck => ({ id, category: 'facts', status, message, details, beatIndex });

const FACT_STOPWORDS = new Set(
  'a an the and or but of to in on at by for with from is are was were be been it its this that as than then into about over under can could would will may might has have had more most very'.split(
    ' ',
  ),
);

function contentWords(s: string): string[] {
  return normalizeText(s)
    .split(' ')
    .filter((w) => w.length > 1 && !FACT_STOPWORDS.has(w));
}

/** Share of the claim's content words (and every number) that the quote also contains. */
export function claimQuoteRelevance(
  claim: string,
  quote: string,
): { score: number; missingNumbers: string[] } {
  const cw = contentWords(claim);
  const qset = new Set(contentWords(quote));
  const qstems = new Set([...qset].map((w) => w.slice(0, 5)));
  if (cw.length === 0) return { score: 0, missingNumbers: [] };
  let hit = 0;
  for (const w of cw) if (qset.has(w) || qstems.has(w.slice(0, 5))) hit++;
  const nums = (s: string) => (normalizeText(s).match(/\d+/g) ?? []).map((n) => n.replace(/^0+(?=\d)/, ''));
  const qnums = new Set(nums(quote));
  const missingNumbers = nums(claim).filter((n) => !qnums.has(n));
  return { score: hit / cw.length, missingNumbers };
}

export const MIN_CLAIM_QUOTE_RELEVANCE = 0.5;

/** Where in the script a claim appears (beat index), using normalized containment. */
function claimLocation(spec: ReelSpec, claim: string): number | null | 'caption' {
  const c = normalizeText(claim);
  if (c.length === 0) return null;
  const i = spec.beats.findIndex((b) => normalizeText(`${b.voiceover} ${b.onScreenText}`).includes(c));
  if (i >= 0) return i;
  if (normalizeText(spec.caption).includes(c)) return 'caption';
  return null;
}

const HYPOTHETICAL_MARKERS = /\b(what if|imagine|could|might|would|may|perhaps|suppose|hypothetical)\b/;

function isHttpUrl(u: string | null): u is string {
  if (!u) return false;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function checkFacts(spec: ReelSpec): QaCheck[] {
  const out: QaCheck[] = [];
  spec.facts.forEach((f, i) => {
    const loc = claimLocation(spec, f.claim);
    const beat = typeof loc === 'number' ? loc : null;
    const label = `claim ${i + 1} "${f.claim.slice(0, 60)}"`;
    switch (f.status) {
      case 'SUPPORTED': {
        const problems: string[] = [];
        if (!isHttpUrl(f.sourceUrl)) problems.push('no http(s) source URL');
        if (!f.publisher?.trim()) problems.push('no publisher');
        if (!f.supportingQuote?.trim()) problems.push('no supporting quote');
        if (!f.verifiedAt) problems.push('source not verified (run the fact verifier)');
        if (f.supportingQuote?.trim()) {
          const rel = claimQuoteRelevance(f.claim, f.supportingQuote);
          if (rel.score < MIN_CLAIM_QUOTE_RELEVANCE)
            problems.push(`supporting quote is not about the claim (relevance ${rel.score.toFixed(2)})`);
          if (rel.missingNumbers.length > 0)
            problems.push(`numbers ${rel.missingNumbers.join(', ')} are not in the quote`);
        }
        out.push(
          problems.length === 0
            ? check('facts.claim', 'pass', `${label}: SUPPORTED`, { claim: i, sourceUrl: f.sourceUrl }, beat)
            : check('facts.claim', 'fail', `${label}: ${problems.join('; ')}`, { claim: i, problems }, beat),
        );
        break;
      }
      case 'HYPOTHETICAL': {
        out.push(check('facts.claim', 'pass', `${label}: HYPOTHETICAL`, { claim: i }, beat));
        if (beat !== null) {
          const b = spec.beats[beat];
          if (b && !HYPOTHETICAL_MARKERS.test(normalizeText(b.voiceover))) {
            out.push(
              check(
                'facts.hypothetical_framing',
                'warn',
                `${label} is hypothetical but beat ${beat} does not frame it as one ("what if", "imagine", "could")`,
                { claim: i },
                beat,
              ),
            );
          }
        }
        break;
      }
      case 'CUT':
        out.push(
          loc === null
            ? check('facts.claim', 'pass', `${label}: CUT and absent from the script`, { claim: i })
            : check(
                'facts.claim',
                'fail',
                `${label}: marked CUT but still in the ${beat !== null ? `beat ${beat}` : 'caption'}`,
                { claim: i },
                beat,
              ),
        );
        break;
      default:
        out.push(
          check(
            'facts.claim',
            'fail',
            `${label}: status ${f.status} (must be SUPPORTED or HYPOTHETICAL)`,
            { claim: i },
            beat,
          ),
        );
    }
  });
  if (spec.facts.length === 0) out.push(check('facts.claim', 'pass', 'no factual claims recorded'));
  return out;
}

// ---------------------------------------------------------------- verifier

/** Very small HTML -> text: drops scripts/styles/tags, decodes common entities. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, ' ');
}

/**
 * Does the page contain the quote? Exact normalized containment, or (for small differences in
 * punctuation/markup) a window of the page that contains >= 90% of the quote's words in order.
 */
export function quoteAppears(pageText: string, quote: string): boolean {
  const p = normalizeText(pageText);
  const q = normalizeText(quote);
  if (q.length < 12) return false;
  if (p.includes(q)) return true;
  const qw = q.split(' ');
  const pw = p.split(' ');
  const need = Math.ceil(qw.length * 0.9);
  const window = qw.length + 4;
  const first = new Set(qw.slice(0, 3));
  for (let i = 0; i < pw.length; i++) {
    if (!first.has(pw[i] ?? '')) continue;
    let j = 0;
    let matched = 0;
    for (let k = i; k < Math.min(pw.length, i + window) && j < qw.length; k++) {
      if (pw[k] === qw[j]) {
        matched++;
        j++;
      } else if (pw[k] === qw[j + 1]) {
        matched++;
        j += 2;
      }
    }
    if (matched >= need) return true;
  }
  return false;
}

const PRIVATE_HOST =
  /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|\[?f[cd][0-9a-f]{2}:)/i;

/** Source URLs come from model output: only public http(s) hosts may be fetched. */
export function isFetchableSource(u: string | null): boolean {
  if (!isHttpUrl(u)) return false;
  const host = new URL(u).hostname;
  return !PRIVATE_HOST.test(host) && !host.endsWith('.local') && !host.endsWith('.internal');
}

export type FetchText = (url: string) => Promise<string>;

export const MAX_SOURCE_BYTES = 3_000_000;

/** Default fetcher: shared http wrapper, GET only, 15 s timeout, bounded retry, size cap. */
export const defaultFetchText: FetchText = async (url) => {
  const res = await httpRequest(url, {
    provider: 'fact-source',
    purpose: 'verify supporting quote',
    method: 'GET',
    timeoutMs: 15_000,
    retry: { maxAttempts: 2 },
    headers: { accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
  });
  const buf = await res.arrayBuffer();
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, MAX_SOURCE_BYTES));
  const type = res.headers.get('content-type') ?? '';
  return type.includes('html') || /<html|<body|<p[\s>]/i.test(text.slice(0, 5000)) ? htmlToText(text) : text;
};

export interface VerifyResult {
  facts: Fact[];
  checks: QaCheck[];
}

/**
 * Verify SUPPORTED and PENDING claims against their sources. A claim whose quote is found and is
 * about the claim becomes SUPPORTED (verifiedAt set); otherwise UNSUPPORTED with a note, so the
 * script-writer rewrites it as HYPOTHETICAL or cuts it. Unreachable sources stay PENDING (fail).
 */
export async function verifyFacts(
  spec: ReelSpec,
  opts: { fetchText?: FetchText; now?: () => Date } = {},
): Promise<VerifyResult> {
  const fetchText = opts.fetchText ?? defaultFetchText;
  const now = opts.now ?? (() => new Date());
  const log = createLogger({ stage: 'qa.facts', reelId: spec.id });
  const checks: QaCheck[] = [];
  const pageCache = new Map<string, Promise<string>>();
  const facts: Fact[] = [];
  for (const [i, f] of spec.facts.entries()) {
    if (f.status !== 'SUPPORTED' && f.status !== 'PENDING') {
      facts.push(f);
      continue;
    }
    const label = `claim ${i + 1}`;
    if (!isFetchableSource(f.sourceUrl) || !f.supportingQuote?.trim()) {
      facts.push({
        ...f,
        status: 'UNSUPPORTED',
        verifiedAt: now().toISOString(),
        verifierNote: 'no public source URL or no supporting quote',
      });
      checks.push(
        check('facts.verify', 'fail', `${label}: no fetchable public source or no quote`, { claim: i }),
      );
      continue;
    }
    const url = f.sourceUrl as string;
    let page: string;
    try {
      let p = pageCache.get(url);
      if (!p) {
        p = fetchText(url);
        pageCache.set(url, p);
      }
      page = await p;
    } catch (err) {
      const msg = serializeError(err).message;
      log.warn('fact source fetch failed', { claim: i, err });
      facts.push({ ...f, status: 'PENDING', verifierNote: `source unreachable: ${msg.slice(0, 200)}` });
      checks.push(
        check('facts.verify', 'fail', `${label}: source could not be fetched (${msg.slice(0, 120)})`, {
          claim: i,
        }),
      );
      continue;
    }
    const found = quoteAppears(page, f.supportingQuote);
    const rel = claimQuoteRelevance(f.claim, f.supportingQuote);
    const relevant = rel.score >= MIN_CLAIM_QUOTE_RELEVANCE && rel.missingNumbers.length === 0;
    if (found && relevant) {
      facts.push({
        ...f,
        status: 'SUPPORTED',
        verifiedAt: now().toISOString(),
        verifierNote: 'quote found on source page',
      });
      checks.push(check('facts.verify', 'pass', `${label}: quote found on the source`, { claim: i }));
    } else {
      const note = !found
        ? 'supporting quote not found on the source page'
        : 'quote found but does not state the claim';
      facts.push({ ...f, status: 'UNSUPPORTED', verifiedAt: now().toISOString(), verifierNote: note });
      checks.push(check('facts.verify', 'fail', `${label}: ${note}`, { claim: i, relevance: rel.score }));
    }
  }
  return { facts, checks };
}
