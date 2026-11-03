/**
 * Policy QA (spec 2.13 + 7.7): blocklist words/patterns, disclosure line present, built-in
 * content-safety rules (real people, logos/brands, copyrighted characters, children, medical /
 * financial / legal advice, self-harm/violence, fake news), and hashtag rules.
 * Plus structural content checks (spec 7.3 beat order / word count) as warnings.
 */
import type { Blocklist, Brand, QaCheck, ReelSpec } from '../schemas';
import { reelSpecStructureProblems } from '../schemas';

const check = (
  id: string,
  status: QaCheck['status'],
  message: string,
  details: Record<string, unknown> = {},
  beatIndex: number | null = null,
  category: QaCheck['category'] = 'policy',
): QaCheck => ({ id, category, status, message, details, beatIndex });

interface TextPart {
  where: string;
  beatIndex: number | null;
  text: string;
}

/** Every piece of text that ends up on screen, in audio, in the caption or in a generation prompt. */
export function specTextParts(spec: ReelSpec): TextPart[] {
  const parts: TextPart[] = [
    { where: 'hook.spoken', beatIndex: 0, text: spec.hook.spoken },
    { where: 'hook.onScreen', beatIndex: 0, text: spec.hook.onScreen },
    ...spec.hook.alternates.map((a, i) => ({ where: `hook.alternates[${i}]`, beatIndex: 0, text: a })),
  ];
  spec.beats.forEach((b, i) => {
    parts.push({ where: `beats[${i}].voiceover`, beatIndex: i, text: b.voiceover });
    parts.push({ where: `beats[${i}].onScreenText`, beatIndex: i, text: b.onScreenText });
    if (b.visual.prompt)
      parts.push({ where: `beats[${i}].visual.prompt`, beatIndex: i, text: b.visual.prompt });
    if (b.visual.params) {
      const strings = Object.values(b.visual.params).filter((v): v is string => typeof v === 'string');
      if (strings.length)
        parts.push({ where: `beats[${i}].visual.params`, beatIndex: i, text: strings.join(' \n ') });
    }
  });
  parts.push({ where: 'caption', beatIndex: null, text: spec.caption });
  if (spec.commentQuestion)
    parts.push({ where: 'commentQuestion', beatIndex: null, text: spec.commentQuestion });
  parts.push({ where: 'hashtags', beatIndex: null, text: spec.hashtags.join(' ') });
  return parts;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive whole-word/phrase matcher. */
export function phraseRegex(phrase: string): RegExp {
  const body = phrase.trim().split(/\s+/).map(escapeRe).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu');
}

export interface SafetyRule {
  id: string;
  label: string;
  patterns: RegExp[];
  /** Only check generation prompts (e.g. "photo of a real person"). */
  promptsOnly?: boolean;
}

/** Built-in content-safety rules (spec 2.13). Conservative; extend via brand/blocklist.json. */
export const SAFETY_RULES: SafetyRule[] = [
  {
    id: 'policy.real_people',
    label: "real people's likeness",
    patterns: [
      /\b(celebrity|celebrities|politician|president|prime minister|famous (actor|actress|singer|person))\b/i,
      /\b(photo|portrait|likeness|face) of (a )?real (person|people)\b/i,
    ],
    promptsOnly: true,
  },
  {
    id: 'policy.logos_brands',
    label: 'brand logos or trademarks',
    patterns: [
      /\blogos?\b/i,
      /\b(trademark|branded)\b/i,
      /\b(nike|adidas|coca[- ]?cola|pepsi|apple logo|mcdonald'?s|starbucks|google logo|tesla logo)\b/i,
    ],
    promptsOnly: true,
  },
  {
    id: 'policy.copyrighted_characters',
    label: 'copyrighted characters',
    patterns: [
      /\b(mickey mouse|spider-?man|batman|superman|pikachu|pok[eé]mon|harry potter|darth vader|mario|sonic the hedgehog|elsa|shrek|marvel|disney|star wars)\b/i,
    ],
  },
  {
    id: 'policy.children',
    label: 'content aimed at children',
    patterns: [/\b(for kids|for children|kids'? (show|video)|toddlers?|preschool(ers)?|nursery rhyme)\b/i],
  },
  {
    id: 'policy.medical_advice',
    label: 'medical advice',
    patterns: [
      /\b(you should (take|stop taking)|stop taking (your )?(medication|medicine|meds|pills)|recommended dose|dosage|cures? (cancer|diabetes|covid|disease)|treat(s|ment)? for your|consult(ing)? isn'?t necessary)\b/i,
    ],
  },
  {
    id: 'policy.financial_advice',
    label: 'financial advice',
    patterns: [
      /\b(you should (buy|sell|invest)|invest (now|in this)|financial advice|guaranteed (returns?|profit)|price target)\b/i,
    ],
  },
  {
    id: 'policy.legal_advice',
    label: 'legal advice',
    patterns: [/\b(legal advice|you (can|should) sue|this is legal in your)\b/i],
  },
  {
    id: 'policy.harm',
    label: 'violence, gore or self-harm',
    patterns: [/\b(suicide|self[- ]harm|gore|gory|dismember(ed|ment)?|behead(ed|ing)?|kill yourself)\b/i],
  },
  {
    id: 'policy.fake_news',
    label: 'fake news / current events as fact',
    patterns: [/\b(breaking news|just happened|this is happening right now|confirmed today)\b/i],
  },
];

/** Blocklist + safety rules + disclosure + hashtag checks. */
export function checkPolicy(spec: ReelSpec, brand: Brand, blocklist: Blocklist): QaCheck[] {
  const out: QaCheck[] = [];
  const parts = specTextParts(spec);

  // 1. Blocklist words (whole word/phrase, case-insensitive).
  const wordHits: QaCheck[] = [];
  for (const w of blocklist.words) {
    if (!w.trim()) continue;
    const re = phraseRegex(w);
    for (const p of parts) {
      if (re.test(p.text)) {
        wordHits.push(
          check(
            'policy.blocklist',
            'fail',
            `blocked word "${w}" in ${p.where}`,
            { word: w, where: p.where },
            p.beatIndex,
          ),
        );
      }
    }
  }
  // 2. Blocklist regex patterns.
  for (const src of blocklist.patterns) {
    let re: RegExp;
    try {
      re = new RegExp(src, 'iu');
    } catch {
      out.push(check('policy.blocklist_pattern', 'warn', `invalid blocklist pattern ignored: ${src}`));
      continue;
    }
    for (const p of parts) {
      if (re.test(p.text)) {
        wordHits.push(
          check(
            'policy.blocklist',
            'fail',
            `blocked pattern /${src}/ in ${p.where}`,
            { pattern: src, where: p.where },
            p.beatIndex,
          ),
        );
      }
    }
  }
  out.push(
    ...(wordHits.length ? wordHits : [check('policy.blocklist', 'pass', 'no blocklisted words or patterns')]),
  );

  // 3. Built-in content-safety rules.
  for (const rule of SAFETY_RULES) {
    const hits: QaCheck[] = [];
    for (const p of parts) {
      if (rule.promptsOnly && !p.where.includes('visual')) continue;
      const m = rule.patterns.map((re) => re.exec(p.text)).find((x) => x !== null);
      if (m)
        hits.push(
          check(
            rule.id,
            'fail',
            `${rule.label}: "${m[0]}" in ${p.where}`,
            { match: m[0], where: p.where },
            p.beatIndex,
          ),
        );
    }
    out.push(...(hits.length ? hits : [check(rule.id, 'pass', `no ${rule.label}`)]));
  }

  // 4. AI disclosure line.
  if (brand.disclosure.includeInCaption) {
    const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
    const line = norm(brand.disclosure.captionLine);
    out.push(
      line.length > 0 && norm(spec.caption).includes(line)
        ? check('policy.disclosure', 'pass', 'disclosure line present')
        : check('policy.disclosure', 'fail', 'caption is missing the AI disclosure line from brand.json', {
            expected: brand.disclosure.captionLine,
          }),
    );
  } else {
    out.push(check('policy.disclosure', 'skip', 'caption disclosure disabled in brand.json'));
  }

  // 5. Hashtags: count from brand.json, from the approved pool.
  const { min, max } = brand.hashtagsPerReel;
  const n = spec.hashtags.length;
  out.push(
    n >= min && n <= max
      ? check('policy.hashtags', 'pass', `${n} hashtags`)
      : check('policy.hashtags', 'fail', `${n} hashtags, expected ${min}-${max}`, { count: n }),
  );
  const pool = new Set(brand.hashtagPool.map((h) => h.toLowerCase()));
  const outside = spec.hashtags.filter((h) => !pool.has(h.toLowerCase()));
  if (outside.length) {
    out.push(
      check('policy.hashtag_pool', 'warn', `hashtags not in brand pool: ${outside.join(' ')}`, { outside }),
    );
  }
  return out;
}

/** Content structure checks (spec 7.3) as warnings: QA never blocks on style alone. */
export function checkContent(spec: ReelSpec): QaCheck[] {
  const problems = reelSpecStructureProblems(spec);
  const out: QaCheck[] = problems.map((p) => check('content.structure', 'warn', p, {}, null, 'content'));
  const firstLine = spec.caption.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const hookWords = new Set(spec.hook.spoken.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const lineWords = firstLine.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const shared = lineWords.filter((w) => hookWords.has(w) && w.length > 3).length;
  if (shared === 0)
    out.push(
      check('content.caption_hook', 'warn', 'caption line 1 does not restate the hook', {}, null, 'content'),
    );
  if (out.length === 0)
    out.push(
      check('content.structure', 'pass', 'beat structure and caption look right', {}, null, 'content'),
    );
  return out;
}
