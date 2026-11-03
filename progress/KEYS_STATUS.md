# Keys status — last checked 2026-11-04 02:22 IST IST

Written by `npm run doctor`. Values are never shown here. Live read-only checks were run (`npm run doctor -- --live`).

| Variable                | In .env | In GitHub   | Status   | Expires / renew by | Note |
|-------------------------|---------|-------------|----------|--------------------|------|
| CLAUDE_CODE_OAUTH_TOKEN | yes     | not checked | PRESENT  | —                  | no read-only check; proven by ci-spike (T1.7); renew yearly (M2) |
| META_APP_ID             | no      | never       | MISSING  | —                  |  |
| META_APP_SECRET         | no      | never       | MISSING  | —                  |  |
| META_PAGE_ACCESS_TOKEN  | no      | not checked | MISSING  | —                  |  |
| FB_PAGE_ID              | no      | not checked | MISSING  | —                  |  |
| IG_USER_ID              | no      | not checked | MISSING  | —                  |  |
| CLOUDFLARE_ACCOUNT_ID   | no      | not checked | MISSING  | —                  |  |
| CLOUDFLARE_API_TOKEN    | no      | not checked | MISSING  | —                  |  |
| TELEGRAM_BOT_TOKEN      | no      | not checked | MISSING  | —                  |  |
| TELEGRAM_CHAT_ID        | no      | not checked | MISSING  | —                  |  |
| YOUTUBE_API_KEY         | no      | not checked | MISSING  | —                  | optional |
| HF_TOKEN                | no      | not checked | MISSING  | —                  | optional |
| ANTHROPIC_API_KEY       | no      | never       | MISSING  | —                  | optional, paid (M18): keep unset |

## Settings (not secret)

- PUBLISH_MODE: dry_run · REPLY_MODE: approval · LEARNING_MODE: propose
- PIPELINE_PAUSED: false · REELS_PER_DAY: 3 · META_GRAPH_VERSION: (not set)
- IMAGE_PROVIDER: cloudflare · VIDEO_PROVIDER: hf_free · TTS_PROVIDER: kokoro · MAX_DAILY_SPEND_USD: 0
- GitHub secret allowlist: CLAUDE_CODE_OAUTH_TOKEN, META_PAGE_ACCESS_TOKEN, FB_PAGE_ID, IG_USER_ID, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, YOUTUBE_API_KEY, HF_TOKEN
