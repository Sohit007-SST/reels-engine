/**
 * Telegram Bot API client (T7.3). Owner-only (TELEGRAM_CHAT_ID), bound + expiring +
 * replay-safe approvals (callback data <= 64 bytes, see src/state/approvals.ts).
 *
 * Docs read 2026-11-03: https://core.telegram.org/bots/api
 *  - getUpdates(offset, timeout, allowed_updates); unread updates are kept at most 24 hours
 *  - InlineKeyboardButton.callback_data: 1-64 bytes; CallbackQuery {id, from, message, data}
 *  - sendVideo: caption 0-1024 chars; bots may upload up to 50 MB
 *  - clients show a progress bar until answerCallbackQuery is called
 *
 * dry_run: previews are labeled DRY RUN and carry NO buttons; they and plain notifications are
 * notification-only and use http allowInDryRun:true. Previews WITH buttons are normal writes.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { httpRequest } from '../lib/http';
import type { Approval } from '../schemas';
import { encodeCallback } from '../state/approvals';

export interface TelegramConfig {
  botToken: string;
  ownerChatId: string;
  dryRun: boolean;
  timeoutMs?: number;
  /** Override for tests. */
  baseUrl?: string;
  /** Compress a large MP4 to a 720p preview; returns the new path (default: ffmpeg). */
  compress?: (input: string) => Promise<string>;
  /** Directory for compressed previews (default: alongside the input). */
  previewDir?: string;
}

export interface TelegramUpdate {
  updateId: number;
  /** Sender's chat/user id (owner check compares this to TELEGRAM_CHAT_ID). */
  chatId: string;
  kind: 'message' | 'callback';
  text: string | null;
  callbackData: string | null;
  callbackQueryId: string | null;
}

export type TelegramCommand = '/status' | '/pause' | '/resume' | '/report';

export interface TelegramClient {
  notify(text: string): Promise<void>;
  sendPreview(input: {
    videoPath: string;
    caption: string;
    reelId: string;
    approval: Approval | null;
  }): Promise<{ messageId: number }>;
  /** Text approval request with bound Approve/Reject buttons (replies, learning). No buttons in dry_run. */
  sendApprovalRequest?(text: string, approval: Approval): Promise<{ messageId: number }>;
  getUpdates(offset?: number): Promise<TelegramUpdate[]>;
  answerCallback(callbackQueryId: string, text: string): Promise<void>;
}

/** Callback data format: "<a|r>:<reelId>:<versionHash>:<nonce>:<expiryEpochMin>" (<= 64 bytes). */
export function encodeApprovalCallback(approval: Approval, action: 'approve' | 'reject'): string {
  return encodeCallback(approval, action);
}

export const MAX_DIRECT_VIDEO_BYTES = 45 * 1024 * 1024;
export const MAX_CAPTION_CHARS = 1024;
export const MAX_MESSAGE_CHARS = 4096;
export const DRY_RUN_LABEL = 'DRY RUN';

const execFileAsync = promisify(execFile);

/** ffmpeg 720p re-encode (bounded by a 5-minute timeout). */
export async function compressTo720p(input: string, outDir?: string): Promise<string> {
  const dir = outDir ?? path.dirname(input);
  await fs.mkdir(dir, { recursive: true });
  const out = path.join(dir, `${path.basename(input, path.extname(input))}.preview720.mp4`);
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-v',
      'error',
      '-i',
      input,
      '-vf',
      'scale=-2:1280',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '30',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      out,
    ],
    { timeout: 300_000 },
  );
  return out;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function previewCaption(caption: string, reelId: string, dryRun: boolean, expiresAt?: string): string {
  const head = dryRun
    ? `${DRY_RUN_LABEL} preview · ${reelId} · no approval needed (nothing will be posted)`
    : `Approve ${reelId}?${expiresAt ? ` (expires ${expiresAt})` : ''}`;
  return clip(`${head}\n\n${caption}`, MAX_CAPTION_CHARS);
}

