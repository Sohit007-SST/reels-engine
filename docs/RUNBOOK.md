# Runbook

Short recipes for running Reels Engine. Keys are in `api_keys/.env` on your Mac; the same names are GitHub secrets.
Never paste a key into chat, an issue, a commit or a log.

## Pause and resume

- **Fastest:** send `/pause` to your Telegram bot. Send `/resume` to continue.
- **From GitHub:** repo -> Settings -> Secrets and variables -> Actions -> **Variables** -> set `PIPELINE_PAUSED` to `true` (back to `false` to resume).
- Every workflow checks the kill switch first (`.github/scripts/kill-switch.sh`), and the code checks `data/control.json` again before every external write. If `data/control.json` is unreadable, the system treats it as paused.

## Change mode

`PUBLISH_MODE` (`dry_run` -> `approval` -> `auto`), `REPLY_MODE`, `LEARNING_MODE`, `REELS_PER_DAY` are GitHub repository **variables**. The system never changes them by itself. Record every change in `progress/DECISIONS.md`.
After changing slot times in `brand/brand.json`, run `npx tsx src/cli/gen-publish-cron.ts` and commit `publish.yml` (CI fails if they drift).

## Check keys

```
npm run doctor            # MISSING / PRESENT only, no network
npm run doctor -- --live  # read-only checks: VALID / INVALID / EXPIRING
```

Results go to `progress/KEYS_STATUS.md`. Values are never printed.

## Rotate a key

1. Create the new key at the provider (see the M-step in `api_keys/03_YOUR_MANUAL_STEPS.md`).
2. Put it in `api_keys/.env` (or use `npm run setup:meta` / `npm run setup:telegram`).
3. Run `npm run doctor -- --live` and confirm VALID.
4. Update the GitHub secret: `gh secret set NAME` and paste the value at its hidden prompt (never put the value on the command line). Only names on the allowlist in `src/config.ts` belong on GitHub; `META_APP_SECRET`, `META_APP_ID` and `ANTHROPIC_API_KEY` never do.
5. Revoke the old key at the provider.

### If a key leaks

Send `/pause`, revoke the key at the provider immediately, then follow "If a key leaks" in `api_keys/02_PROGRESS_AND_KEYS.md` section 4.

## Renew the Claude token (yearly)

Redo M2 (`claude setup-token`), put the new value in `api_keys/.env` as `CLAUDE_CODE_OAUTH_TOKEN`, run `npm run doctor`, update the GitHub secret, then run `ci-spike.yml` by hand to confirm it works.

## Instagram token expired (error 190)

Redo M6, then `npm run setup:meta`. It asks for the short-lived token with hidden input, exchanges it for a long-lived Page token and writes `META_PAGE_ACCESS_TOKEN`, `FB_PAGE_ID` and `IG_USER_ID` to `api_keys/.env`. It only reads from Meta. Then update the GitHub secrets.

## Common errors

| Symptom                                 | Fix                                                                                                                                |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Workflow says "paused"                  | Check `PIPELINE_PAUSED` and `data/control.json`; send `/resume`                                                                    |
| Commit step fails after 3 tries         | Two workflows touched the same file. Re-run the workflow; never force-push                                                         |
| No AI images, plain backgrounds instead | Cloudflare free quota reached 85% or usage unknown; it resets at 00:00 UTC (see `data/usage.json`)                                 |
| No video clips                          | Hugging Face Space unavailable, quota used, or license not commercial-safe. The system falls back to animated images automatically |
| `paid provider refused`                 | Expected while `MAX_DAILY_SPEND_USD` is 0. See UPGRADE_TO_PAID.md                                                                  |
| Telegram silent                         | `npm run doctor -- --live`; redo `npm run setup:telegram` if `TELEGRAM_CHAT_ID` is MISSING                                         |
| CI gitleaks fails                       | A secret-looking string was committed. Remove it, rotate the key if real                                                           |

## Delete a post

Open Instagram -> the reel -> ... -> **Delete**. Then send `/pause` if the cause could repeat, and note it in `progress/DECISIONS.md`. The system never deletes posts by itself.

## Git hooks

`npm install` runs the `prepare` script, which points git at `.githooks/`. The pre-commit hook blocks `.env` files and runs `gitleaks` on staged changes (install it with `brew install gitleaks`).
