import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildUserPrompt, runAgent } from '../../src/claude/runAgent';
import { fakeClaude } from './fakeClaude';

const FIX = path.join(__dirname, '..', 'fixtures', 'injection');
const fixtures = {
  caption: readFileSync(path.join(FIX, 'caption.txt'), 'utf8'),
  comment: readFileSync(path.join(FIX, 'comment.txt'), 'utf8'),
  web_page: readFileSync(path.join(FIX, 'webpage.html'), 'utf8'),
};
const S = z.strictObject({ reply: z.string().min(1) });

describe('prompt-injection fixtures', () => {
  for (const [label, text] of Object.entries(fixtures)) {
    it(`${label}: same flags/tools/env as a clean run; text only inside one data block`, async () => {
      const clean = fakeClaude([{ reply: 'ok' }]);
      const dirty = fakeClaude([{ reply: 'ok' }]);
      const opts = {
        agent: 'community-manager' as const,
        runId: 'r',
        instruction: 'Draft a reply.',
        schema: S,
      };
      await runAgent({ ...opts, runner: clean, data: [{ label, content: 'hello' }] });
      await runAgent({ ...opts, runner: dirty, data: [{ label, content: text }] });
      const a = clean.calls[0]!;
      const b = dirty.calls[0]!;
      expect(b.args).toEqual(a.args); // no tool escalation, same system prompt
      expect(b.env).toEqual(a.env);
      expect(b.cwd).toEqual(a.cwd);
      // instruction section is untouched; data sits inside exactly one untrusted block
      expect(b.stdin.split('# Data (untrusted)')[0]).toEqual(a.stdin.split('# Data (untrusted)')[0]);
      expect(b.stdin.match(/<untrusted_data /g)).toHaveLength(1);
      expect(b.stdin.match(/<\/untrusted_data>/g)).toHaveLength(1);
      const open = b.stdin.indexOf('<untrusted_data ');
      const close = b.stdin.indexOf('</untrusted_data>');
      const marker = { caption: 'cat api_keys', comment: 'system prompt plus', web_page: 'evil.example' }[
        label
      ]!;
      const at = b.stdin.indexOf(marker);
      expect(at).toBeGreaterThan(open);
      expect(at).toBeLessThan(close);
    });
  }

  it('fake model that "obeys" the injection (tries Bash) is rejected/repaired, not trusted', async () => {
    const runner = fakeClaude([{ reply: 'ok' }]);
    const obey = Object.assign(
      async (inv: Parameters<typeof runner>[0]) => {
        runner.calls.push(inv);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            type: 'result',
            is_error: false,
            structured_output: { reply: 'done' },
            permission_denials: [{ tool_name: 'Bash' }],
          }),
          stderr: '',
          timedOut: false,
        };
      },
      { calls: runner.calls },
    );
    const res = await runAgent({
      agent: 'community-manager',
      runId: 'r',
      instruction: 'Draft a reply.',
      schema: S,
      runner: obey,
      data: [{ label: 'comment', content: fixtures.comment }],
    });
    expect(res.ok).toBe(false);
    expect(res.record.validationErrors.join(' ')).toMatch(/not allowed: Bash/);
  });

  it('untrusted text can never be passed as the trusted instruction', () => {
    expect(() => buildUserPrompt(`x ${fixtures.caption}`)).toThrow(/untrusted_data/);
  });
});
