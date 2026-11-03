import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AGENT_ENV_KEYS,
  AGENT_TOOLS,
  buildAgentEnv,
  buildClaudeArgs,
  runAgent,
} from '../../src/claude/runAgent';
import { FORBIDDEN_AGENT_TOOLS, loadAllAgentDefinitions, syncAgents } from '../../src/claude/agents';
import { AgentRunRecord } from '../../src/schemas';
import { fakeClaude } from './fakeClaude';

const S = z.strictObject({ answer: z.string().min(1) });
const base = { agent: 'hook-master' as const, runId: 'run-test', instruction: 'Answer.', schema: S };
const FAKE_ENV = {
  PATH: '/usr/bin',
  HOME: '/home/x',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-fake', // gitleaks:allow
  ANTHROPIC_API_KEY: 'sk-ant-fake', // gitleaks:allow
  META_ACCESS_TOKEN: 'EAAfake', // gitleaks:allow
  TELEGRAM_BOT_TOKEN: '123:fake', // gitleaks:allow
  CLOUDFLARE_API_TOKEN: 'cf-fake', // gitleaks:allow
  HF_TOKEN: 'hf_fake', // gitleaks:allow
  YOUTUBE_API_KEY: 'yt-fake', // gitleaks:allow
  GITHUB_TOKEN: 'ghp_fake', // gitleaks:allow
};

describe('runAgent', () => {
  it('accepts valid output on the first attempt and records it', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'agentrec-'));
    const runner = fakeClaude([{ answer: 'ok' }]);
    const res = await runAgent({ ...base, runner, recordPath: path.join(dir, 'r.json') });
    expect(res.ok).toBe(true);
    expect(res.output).toEqual({ answer: 'ok' });
    expect(res.record.attempts).toBe(1);
    expect(res.record.promptVersion).toMatch(/^hook-master@\d+$/);
    expect(res.record.model).toBe('claude-fake-1');
    AgentRunRecord.parse(JSON.parse(readFileSync(path.join(dir, 'r.json'), 'utf8')));
  });

  it('malformed JSON -> one repair with the validation errors -> accepted', async () => {
    const runner = fakeClaude([{ raw: 'Sure! {answer: oops' }, { answer: 'fixed' }]);
    const res = await runAgent({ ...base, runner });
    expect(res.ok).toBe(true);
    expect(res.record.attempts).toBe(2);
    expect(runner.calls[1]?.stdin).toContain('# Repair');
    expect(runner.calls[1]?.stdin).toMatch(/not valid JSON/);
  });

  it('schema-invalid twice -> rejected after exactly 2 attempts', async () => {
    const runner = fakeClaude([{ answer: '' }, { wrong: 1 }]);
    const res = await runAgent({ ...base, runner });
    expect(res.ok).toBe(false);
    expect(res.output).toBeNull();
    expect(runner.calls).toHaveLength(2);
    expect(res.record.valid).toBe(false);
    expect(res.record.validationErrors.length).toBeGreaterThan(0);
  });

  it('semantic validate() errors feed the repair prompt', async () => {
    const runner = fakeClaude([{ answer: 'bad' }, { answer: 'good' }]);
    const res = await runAgent({
      ...base,
      runner,
      validate: (o) => (o.answer === 'bad' ? ['answer must not be bad'] : []),
    });
    expect(res.ok).toBe(true);
    expect(runner.calls[1]?.stdin).toContain('answer must not be bad');
  });

  it('timeouts and CLI errors are rejected, auth errors are not retried', async () => {
    expect((await runAgent({ ...base, runner: fakeClaude([{ timeout: true }]) })).record.error).toMatch(
      /timed out/,
    );
    const auth = fakeClaude([{ cliError: 'Invalid API key · Please run /login' }]);
    const res = await runAgent({ ...base, runner: auth });
    expect(res.ok).toBe(false);
    expect(auth.calls.length).toBeLessThanOrEqual(2);
  });

  it('never accepts output carrying a credential-like value', async () => {
    const runner = fakeClaude([{ answer: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789' }]); // gitleaks:allow
    const res = await runAgent({ ...base, runner });
    expect(res.ok).toBe(false);
  });
});

describe('sanitized agent environment', () => {
  it('passes only Claude/OS keys, never platform keys or ANTHROPIC_API_KEY', async () => {
    const env = buildAgentEnv(FAKE_ENV);
    expect(Object.keys(env).every((k) => (AGENT_ENV_KEYS as readonly string[]).includes(k))).toBe(true);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-fake');
    for (const k of [
      'ANTHROPIC_API_KEY',
      'META_ACCESS_TOKEN',
      'TELEGRAM_BOT_TOKEN',
      'CLOUDFLARE_API_TOKEN',
      'HF_TOKEN',
      'YOUTUBE_API_KEY',
      'GITHUB_TOKEN',
    ])
      expect(env[k]).toBeUndefined();
    const runner = fakeClaude([{ answer: 'ok' }]);
    await runAgent({ ...base, runner, baseEnv: FAKE_ENV });
    const sent = runner.calls[0]!;
    expect(Object.keys(sent.env).sort()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'PATH']);
    const all = JSON.stringify(sent);
    for (const v of ['EAAfake', '123:fake', 'cf-fake', 'hf_fake', 'yt-fake', 'ghp_fake', 'sk-ant-fake'])
      expect(all).not.toContain(v);
  });
});

describe('CLI flags and tool allowlists', () => {
  it('never --bare; forbidden tools always disallowed; no-tool agents get an empty --tools', () => {
    const args = buildClaudeArgs({
      model: 'sonnet',
      maxTurns: 3,
      tools: [],
      systemPrompt: 's',
      jsonSchema: '{}',
    });
    expect(args).not.toContain('--bare');
    expect(args.slice(0, 3)).toEqual(['-p', '--output-format', 'json']);
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--disallowedTools') + 1]).toContain('Bash');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args).not.toContain('--allowedTools');
    expect(() =>
      buildClaudeArgs({ model: 'x', maxTurns: 1, tools: ['Bash'], systemPrompt: 's', jsonSchema: null }),
    ).toThrow();
  });

  it('Read is scoped to one directory', () => {
    const args = buildClaudeArgs({
      model: 'x',
      maxTurns: 1,
      tools: ['Read'],
      systemPrompt: 's',
      jsonSchema: null,
      readOnlyDir: '/tmp/frames',
    });
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read(//tmp/frames/**)');
  });

  it('agents/*.md agree with AGENT_TOOLS, carry promptVersion, use no forbidden tool', () => {
    const defs = loadAllAgentDefinitions();
    expect(defs.map((d) => d.name).sort()).toEqual(Object.keys(AGENT_TOOLS).sort());
    for (const d of defs) {
      expect(d.tools).toEqual([...AGENT_TOOLS[d.name]]);
      expect(d.promptVersion).toMatch(new RegExp(`^${d.name}@\\d+$`));
      expect(d.tools.some((t) => (FORBIDDEN_AGENT_TOOLS as readonly string[]).includes(t))).toBe(false);
      expect(d.body).toContain(`# ${d.name}`);
    }
  });

  it('.claude/agents has no drift from agents/ (run npm run agents:sync)', async () => {
    const res = await syncAgents({ check: true });
    expect(res.drifted).toEqual([]);
    expect(res.orphans).toEqual([]);
  });
});
