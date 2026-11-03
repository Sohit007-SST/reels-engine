import { describe, expect, it } from 'vitest';
import { planSecrets } from '../../src/cli/github-secrets';

describe('github secrets upload plan', () => {
  it('refuses names outside the allowlist (META_APP_SECRET never goes to GitHub)', () => {
    const plan = planSecrets(['META_APP_SECRET', 'META_APP_ID', 'ANTHROPIC_API_KEY'], {
      META_APP_SECRET: 'x',
      META_APP_ID: 'y',
      ANTHROPIC_API_KEY: 'z',
    });
    expect(plan.map((r) => r.action)).toEqual(['refused', 'refused', 'refused']);
  });
  it('uploads present allowlisted keys and reports blank ones as missing', () => {
    const plan = planSecrets(['CLAUDE_CODE_OAUTH_TOKEN', 'TELEGRAM_BOT_TOKEN'], {
      CLAUDE_CODE_OAUTH_TOKEN: 'fake-value',
      TELEGRAM_BOT_TOKEN: '   ',
    });
    expect(plan).toEqual([
      { name: 'CLAUDE_CODE_OAUTH_TOKEN', action: 'upload' },
      { name: 'TELEGRAM_BOT_TOKEN', action: 'missing' },
    ]);
  });
  it('the plan never contains values', () => {
    const plan = planSecrets(['CLAUDE_CODE_OAUTH_TOKEN'], { CLAUDE_CODE_OAUTH_TOKEN: 'sk-secret-123' });
    expect(JSON.stringify(plan)).not.toContain('sk-secret-123');
  });
});
