import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import {
  collectRows,
  finalStatus,
  renderConsole,
  renderKeysStatus,
  type Validator,
} from '../../src/cli/doctor';

const FAKE = {
  TELEGRAM_BOT_TOKEN: '123456:FAKE-telegram-token-value-abcdef',
  CLOUDFLARE_API_TOKEN: 'fake-cloudflare-token-0123456789abcdef',
  CLOUDFLARE_ACCOUNT_ID: 'fakeaccount0123456789',
  META_PAGE_ACCESS_TOKEN: 'EAAFAKEpagetoken0123456789abcdefghijkl',
};
const cfg = () => loadConfig({ envFile: '/nonexistent/.env', env: { ...FAKE } });
const now = new Date('2026-11-03T10:00:00Z');

describe('doctor finalStatus', () => {
  it('maps presence and validation to statuses', () => {
    expect(finalStatus(false, undefined, now).status).toBe('MISSING');
    expect(finalStatus(true, undefined, now).status).toBe('PRESENT');
    expect(finalStatus(true, { status: 'UNKNOWN' }, now).status).toBe('PRESENT');
    expect(finalStatus(true, { status: 'INVALID' }, now).status).toBe('INVALID');
    expect(finalStatus(true, { status: 'VALID', expiresAt: null }, now).status).toBe('VALID');
    expect(finalStatus(true, { status: 'VALID', expiresAt: '2026-11-10T00:00:00Z' }, now).status).toBe(
      'EXPIRING',
    );
    expect(finalStatus(true, { status: 'VALID', expiresAt: '2027-06-01T00:00:00Z' }, now).status).toBe(
      'VALID',
    );
    expect(finalStatus(true, { status: 'VALID', expiresAt: '2026-11-01T00:00:00Z' }, now).status).toBe(
      'INVALID',
    );
  });
});

describe('doctor collectRows', () => {
  it('without --live reports only PRESENT/MISSING and never runs validators', async () => {
    let called = 0;
    const v: Validator = async () => {
      called++;
      return { TELEGRAM_BOT_TOKEN: { status: 'VALID' } };
    };
    const rows = await collectRows({ cfg: cfg(), live: false, validators: { v }, githubNames: null, now });
    expect(called).toBe(0);
    const by = Object.fromEntries(rows.map((r) => [r.key, r.status]));
    expect(by.TELEGRAM_BOT_TOKEN).toBe('PRESENT');
    expect(by.META_APP_SECRET).toBe('MISSING');
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(['PRESENT', 'MISSING']));
  });

  it('with --live uses mocked validators; a throwing validator never marks VALID', async () => {
    const ok: Validator = async () => ({
      TELEGRAM_BOT_TOKEN: { status: 'VALID', note: '@fakebot' },
      META_PAGE_ACCESS_TOKEN: { status: 'VALID', expiresAt: '2026-11-08T00:00:00Z' },
      CLOUDFLARE_API_TOKEN: { status: 'INVALID', note: 'token not active' },
    });
    const boom: Validator = async () => {
      throw new Error(`network down ${FAKE.CLOUDFLARE_ACCOUNT_ID}`);
    };
    const rows = await collectRows({
      cfg: cfg(),
      live: true,
      validators: { ok, boom },
      githubNames: new Set(['TELEGRAM_BOT_TOKEN']),
      now,
    });
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.TELEGRAM_BOT_TOKEN?.status).toBe('VALID');
    expect(by.TELEGRAM_BOT_TOKEN?.inGithub).toBe('yes');
    expect(by.META_PAGE_ACCESS_TOKEN?.status).toBe('EXPIRING');
    expect(by.CLOUDFLARE_API_TOKEN?.status).toBe('INVALID');
    expect(by.CLOUDFLARE_ACCOUNT_ID?.status).toBe('PRESENT');
    expect(by.META_APP_SECRET?.inGithub).toBe('never');

    const text = renderKeysStatus(rows, { now, live: true, cfg: cfg() }) + renderConsole(rows);
    for (const value of Object.values(FAKE)) expect(text).not.toContain(value);
    expect(text).toContain('TELEGRAM_BOT_TOKEN');
  });
});