export function createTelegramClient(cfg: TelegramConfig): TelegramClient {
  if (!cfg.botToken) throw new Error('Telegram client needs a bot token');
  if (!/^-?\d+$/.test(cfg.ownerChatId)) throw new Error('Telegram owner chat id must be numeric');
  const base = `${cfg.baseUrl ?? 'https://api.telegram.org'}/bot${cfg.botToken}`;
  const timeoutMs = cfg.timeoutMs ?? 20_000;

  async function call<T>(
    method: string,
    body: unknown,
    opts: { allowInDryRun: boolean; isWrite?: boolean; timeoutMs?: number; retry?: boolean },
  ): Promise<T> {
    const res = await httpRequest(`${base}/${method}`, {
      method: 'POST',
      provider: 'telegram',
      purpose: method,
      body,
      timeoutMs: opts.timeoutMs ?? timeoutMs,
      allowInDryRun: opts.allowInDryRun,
      ...(opts.isWrite !== undefined ? { isWrite: opts.isWrite } : {}),
      retry: opts.retry === false ? false : { maxAttempts: 3, deadlineMs: 45_000 },
    });
    const j = await res.json<{ ok?: boolean; result?: T; description?: string }>();
    if (j.ok !== true) throw new Error(`telegram ${method} not ok`);
    return j.result as T;
  }

  return {
    async notify(text) {
      const body = clip(cfg.dryRun ? `[${DRY_RUN_LABEL}] ${text}` : text, MAX_MESSAGE_CHARS);
      // Notification-only: allowed in dry_run and while paused (alerts must still reach the owner).
      await call(
        'sendMessage',
        { chat_id: cfg.ownerChatId, text: body, disable_web_page_preview: true },
        { allowInDryRun: true },
      );
    },

    async sendPreview(input) {
      const withButtons = !cfg.dryRun && input.approval !== null;
      let videoPath = input.videoPath;
      const st = await fs.stat(videoPath);
      if (st.size > MAX_DIRECT_VIDEO_BYTES) {
        videoPath = await (cfg.compress ?? ((p) => compressTo720p(p, cfg.previewDir)))(videoPath);
      }
      const bytes = await fs.readFile(videoPath);
      const form = new FormData();
      form.append('chat_id', cfg.ownerChatId);
      form.append(
        'caption',
        previewCaption(
          input.caption,
          input.reelId,
          cfg.dryRun,
          withButtons ? input.approval?.expiresAt : undefined,
        ),
      );
      form.append('supports_streaming', 'true');
      form.append('video', new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }), `${input.reelId}.mp4`);
      if (withButtons && input.approval) {
        form.append(
          'reply_markup',
          JSON.stringify({
            inline_keyboard: [
              [
                { text: 'Approve', callback_data: encodeApprovalCallback(input.approval, 'approve') },
                { text: 'Reject', callback_data: encodeApprovalCallback(input.approval, 'reject') },
              ],
            ],
          }),
        );
      }
      const r = await call<{ message_id?: number }>('sendVideo', form, {
        allowInDryRun: !withButtons,
        timeoutMs: Math.max(timeoutMs, 120_000),
        retry: false,
      });
      return { messageId: typeof r.message_id === 'number' ? r.message_id : 0 };
    },

    async sendApprovalRequest(text, approval) {
      const withButtons = !cfg.dryRun;
      const body: Record<string, unknown> = {
        chat_id: cfg.ownerChatId,
        text: clip(cfg.dryRun ? `[${DRY_RUN_LABEL}] ${text}` : text, MAX_MESSAGE_CHARS),
        disable_web_page_preview: true,
      };
      if (withButtons) {
        body.reply_markup = {
          inline_keyboard: [
            [
              { text: 'Approve', callback_data: encodeApprovalCallback(approval, 'approve') },
              { text: 'Reject', callback_data: encodeApprovalCallback(approval, 'reject') },
            ],
          ],
        };
      }
      const r = await call<{ message_id?: number }>('sendMessage', body, { allowInDryRun: !withButtons });
      return { messageId: typeof r.message_id === 'number' ? r.message_id : 0 };
    },

    async getUpdates(offset) {
      const qs = new URLSearchParams({
        timeout: '0',
        allowed_updates: JSON.stringify(['message', 'callback_query']),
      });
      if (offset !== undefined) qs.set('offset', String(offset));
      const res = await httpRequest(`${base}/getUpdates?${qs.toString()}`, {
        method: 'GET',
        provider: 'telegram',
        purpose: 'getUpdates',
        timeoutMs,
      });
      const j = await res.json<{ ok?: boolean; result?: Array<Record<string, unknown>> }>();
      if (j.ok !== true) throw new Error('telegram getUpdates not ok');
      return parseUpdates(j.result ?? []);
    },

    async answerCallback(callbackQueryId, text) {
      await call(
        'answerCallbackQuery',
        { callback_query_id: callbackQueryId, text: clip(text, 190) },
        { allowInDryRun: true },
      );
    },
  };
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | null => (v && typeof v === 'object' ? (v as Obj) : null);
const idStr = (v: unknown): string | null =>
  typeof v === 'number' && Number.isFinite(v)
    ? String(v)
    : typeof v === 'string' && /^-?\d+$/.test(v)
      ? v
      : null;

/** Parse raw updates. The sender id is the user who sent the message / pressed the button. */
export function parseUpdates(raw: Array<Record<string, unknown>>): TelegramUpdate[] {
  const out: TelegramUpdate[] = [];
  for (const u of raw) {
    const updateId = u.update_id;
    if (typeof updateId !== 'number') continue;
    const cq = asObj(u.callback_query);
    const msg = asObj(u.message);
    if (cq) {
      const from = asObj(cq.from);
      const chatId = idStr(from?.id);
      out.push({
        updateId,
        chatId: chatId ?? 'unknown',
        kind: 'callback',
        text: null,
        callbackData: typeof cq.data === 'string' ? cq.data : null,
        callbackQueryId: typeof cq.id === 'string' ? cq.id : null,
      });
    } else if (msg) {
      const from = asObj(msg.from);
      const chat = asObj(msg.chat);
      const chatId = idStr(from?.id) ?? idStr(chat?.id);
      out.push({
        updateId,
        chatId: chatId ?? 'unknown',
        kind: 'message',
        text: typeof msg.text === 'string' ? msg.text : null,
        callbackData: null,
        callbackQueryId: null,
      });
    } else {
      out.push({
        updateId,
        chatId: 'unknown',
        kind: 'message',
        text: null,
        callbackData: null,
        callbackQueryId: null,
      });
    }
  }
  return out.sort((a, b) => a.updateId - b.updateId);
}
