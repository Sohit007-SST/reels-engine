# Owner steps: what you do next

This is a plain-language checklist. Do the steps in order. Full details for every "M" step are in `api_keys/03_YOUR_MANUAL_STEPS.md`.

**Golden rules**

- Type keys only into `api_keys/.env` or into a setup script's prompt in Terminal. **Never paste a key into the Claude chat.**
- Right now the system is in `PUBLISH_MODE=dry_run`: it never posts, comments or sends anything. Only you can change that.
- All commands below are typed in Terminal inside the project folder: `cd ~/Desktop/instagram_project`

---

## Step 1. Confirm or change the default decisions

Claude used these defaults because you said "just build". Open `progress/DECISIONS.md` to read each one. Tell Claude "I confirm all decisions", or name the ones you want changed (for example "DEC-006: 2 reels a day").

| ID      | Decision                 | Default used                                                                                      |
| ------- | ------------------------ | ------------------------------------------------------------------------------------------------- |
| DEC-001 | Niche and audience       | "What if" science and history (space, ancient worlds, Earth), English-speaking viewers aged 18–34 |
| DEC-002 | Voiceover language       | English, voice `af_heart`                                                                         |
| DEC-003 | Instagram handle         | Not chosen yet; a new account (you pick the name)                                                 |
| DEC-004 | Where it runs            | GitHub Actions (free), confirmed after a test run                                                 |
| DEC-005 | GitHub repo visibility   | Private                                                                                           |
| DEC-006 | Reels per day            | 3 (08:30, 13:00, 19:30 IST), final number after staging                                           |
| DEC-007 | Publishing approval      | You approve each reel in Telegram; for now `dry_run` (no posting)                                 |
| DEC-008 | Comment replies          | Drafts go to you for approval                                                                     |
| DEC-009 | Weekly learning          | Proposes changes; you approve them                                                                |
| DEC-010 | Mascot narrator          | Yes, an original cartoon character                                                                |
| DEC-011 | Main feed vs trial reels | All main feed in week 1; trial reels later                                                        |
| DEC-012 | Data retention           | Videos kept 3 days or until posted; logs 30 days                                                  |
| DEC-013 | Where keys live          | `api_keys/.env` (never uploaded to git)                                                           |

**What Claude does next:** it records your answers in `progress/DECISIONS.md` and updates the brand files if anything changed.

## Step 2. Create your private key file (do this first, once)

Run in Terminal:

```
cp api_keys/.env.example api_keys/.env && chmod 600 api_keys/.env
```

This makes an empty key file only you can read. Claude is blocked from opening it. To edit it later: `open -e api_keys/.env`, paste each value after the `=` sign, with no quotes or spaces, then save.

## Step 3. Get your keys and paste them into `api_keys/.env`

Do them in this order. All are free.

| #   | Variable in `api_keys/.env`                          | What it is for                                     | Where to get it                                                                                                                      | Manual step |
| --- | ---------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| 1   | `CLAUDE_CODE_OAUTH_TOKEN`                            | Lets the daily automation use Claude               | Run `claude setup-token` in Terminal, copy the token                                                                                 | M2          |
| 2   | (no key) Instagram professional account              | Needed for posting                                 | Instagram app → Settings → Account type → Professional                                                                               | M3          |
| 3   | (no key) Facebook Page linked to Instagram           | Meta requires it                                   | Facebook → create a Page → link your Instagram                                                                                       | M4          |
| 4   | `META_APP_ID`, `META_APP_SECRET`                     | Your Meta developer app                            | developers.facebook.com → My Apps → Create app → App settings → Basic                                                                | M5          |
| 5   | `META_PAGE_ACCESS_TOKEN`, `FB_PAGE_ID`, `IG_USER_ID` | Posting, insights, comments                        | Get a user token in the Graph API Explorer, then run `npm run setup:meta` (it asks you to paste it and fills these three in for you) | M6          |
| 6   | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`      | Free AI images (needed for reels to look on-brand) | dash.cloudflare.com → Workers AI → account ID; My Profile → API Tokens → create a "Workers AI" token                                 | M7          |
| 7   | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`             | Previews, approve buttons, pause button            | Telegram → talk to @BotFather → `/newbot` → copy the token; then run `npm run setup:telegram` (fills in the chat ID)                 | M8          |
| 8   | `YOUTUBE_API_KEY` (optional)                         | Extra trend source                                 | console.cloud.google.com → enable YouTube Data API v3 → Credentials → API key                                                        | M9          |
| 9   | `HF_TOKEN` (optional)                                | Free AI video clips (best effort)                  | huggingface.co → Settings → Access Tokens → read token                                                                               | M10         |
| 10  | (no key) GitHub login                                | Runs the daily automation                          | Run `gh auth login` and follow the prompts                                                                                           | M11         |

