import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, setLogSink } from '../../src/lib/logger';
import {
  clearRegisteredSecrets,
  redact,
  redactDeep,
  registerSecret,
  sanitizeError,
  serializeError,
  REDACTED,
} from '../../src/lib/redact';

const SECRET = 'zQ9xLmP4vR7tK2wN8bY5cH3jF6gD1sA0'; // gitleaks:allow (fake test fixture)

afterEach(() => clearRegisteredSecrets());

function fragments(s: string): string[] {
  // every suffix/prefix of length >= 4 (spec: not even the last characters)
  const out: string[] = [];
  for (let n = 4; n <= s.length; n++) {
    out.push(s.slice(-n), s.slice(0, n));
  }
  return out;
}

function expectNoFragment(text: string, secret: string) {
  for (const f of fragments(secret))
    expect(text.includes(f), `leaked fragment "${f.length} chars"`).toBe(false);
}

describe('redaction', () => {
  it('removes registered secrets fully (no prefix/suffix)', () => {
    registerSecret(SECRET);
    const out = redact(`token=${SECRET} and again ${SECRET}.`);
    expectNoFragment(out, SECRET);
    expect(out).toContain(REDACTED);
  });

  it('removes URL-encoded registered secrets', () => {
    const s = 'abc/def+ghi=jkl/mno+pqr';
    registerSecret(s);
    expect(redact(`x?y=${encodeURIComponent(s)}`)).not.toContain(encodeURIComponent(s));
  });

  it.each([
    ['Authorization: Bearer abcdefghijklmnop1234', 'abcdefghijklmnop1234'],
    ['{"authorization":"Bearer sk-live-ABCDEF123456"}', 'ABCDEF123456'],
    [
      'https://graph.facebook.com/v23.0/me?fields=id&access_token=EAAB1234567890abcdefghijk', // gitleaks:allow (fake test fixture)
      'EAAB1234567890',
    ],
    [
      'https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage',
      'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
    ],
    [
      'https://bucket.s3.amazonaws.com/x.mp4?X-Amz-Signature=deadbeefcafe1234&X-Amz-Credential=AKIAXYZ',
      'deadbeefcafe1234',
    ],
    ['https://rupload.facebook.com/x?sig=abcdef123456&oh=1', 'abcdef123456'],
    ['hf token hf_abcdefghijklmnopqrstuvwx', 'abcdefghijklmnopqrstuvwx'],
    ['gh token ghp_abcdefghijklmnopqrstuvwxyz0123', 'abcdefghijklmnopqrstuvwxyz0123'],
    ['key AIzaSyA1234567890abcdefghijklmnopqrstu', 'SyA1234567890abcdefghij'],
    ['redirect?code=AQBx123456789secret&state=1', 'AQBx123456789secret'],
    [
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', // gitleaks:allow (fake test fixture)
      'dozjgNryP4J3jVmNHl0w5N',
    ],
    ['"client_secret": "my-app-secret-value-123"', 'my-app-secret-value-123'],
  ])('pattern-redacts %s', (input, leaked) => {
    expect(redact(input)).not.toContain(leaked);
  });

  it('keeps ordinary text readable', () => {
    expect(redact('error code=190 for reel 2026-11-05-01')).toBe('error code=190 for reel 2026-11-05-01');
  });

  it('redactDeep redacts sensitive keys and nested values without mutating', () => {
    registerSecret(SECRET);
    const input = {
      headers: { Authorization: 'Bearer whatever-123456', 'content-type': 'json' },
      nested: [{ note: `has ${SECRET}` }],
      access_token: 'abc12345678',
      tokens: 42,
    };
    const out = redactDeep(input);
    expect(out.headers.Authorization).toBe(REDACTED);
    expect(out.headers['content-type']).toBe('json');
    expect(out.access_token).toBe(REDACTED);
    expect(out.tokens).toBe(42);
    expectNoFragment(JSON.stringify(out), SECRET);
    expect(input.access_token).toBe('abc12345678');
  });

  it('errors (message, stack, cause) are sanitized', () => {
    registerSecret(SECRET);
    const err = new Error(`request failed with ${SECRET}`, { cause: new Error(`inner ${SECRET}`) });
    const ser = serializeError(err);
    expectNoFragment(JSON.stringify(ser), SECRET);
    const clean = sanitizeError(err);
    expectNoFragment(clean.message + clean.stack, SECRET);
  });

  it('logger output never contains a key fragment', () => {
    registerSecret(SECRET);
    const lines: string[] = [];
    const restore = setLogSink((l) => lines.push(l));
    try {
      const log = createLogger({ runId: 'r1', reelId: '2026-11-05-01' });
      log.info(`calling api with ${SECRET}`, {
        url: `https://graph.facebook.com/me?access_token=${SECRET}`,
        headers: { authorization: `Bearer ${SECRET}` },
      });
      log.error('boom', { err: new Error(`bad token ${SECRET}`) });
      log.child({ provider: 'instagram' }).warn('x', { META_PAGE_ACCESS_TOKEN: SECRET });
    } finally {
      restore();
    }
    expect(lines).toHaveLength(3);
    const all = lines.join('\n');
    expectNoFragment(all, SECRET);
    const first = JSON.parse(lines[0] as string);
    expect(first).toMatchObject({ level: 'info', runId: 'r1', reelId: '2026-11-05-01' });
    expect(JSON.parse(lines[2] as string).provider).toBe('instagram');
  });

  it('logger.time records duration and status', async () => {
    const lines: string[] = [];
    const restore = setLogSink((l) => lines.push(l));
    try {
      await createLogger({ runId: 'r2' }).time('render', async () => 1);
      await expect(createLogger().time('qa', async () => Promise.reject(new Error('nope')))).rejects.toThrow(
        'nope',
      );
    } finally {
      restore();
    }
    expect(JSON.parse(lines[0] as string)).toMatchObject({ status: 'ok', stage: 'render' });
    expect(JSON.parse(lines[1] as string)).toMatchObject({ status: 'error', level: 'error' });
  });
});
