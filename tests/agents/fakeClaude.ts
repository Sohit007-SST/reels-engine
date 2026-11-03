import type { ClaudeInvocation, ClaudeProcessResult, ClaudeRunner } from '../../src/claude/runAgent';

export type FakeReply = unknown | { raw: string } | { cliError: string } | { timeout: true };

/** Envelope shaped like `claude -p --output-format json` (2.1.x). */
export function envelope(payload: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: typeof payload === 'string' ? payload : JSON.stringify(payload),
    structured_output: typeof payload === 'string' ? undefined : payload,
    modelUsage: { 'claude-fake-1': {} },
    permission_denials: [],
    ...extra,
  });
}

/** Fake runner: replies in order (last reply repeats); records every invocation. */
export function fakeClaude(replies: FakeReply[]): ClaudeRunner & { calls: ClaudeInvocation[] } {
  const calls: ClaudeInvocation[] = [];
  const fn = async (inv: ClaudeInvocation): Promise<ClaudeProcessResult> => {
    calls.push(inv);
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (r && typeof r === 'object' && 'timeout' in r)
      return { exitCode: null, stdout: '', stderr: '', timedOut: true };
    if (r && typeof r === 'object' && 'cliError' in r)
      return {
        exitCode: 1,
        stdout: JSON.stringify({
          type: 'result',
          is_error: true,
          result: (r as { cliError: string }).cliError,
        }),
        stderr: '',
        timedOut: false,
      };
    if (r && typeof r === 'object' && 'raw' in r)
      return { exitCode: 0, stdout: envelope((r as { raw: string }).raw), stderr: '', timedOut: false };
    return { exitCode: 0, stdout: envelope(r), stderr: '', timedOut: false };
  };
  return Object.assign(fn, { calls });
}

/** Fake runner keyed by agent name (read from the --system-prompt heading). */
export function fakeByAgent(map: Record<string, FakeReply[]>): ClaudeRunner & { calls: ClaudeInvocation[] } {
  const calls: ClaudeInvocation[] = [];
  const counters: Record<string, number> = {};
  const fn = async (inv: ClaudeInvocation): Promise<ClaudeProcessResult> => {
    calls.push(inv);
    const sys = inv.args[inv.args.indexOf('--system-prompt') + 1] ?? '';
    const agent = Object.keys(map).find((a) => sys.includes(`# ${a}`));
    if (!agent) throw new Error('fake: unknown agent');
    const i = (counters[agent] = (counters[agent] ?? -1) + 1);
    const list = map[agent] ?? [];
    const r = list[Math.min(i, list.length - 1)];
    return { exitCode: 0, stdout: envelope(r), stderr: '', timedOut: false };
  };
  return Object.assign(fn, { calls });
}