Settings like `PUBLISH_MODE=dry_run` are already filled in the template. Leave them as they are.

## Step 4. Run these commands after adding keys

1. `npm run doctor` shows each key as MISSING, PRESENT, VALID, INVALID or EXPIRING. It never shows the values. `npm run doctor -- --live` also tests the keys.
2. `npm run setup:meta`: paste the Meta token when it asks (M6).
3. `npm run setup:telegram`: send any message to your bot first, then run this (M8).
4. `gh auth login`: log in to GitHub (M11).

**Tell Claude:** "Keys added, doctor says …" and paste the doctor **status lines** (they contain no secrets).
**What Claude does next:** read-only Instagram checks (T1.6), creating the private GitHub repo and test workflow (T1.7), then it shows you the exact list of secrets and asks you before uploading them (T7.1).

## Step 5. Review the first reel

Open this video: `out/2026-11-03-90/reel.mp4` (Finder → Desktop → instagram_project → out → 2026-11-03-90). Its QA reports are in the same folder.

Be aware:

- Sound and technical checks passed: −14 LUFS loudness, 1080x1920, captions within 50 ms of the voice.
- The real Claude visual reviewer **failed** it as "not on brand": the scenes are text only, with no illustrations. This is expected until Cloudflare images (step 3, row 6) are added.

**Tell Claude:** "Approved", or what to change (voice, speed, colours, fonts, music, mascot).
**What Claude does next:** applies your changes, generates illustrated sample reels for each format once the Cloudflare key works (T3.4, T3.8), then runs a 3-reel dry run (T4.8) for you to review again.

## Step 6. Later steps (Claude will ask you at each one)

- **M12:** confirm the list of accounts to watch for trends.
- **M14:** approve the first real test post. Claude shows you the video, caption and QA report and asks "Publish this test reel now?"
- **M15:** after 3 clean days of staging, choose the reels per day and switch from `dry_run` to `approval`.
- **Emergency stop:** send `/pause` to your Telegram bot, and `/resume` to restart.

---

## Built and verified vs not yet

| Area                                                    | Status                         | How it was checked                                                                     |
| ------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------- |
| Project setup, settings and key checker (doctor)        | Built and verified             | 364 automated tests pass; type and style checks are clean                              |
| Key safety (no key in logs, git or agents)              | Built and verified             | Secret scanner is clean on all files and the git history; redaction and security tests |
| Voice, captions, music and video render                 | Built and verified on this Mac | First reel made: out/2026-11-03-90/reel.mp4                                            |
| Automatic quality checks (technical, facts, copying)    | Built and verified             | Deliberately broken test videos and scripts are all caught                             |
| Visual look of reels                                    | Not yet                        | Real reviewer says "not on brand" until AI images exist (needs Cloudflare key)         |
| Claude agents (trends, hooks, scripts, visuals, review) | Built and run on this Mac      | One full dry run; 0 external writes                                                    |
| Queue, crash recovery, no double posting                | Built and verified (simulated) | Crash and duplicate tests                                                              |
| Instagram posting                                       | Built, not yet live            | Simulated tests only; needs your Meta keys (M3–M6)                                     |
| Telegram approvals and pause button                     | Built, not yet live            | Simulated tests only; needs bot token (M8)                                             |
| Daily automation on GitHub                              | Built, not yet run             | Needs GitHub login and Claude token (M2, M11)                                          |
| Insights, weekly learning, comment replies              | Built, not yet live            | Simulated tests only; needs real posts                                                 |
| Restore drill and final sign-off                        | Not yet                        | After staging                                                                          |

The full record is in `progress/PROGRESS.md`.
