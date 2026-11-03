# Reels Engine

Reels Engine makes short educational Instagram Reels every day and posts them for you, at $0 a month.
It runs on GitHub Actions. You stay in control through a Telegram bot.

## How it works (plain language)

1. **Find ideas (05:17 IST).** It reads trends from free sources and your watchlist, then writes several ideas with strong opening lines (hooks).
2. **Write and check.** An AI writer turns the best ideas into short scripts. Every fact is checked; a reel with an unverified claim is not made.
3. **Make the video.** A free text-to-speech voice reads the script, captions are timed to every word, free AI images (Cloudflare) or simple animations are added, and Remotion renders a 1080x1920 MP4 with its own background music.
4. **Quality check.** Automatic checks (length, loudness, captions, safe zones, banned words, duplicates) plus an AI reviewer. Anything doubtful is held back.
5. **You approve (Telegram).** Around 06:00 IST you get a preview of each reel with **Approve** / **Reject** buttons.
6. **Post at the slot times.** `publish` posts only the exact video and caption you approved, at the times in `brand/brand.json`, then drafts comment replies.
7. **Learn (daily and weekly).** `analyze` reads Instagram insights and sends a daily report; `learn` proposes small improvements on Sundays. Nothing changes without your approval.

## Safety switches

| Switch                        | Where                                         | Default                                               |
| ----------------------------- | --------------------------------------------- | ----------------------------------------------------- |
| `PUBLISH_MODE`                | GitHub repo variable                          | `dry_run` (nothing is posted) -> `approval` -> `auto` |
| `PIPELINE_PAUSED`             | GitHub repo variable, or `/pause` in Telegram | `false`                                               |
| `MAX_DAILY_SPEND_USD`         | GitHub repo variable                          | `0` (paid providers cannot run)                       |
| `REPLY_MODE`, `LEARNING_MODE` | GitHub repo variables                         | `approval`, `propose`                                 |

## Keys

All keys live in `api_keys/.env` on your Mac (never committed; template: `api_keys/.env.example`).
Check them with `npm run doctor` (add `--live` for read-only checks against each service). It only ever prints MISSING / PRESENT / VALID / INVALID / EXPIRING, never a value, and writes `progress/KEYS_STATUS.md`.
Helpers: `npm run setup:meta` (Instagram publishing token, M6) and `npm run setup:telegram` (finds your chat id, M8).

## Everyday commands

| Command                               | What it does                                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `npm run doctor`                      | Key status (no network). `-- --live` for read-only validation                                                    |
| `npm run produce`                     | Make today's reels locally (dry run)                                                                             |
| `npm test`                            | All unit and mocked contract tests                                                                               |
| `npx tsx src/cli/gen-publish-cron.ts` | Regenerate the publish schedule after changing slots in `brand/brand.json` (`--check` = drift check, used by CI) |

## Workflows (`.github/workflows/`)

| File           | When (IST)                   | What                                                                     |
| -------------- | ---------------------------- | ------------------------------------------------------------------------ |
| `produce.yml`  | 05:17 daily                  | ideas -> scripts -> voice -> visuals -> render -> QA -> previews         |
| `publish.yml`  | slot times from `brand.json` | approved reels -> Instagram; comment replies                             |
| `analyze.yml`  | 23:23 daily                  | insights and the daily report                                            |
| `learn.yml`    | Sunday 22:07                 | weekly proposals                                                         |
| `ci.yml`       | every push                   | install, typecheck, lint, tests, gitleaks, drift checks, 2-second render |
| `ci-spike.yml` | manual                       | proves Claude + rendering work on GitHub and reports minutes             |

More: [docs/RUNBOOK.md](docs/RUNBOOK.md) (pause, resume, keys, common errors) and [docs/UPGRADE_TO_PAID.md](docs/UPGRADE_TO_PAID.md).
