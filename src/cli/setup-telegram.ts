/**
 * `npm run setup:telegram` (manual step M8).
 *
 * 1. Reads recent updates with getUpdates (read-only; NO offset is sent, so nothing is
 *    acknowledged or consumed) and finds the private chat that messaged the bot.
 * 2. Writes TELEGRAM_CHAT_ID into api_keys/.env (mode 600; value never printed).
 * 3. Sends one notification-only test message to that chat (allowed in dry_run, no buttons).
 *
 * Docs (checked 2026-11-03): https://core.telegram.org/bots/api#getupdates , #sendmessage
 */
import path from 'node:path';
import { PROJECT_ROOT, loadConfig, requireSecret, type Config } from '../config';
import { getJson, postJson } from '../lib/http';
import { redact, registerSecret } from '../lib/redact';
import { isMainModule, promptTerminal, upsertEnvValues, type PromptFn } from './ops-shared';
import { SetupError } from './setup-meta';

const TIMEOUT_MS = 15_000;

interface TgChat {
  id?: number;
  type?: string;
  first_name?: string;
  username?: string;
}
interface TgUpdate {
  update_id?: number;
  message?: { chat?: TgChat; date?: number };
  callback_query?: { message?: { chat?: TgChat } };
}

export interface SetupTelegramDeps {
  cfg: Config;
  prompt: PromptFn;
  out: (line: string) => void;
  envFile: string;
  templateFile: string;
  /** Skip the test message (used by --no-test). */
  skipTestMessage?: boolean;
}

export const TEST_MESSAGE =
  'Reels Engine: setup test message. This chat is now the only one allowed to approve reels and control the pipeline. (Notification only; nothing was published.)';

/** Distinct private chats in update order (newest last). */
export function privateChats(updates: TgUpdate[]): TgChat[] {
  const seen = new Map<number, TgChat>();
  for (const u of updates) {
    const chat = u.message?.chat ?? u.callback_query?.message?.chat;
    if (chat?.id === undefined || chat.type !== 'private') continue;
    seen.delete(chat.id);
    seen.set(chat.id, chat);
  }
  return [...seen.values()];
}

export async function setupTelegram(
  deps: SetupTelegramDeps,
): Promise<{ chatName: string; testSent: boolean }> {
  const token = requireSecret(deps.cfg, 'TELEGRAM_BOT_TOKEN');
  const base = `https://api.telegram.org/bot${token}`;
  const res = await getJson<{ ok?: boolean; result?: TgUpdate[]; description?: string }>(
    `${base}/getUpdates`,
    {
      provider: 'telegram',
      purpose: 'setup_getUpdates',
      timeoutMs: TIMEOUT_MS,
      retry: { maxAttempts: 3, deadlineMs: 45_000 },
    },
  );
  if (!res.ok) throw new SetupError(`Telegram getUpdates failed: ${res.description ?? 'unknown error'}`);
  const chats = privateChats(res.result ?? []);
  if (chats.length === 0) {
    throw new SetupError(
      'No messages found. Open your bot in Telegram, press Start and send "hi" (M8 step 4), then run this again within 24 hours.',
    );
  }
  let chosen = chats[chats.length - 1] as TgChat;
  if (chats.length > 1) {
    deps.out('More than one person has messaged this bot. Pick YOUR chat:');
    chats.forEach((c, i) =>
      deps.out(`  ${i + 1}. ${c.first_name ?? '(no name)'}${c.username ? ` (@${c.username})` : ''}`),
    );
    const idx = Number(await deps.prompt(`Which one? (1-${chats.length}): `)) - 1;
    const pick = chats[idx];
    if (!Number.isInteger(idx) || !pick) throw new SetupError('Invalid choice; run setup:telegram again.');
    chosen = pick;
  }
  const chatId = String(chosen.id);
  registerSecret(chatId);
  await upsertEnvValues(deps.envFile, { TELEGRAM_CHAT_ID: chatId }, { templateFile: deps.templateFile });
  deps.out(`Saved TELEGRAM_CHAT_ID to ${path.relative(PROJECT_ROOT, deps.envFile)} (value not shown).`);

  let testSent = false;
  if (!deps.skipTestMessage) {
    await postJson(
      `${base}/sendMessage`,
      { chat_id: chatId, text: TEST_MESSAGE, disable_notification: false },
      {
        provider: 'telegram',
        purpose: 'setup_test_message',
        timeoutMs: TIMEOUT_MS,
        // Notification-only message to the owner: permitted in dry_run (spec 2.6).
        allowInDryRun: true,
        retry: false,
      },
    );
    testSent = true;
    deps.out('Test message sent. Check Telegram (M8 "Done when").');
  }
  return { chatName: chosen.first_name ?? '', testSent };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const cfg = loadConfig();
  await setupTelegram({
    cfg,
    prompt: promptTerminal,
    out: (l) => process.stdout.write(`${redact(l)}\n`),
    envFile: cfg.envFile,
    templateFile: path.join(PROJECT_ROOT, 'api_keys', '.env.example'),
    skipTestMessage: argv.includes('--no-test'),
  });
  return 0;
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(
        `setup:telegram failed: ${redact(err instanceof Error ? err.message : String(err))}\n`,
      );
      process.exitCode = 1;
    },
  );
}
