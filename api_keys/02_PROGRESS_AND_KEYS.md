# Where Progress and API Keys Are Stored

Version 1.1 · Companion to `01_CLAUDE_CODE_PROMPT.md`. Claude Code must follow this file exactly; you (Sohit) can use it to find anything.

## 1. The short version

- **API keys** go in two places only:
  1. `.env`, a file in the project folder on your Mac. It is never uploaded to GitHub, and Claude Code is blocked from reading it.
  2. **GitHub repository secrets** (repo → Settings → Secrets and variables → Actions), so the daily automation can use them. Only an exact allowlist goes there (section 4).
- **Progress** lives in the `progress/` folder. It is committed to git, so every version is kept and nothing is lost.
- Claude Code reads the progress files at the start of every session and updates them after every task, with evidence. The daily automation writes a report there every day.
- Key **values** never appear anywhere else: not in progress files, reports, logs, commits or chat, not even the last few characters. Progress files record only *whether* a key is set and working.

## 2. Folder map

```
reels-engine/
├─ .env                     ← your real keys (local only, gitignored, unreadable to Claude)   written by: you / setup scripts
├─ .env.example             ← every key name with a comment, no values                     written by: Claude Code
├─ .claude/settings.json    ← blocks Claude Code from reading .env                         written by: Claude Code
├─ CLAUDE.md                ← rules Claude Code loads automatically                         written by: Claude Code
├─ progress/
│  ├─ PROGRESS.md           ← gates, every task, status, evidence, summaries                written by: Claude Code
│  ├─ DECISIONS.md          ← decision records + mode-change log                            written by: Claude Code (with you)
│  ├─ MANUAL_TASKS.md       ← your to-do list (things only you can do)                       written by: Claude Code; you tick
│  ├─ KEYS_STATUS.md        ← which keys are set and working (never values)                  written by: `npm run doctor`
│  ├─ CAPABILITIES.md       ← what each outside service can really do, and how we know       written by: Claude Code
│  ├─ RISKS.md              ← known risks and whether they're handled                        written by: Claude Code
│  └─ runs/
│     ├─ 2026-11-05.md      ← daily automation report                                       written by: the pipeline
│     └─ week-2026-45.md    ← weekly learning report and proposals                          written by: the pipeline
├─ data/                    ← machine state (JSON): trends, specs, queue, ledger, approvals, metrics, usage
└─ brand/                   ← brand bible, hook leaderboard, playbook, watchlist
```

## 3. Every API key: what it is, where it's stored

| Variable | What it's for | How to get it | In `.env` | In GitHub secrets | Required? | Expires |
|---|---|---|---|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude (the brain) in the daily automation | Manual step M2 (`claude setup-token`) | Optional (your normal login works on the Mac) | Yes | Yes, for automation | 1 year; renew yearly |
| `META_APP_ID` | Your Meta developer app | M5 | Yes | No (setup only) | Yes, for setup | Never |
| `META_APP_SECRET` | Exchanging tokens during setup | M5 | Yes | **Never** | Yes, for setup | Only if you reset it |
| `META_PAGE_ACCESS_TOKEN` | Publishing, insights, comments, trend scanning | M6 + `npm run setup:meta` | Yes | Yes | Yes | Normally doesn't expire; breaks if you change your Facebook password or reset the app (redo M6). Verified lifetime recorded in `CAPABILITIES.md`. |
| `FB_PAGE_ID` | Your Facebook Page linked to Instagram | M6 (filled in by the setup script) | Yes | Yes | Yes | Never |
| `IG_USER_ID` | Your Instagram professional account's ID | M6 (filled in by the setup script) | Yes | Yes | Yes | Never |
| `CLOUDFLARE_ACCOUNT_ID` | Free AI images | M7 | Yes | Yes | Yes, for AI images | Never |
| `CLOUDFLARE_API_TOKEN` | Free AI images | M7 | Yes | Yes | Yes, for AI images | Whatever you choose when creating it |
| `TELEGRAM_BOT_TOKEN` | Previews, approvals, reports, pause button | M8 | Yes | Yes | Strongly recommended | Never (unless revoked) |
| `TELEGRAM_CHAT_ID` | The only chat allowed to approve and control | M8 (`npm run setup:telegram`) | Yes | Yes | With Telegram | Never |
| `YOUTUBE_API_KEY` | YouTube Shorts trend source | M9 | Yes | Yes, if used | Optional | Never (unless deleted) |
| `HF_TOKEN` | Free AI video clips (best effort) | M10 | Yes | Yes, if used | Optional | Never (unless revoked) |
| `GITHUB_TOKEN` | Workflows committing state | Automatic in GitHub Actions | No | Automatic | Automatic | n/a |

**Settings that are not secret** (in `.env` locally, and as GitHub repository *variables*):

| Variable | Default | Meaning |
|---|---|---|
| `PUBLISH_MODE` | `dry_run` | `dry_run` (zero external writes) → `approval` (you tap Approve) → `auto`. Changes only when you say so. |
| `REPLY_MODE` | `approval` | `off`, `approval` (drafts to Telegram) or `auto` (needs your explicit OK) |
| `LEARNING_MODE` | `propose` | `propose` (you approve changes) or `bounded_auto` (small, reversible changes applied automatically) |
| `REELS_PER_DAY` | `3` | Reels produced daily; final value set after staging measurements |
| `PIPELINE_PAUSED` | `false` | Kill switch |
| `TIMEZONE` | `Asia/Kolkata` | All schedules in IST |
| `META_GRAPH_VERSION` | set in T1.6 | Graph API version in use, from Meta's changelog |
| `IMAGE_PROVIDER` | `cloudflare` | `cloudflare` or `none` |
| `VIDEO_PROVIDER` | `hf_free` | `none`, `hf_free`; later `veo` or `kling` (paid) |
| `TTS_PROVIDER` | `kokoro` | Later `elevenlabs` (paid) |
| `CLAUDE_MODEL` | empty | Optional lighter model alias for routine agents |
| `MAX_DAILY_SPEND_USD` | `0` | Paid providers refuse to run while this is 0 |
| `ARTIFACT_RETENTION_DAYS` | `3` | How long rendered videos are kept before publishing |

### `.env.example` (Claude Code creates this file exactly)

```bash
# ===== Claude (brain) =====
CLAUDE_CODE_OAUTH_TOKEN=        # from `claude setup-token` (M2). On your Mac, your normal Claude login also works.
CLAUDE_MODEL=                   # optional lighter model alias for routine agents

# ===== Meta / Instagram (Instagram API with Facebook Login) =====
META_APP_ID=                    # M5 — setup only
META_APP_SECRET=                # M5 — setup only, NEVER uploaded to GitHub
META_GRAPH_VERSION=             # set from Meta's changelog during T1.6
META_PAGE_ACCESS_TOKEN=         # written by `npm run setup:meta` (M6)
FB_PAGE_ID=                     # written by `npm run setup:meta`
IG_USER_ID=                     # written by `npm run setup:meta`

# ===== Cloudflare Workers AI (free AI images) =====
CLOUDFLARE_ACCOUNT_ID=          # M7
CLOUDFLARE_API_TOKEN=           # M7

# ===== Telegram (previews, approvals, reports) =====
TELEGRAM_BOT_TOKEN=             # M8
TELEGRAM_CHAT_ID=               # written by `npm run setup:telegram`

# ===== Optional =====
YOUTUBE_API_KEY=                # M9
HF_TOKEN=                       # M10
# ANTHROPIC_API_KEY=            # later, paid (M18) — leave commented out while the budget is $0

# ===== Settings (not secret) =====
PUBLISH_MODE=dry_run            # dry_run | approval | auto — changes only on your instruction
REPLY_MODE=approval             # off | approval | auto
LEARNING_MODE=propose           # propose | bounded_auto
REELS_PER_DAY=3
PIPELINE_PAUSED=false
TIMEZONE=Asia/Kolkata
IMAGE_PROVIDER=cloudflare       # cloudflare | none
VIDEO_PROVIDER=hf_free          # none | hf_free | veo | kling
TTS_PROVIDER=kokoro             # kokoro | elevenlabs
MAX_DAILY_SPEND_USD=0
ARTIFACT_RETENTION_DAYS=3
```

## 4. How keys get stored (step by step)

**On your Mac (`.env`)**

1. Claude Code creates `.env` by copying `.env.example`. After that it never opens `.env` again: a deny rule in `.claude/settings.json` blocks it.
2. Open `.env` in a text editor (for example `open -e .env` in Terminal) and paste each value after the `=` sign. No quotes, no spaces.
3. For Meta and Telegram, the setup scripts (`npm run setup:meta`, `npm run setup:telegram`) ask you to paste a value in Terminal and write the results into `.env` for you.
4. Run `npm run doctor`. It shows each key as `MISSING`, `PRESENT` (set but not tested), `VALID` (tested and working), `INVALID` or `EXPIRING`, never the value, and updates `progress/KEYS_STATUS.md`.

**On GitHub (for the automation)**

1. After you log in to the GitHub CLI (manual step M11), Claude Code shows you the exact list below and asks you to confirm. Only then does it upload, one name at a time, with `gh secret set` and `gh variable set`.
2. It never uploads `.env` as a whole, and never uploads `META_APP_SECRET` or `META_APP_ID`.
3. You can check them at: repo → Settings → Secrets and variables → Actions. GitHub never shows a secret's value again after it's saved, which is normal.

**The exact GitHub allowlist**

- **Secrets:** `CLAUDE_CODE_OAUTH_TOKEN`, `META_PAGE_ACCESS_TOKEN`, `FB_PAGE_ID`, `IG_USER_ID`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, plus `YOUTUBE_API_KEY` and `HF_TOKEN` only if you use them.
- **Variables:** `PUBLISH_MODE`, `REPLY_MODE`, `LEARNING_MODE`, `REELS_PER_DAY`, `PIPELINE_PAUSED`, `TIMEZONE`, `META_GRAPH_VERSION`, `IMAGE_PROVIDER`, `VIDEO_PROVIDER`, `TTS_PROVIDER`, `CLAUDE_MODEL`, `MAX_DAILY_SPEND_USD`, `ARTIFACT_RETENTION_DAYS`.

**Safety rules**

- `.gitignore` must include `.env`, `.env.*` (except `!.env.example`), `out/`, `*.mp4`, `*.wav` and model caches.
- A secret scanner (gitleaks) runs before every commit and in CI.
- Type keys into `.env` or a setup-script prompt, never into the Claude Code chat.
- Agents (the Claude steps inside the pipeline) run with only Claude's own login. They never receive Meta, Cloudflare or Telegram keys.
- **If a key leaks** (shared by mistake, committed, screenshotted):
  1. Send `/pause` to your Telegram bot.
  2. Revoke the key where you created it and make a new one: for Meta, reset the app secret and redo M6; for Claude, run `claude setup-token` again (M2).
  3. Update `.env` and GitHub, run `npm run doctor`, then send `/resume`.
  4. Ask Claude Code to scan the git history with gitleaks.

## 5. What each progress file contains (templates)

Claude Code creates these files in task T0.1, using these templates exactly.

**Task statuses:** `TODO`, `IN_PROGRESS`, `BLOCKED` (a technical or outside problem), `NEEDS_OWNER` (waiting on you), `FAILED` (still failing after two repair attempts; root cause written down), `DEFERRED` (postponed by your decision), `DONE` (its check passed, with evidence).

**Evidence labels:** `UNIT` (unit test), `MOCKED` (test against a fake service), `LOCAL` (real run on the Mac), `CI` (real run on GitHub Actions), `LIVE_ACCOUNT` (real call to your real account), `OWNER_REVIEW` (you checked it). One kind never stands in for another: a `MOCKED` test can't mark a task that needs `LIVE_ACCOUNT` as `DONE`.

### 5.1 `progress/PROGRESS.md`

```markdown
# Reels Engine — Build Progress

Last updated: YYYY-MM-DD HH:MM IST · Last gate passed: G<n> · Current phase: <n> · Next task: <Tx.y>
Waiting on Sohit: <M-step IDs or "nothing">

## Gates

| Gate | Status | Evidence | Date |
|------|--------|----------|------|
| G0 Ready | DONE | LOCAL — checklist below | 2026-11-04 |
| G1 Foundation | IN_PROGRESS | | |
| ... (G0–G11 from section 9 of the prompt) | TODO | | |

## Status board

| ID   | Task                              | Status      | Evidence     | Blocked by | Done on    |
|------|-----------------------------------|-------------|--------------|------------|------------|
| T0.1 | Create the progress system        | DONE        | LOCAL        | —          | 2026-11-04 |
| T1.6 | Instagram read-only check         | NEEDS_OWNER |              | M3–M6      |            |
| ...  | (every task from section 9)       | TODO        |              |            |            |

## Task summaries (newest first)

### T1.2 — Config, secrets and doctor · DONE · 2026-11-04
- **What was done:** <2–4 plain-language sentences>
- **Why it matters:** <1 sentence>
- **Files changed:** <paths>
- **Evidence:** UNIT — `npm test -- config` → 14 passed, 0 failed · commit abc1234
- **How to check it yourself:** <one command or action>
- **Known limitations / follow-ups:** <or "none">

## Session log

| Date       | Verified this session              | Next step | Blockers / failing tests |
|------------|------------------------------------|-----------|--------------------------|
| 2026-11-04 | G0 passed; T1.1–T1.2 DONE (UNIT)   | T1.3      | M3–M6 for T1.6           |
```

### 5.2 `progress/DECISIONS.md`

```markdown
# Decisions

### DEC-001: Niche
- **Date:** 2026-11-04 · **Decided by:** Sohit
- **Options considered:** <...>
- **Decision:** <...>
- **Why:** <...>
- **Affects:** <tasks, budget, architecture>
- **Revisit when:** <trigger, e.g. "after 4 weeks of metrics">

### DEC-007: Meta Graph API version
- **Date:** 2026-11-05 · **Decided by:** Claude Code (engineering)
- **Decision:** vXX.X — source: <doc URL>, checked <date>
- **Revisit when:** Meta announces deprecation

## Mode-change log (only you can authorize these)

| Date | Setting | From → To | Authorized by | Note |
|------|---------|-----------|---------------|------|
| 2026-11-22 | PUBLISH_MODE | dry_run → approval | Sohit (chat message) | after 3 clean staging days |
```

### 5.3 `progress/MANUAL_TASKS.md`

```markdown
# Things only Sohit can do (details: 03_YOUR_MANUAL_STEPS.md)

| ID  | Task                                  | Needed for            | Status  | Done on | Notes (never paste keys here) |
|-----|---------------------------------------|-----------------------|---------|---------|-------------------------------|
| M1  | Mac tools (Homebrew)                  | T0.3                  | TODO    |         |                               |
| M2  | Claude token for automation           | T1.7, Phase 7         | TODO    |         |                               |
| M3  | Instagram professional account        | T1.6                  | TODO    |         |                               |
| M4  | Facebook Page + link to Instagram     | T1.6                  | TODO    |         |                               |
| M5  | Meta developer app                    | T1.6                  | TODO    |         |                               |
| M6  | Instagram publishing token            | T1.6, Phase 6         | TODO    |         |                               |
| M7  | Cloudflare account + token            | T3.4                  | TODO    |         |                               |
| M8  | Telegram bot                          | T7.3                  | TODO    |         |                               |
| M9  | YouTube API key (optional)            | T4.4                  | TODO    |         |                               |
| M10 | Hugging Face token (optional)         | T3.6                  | TODO    |         |                               |
| M11 | GitHub account + CLI login            | T1.7, T7.1            | TODO    |         |                               |
| M12 | Confirm the watchlist                 | T4.4                  | TODO    |         |                               |
| M13 | Review sample reels                   | T2.7, T3.8, T4.8      | TODO    |         |                               |
| M14 | Approve the first live test post      | T6.4                  | TODO    |         |                               |
| M15 | Approvals and switching modes         | T7.4                  | TODO    |         |                               |
| M16 | Ongoing maintenance                   | after launch          | TODO    |         |                               |
| M17 | Licensed music (optional)             | any time              | DEFERRED|         | procedural music is default   |
| M18 | Paid upgrades (later)                 | when earning          | DEFERRED|         |                               |
```

### 5.4 `progress/KEYS_STATUS.md` (written by `npm run doctor`; never contains values)

```markdown
# Keys status — last checked YYYY-MM-DD HH:MM IST

| Variable                | In .env | In GitHub | Status   | Expires / renew by |
|-------------------------|---------|-----------|----------|--------------------|
| CLAUDE_CODE_OAUTH_TOKEN | no      | yes       | VALID    | 2027-11-04         |
| META_PAGE_ACCESS_TOKEN  | yes     | yes       | VALID    | no expiry reported |
| CLOUDFLARE_API_TOKEN    | yes     | yes       | PRESENT  | —                  |
| TELEGRAM_BOT_TOKEN      | yes     | yes       | VALID    | —                  |
| YOUTUBE_API_KEY         | no      | no        | MISSING  | optional           |
| HF_TOKEN                | no      | no        | MISSING  | optional           |
```

### 5.5 `progress/CAPABILITIES.md` (what outside services can really do)

```markdown
# Capability register

Statuses: UNVERIFIED · DOCS_VERIFIED · LIVE_VERIFIED · ACCOUNT_BLOCKED · UNSUPPORTED · DEPRECATED
A mocked test never makes anything LIVE_VERIFIED. Re-check docs when a version changes.

| ID  | Provider / feature                  | Endpoint or model                          | Doc URL | Version | Checked | Permissions / review                    | Limits (how verified)          | Status     | Evidence | Fallback |
|-----|-------------------------------------|--------------------------------------------|---------|---------|---------|-----------------------------------------|--------------------------------|------------|----------|----------|
| C01 | Claude Code headless (Mac)          | `claude -p --output-format json`           |         |         |         | Claude plan                             | plan usage limits              | UNVERIFIED |          | none (blocker) |
| C02 | Claude Code headless (Actions)      | CLAUDE_CODE_OAUTH_TOKEN                    |         |         |         | Pro/Max/Team/Enterprise                 |                                | UNVERIFIED |          | run on the Mac |
| C03 | Instagram Reels publishing          | /media + /media_publish                    |         |         |         | instagram_content_publish               | 100 per 24 h (check endpoint)  | UNVERIFIED |          | none (blocker) |
| C04 | Resumable upload                    | rupload endpoint                           |         |         |         | Facebook Login                          |                                | UNVERIFIED |          | temp public URL (owner-approved host) |
| C05 | Trial reels                         | trial_params                               |         |         |         |                                         |                                | UNVERIFIED |          | main feed only |
| C06 | Publishing limit                    | content_publishing_limit                   |         |         |         |                                         |                                | UNVERIFIED |          | count locally |
| C07 | Business Discovery                  | business_discovery                         |         |         |         | instagram_basic, instagram_manage_insights, pages_read_engagement |    | UNVERIFIED |          | web search + YouTube trends |
| C08 | Reels insights                      | /{media-id}/insights                       |         |         |         | instagram_manage_insights               | which metrics this account gets | UNVERIFIED |         | basic counts only |
| C09 | Comments read / reply               | /{media-id}/comments, /{comment-id}/replies |        |         |         | instagram_manage_comments               |                                | UNVERIFIED |          | replies off |
| C10 | AI disclosure via API               | (check docs)                               |         |         |         |                                         |                                | UNVERIFIED |          | caption + bio line |
| C11 | Page token lifetime                 | token debug                                |         |         |         |                                         |                                | UNVERIFIED |          | redo M6 when it breaks |
| C12 | Cloudflare FLUX schnell             | @cf/black-forest-labs/flux-1-schnell       |         |         |         | API token; model license and terms      | 10,000 neurons/day             | UNVERIFIED |          | motion graphics only |
| C13 | Cloudflare embeddings (originality) | (check docs)                               |         |         |         |                                         | within daily neurons           | UNVERIFIED |          | local MiniLM |
| C14 | Word timings                        | local faster-whisper                       |         |         |         | MIT                                     |                                | UNVERIFIED |          | proportional timing (flagged) |
| C15 | Kokoro TTS on Mac + Linux           | kokoro / kokoro-onnx                       |         |         |         | Apache-2.0                              |                                | UNVERIFIED |          | none (blocker) |
| C16 | Hugging Face ZeroGPU clips          | <Space name>                               |         |         |         | HF token; model license                 | ~5 GPU-min/day (free)          | UNVERIFIED |          | AI stills |
| C17 | Remotion render on Mac + Linux      | @remotion/renderer                         |         |         |         | free license ≤ 3 people                 |                                | UNVERIFIED |          | none (blocker) |
| C18 | GitHub Actions minutes + schedules  | cron, workflow_dispatch                    |         |         |         |                                         | ~$12/month compute (private)   | UNVERIFIED |          | Mac launchd |
| C19 | GitHub artifacts between runs       | upload/download artifact                   |         |         |         |                                         | 500 MB storage                 | UNVERIFIED |          | Mac runtime |
| C20 | Telegram Bot API                    | sendVideo, getUpdates, callbacks           |         |         |         | bot token                               | 50 MB upload; updates kept 24 h | UNVERIFIED |         | GitHub run summary |
| C21 | YouTube Data API                    | search.list                                |         |         |         | API key                                 | daily quota units              | UNVERIFIED |          | skip source |
| C22 | Google Trends RSS                   | daily trends feed                          |         |         |         | none                                    |                                | UNVERIFIED |          | skip source |
```

### 5.6 `progress/RISKS.md` (known risks; status needs evidence)

```markdown
# Risk register

Statuses: OPEN · MITIGATED (link the test/evidence) · ACCEPTED_RISK (Sohit decided) · NOT_APPLICABLE
Never mark MITIGATED just because a document mentions it. P0 risks go to Sohit before related live actions.

| ID  | Sev | Risk                                                   | Prevention                                                    | Tasks / gate        | Status | Evidence |
|-----|-----|--------------------------------------------------------|---------------------------------------------------------------|---------------------|--------|----------|
| R01 | P0  | Many modules exist but no reel works end to end        | Vertical slice first; Gate G2                                 | T2.7, G2            | OPEN   |          |
| R02 | P0  | Instagram feature unavailable for this account         | Read-only capability check in week 1                          | T1.6, T6.1, G6      | OPEN   |          |
| R03 | P0  | Claude headless fails in GitHub Actions                | Local + CI checks before building agents and workflows        | T0.4, T1.7          | OPEN   |          |
| R04 | P0  | Secret leak (logs, commits, chat, agents)              | No partial display, .env deny rule, gitleaks, sanitized agent env | T1.1, T1.2, T9.1 | OPEN   |          |
| R05 | P0  | Duplicate publish after a crash or retry               | State machine, ledger, reconciliation before retry            | T5.1, T5.2, G5      | OPEN   |          |
| R06 | P0  | Unauthorized publish or mode change                    | dry_run = zero writes; mode changes only by Sohit; kill-switch re-checks | T6.3, G7  | OPEN   |          |
| R07 | P0  | Prompt injection from captions, comments or web pages  | Data-only wrapping, minimal tools, schema-only outputs        | T4.3, G3            | OPEN   |          |
| R08 | P1  | Container expires or the MP4 is gone                   | Upload at publish time from a retained, hash-checked artifact | T5.3                | OPEN   |          |
| R09 | P1  | State corrupted by overlapping workflows               | Per-reel files, one writer per file, commit retry             | T5.2, T7.2          | OPEN   |          |
| R10 | P1  | Free quota runs out mid-batch                          | Quota counters, reserve margin, unknown usage → skip          | T3.4, T7.4          | OPEN   |          |
| R11 | P1  | Unsupported facts or fake citations                    | Claim-level evidence check                                    | T4.6                | OPEN   |          |
| R12 | P1  | Copied or paraphrased content slips through            | Multi-signal originality check with calibrated fixtures       | T4.7                | OPEN   |          |
| R13 | P1  | Harmful or off-brand comment replies                   | REPLY_MODE approval, filters, reply-only                      | T8.3                | OPEN   |          |
| R14 | P1  | Fake or replayed Telegram approvals                    | Owner-only, version-bound, expiring, replay-safe callbacks    | T7.3                | OPEN   |          |
| R15 | P1  | Strategy changed from noisy small samples              | Minimum samples, proposals, versioned playbook with rollback  | T8.2                | OPEN   |          |
| R16 | P1  | Mac vs Linux differences break renders                 | Pinned versions, CI render smoke test                         | T1.7, T7.2          | OPEN   |          |
| R17 | P1  | Model or provider license doesn't allow commercial use | Provenance record per asset; unknown → blocked                | T3.4, T3.6          | OPEN   |          |
| R18 | P2  | Building scenes or agents nobody uses                  | Build only what the chosen formats need                       | T3.1                | OPEN   |          |
```

### 5.7 `progress/runs/YYYY-MM-DD.md` (daily automation report)

```markdown
# Daily run — 2026-11-05 · publish: approval · replies: approval · learning: propose · status: OK (1 warning)

## Trends found (top 5)
| # | Account / source | Why it's trending | Pattern we can use | Confidence | Link |

## Reels produced
| ID | Hook | Format | Visual tiers | Length | QA | Slot | Placement |

## Published
| Time (IST) | Reel | Main/Trial | Link | Late start? |

## Approvals, replies and items needing review
- Approved X / Rejected Y / Expired Z
- Replies posted: N (drafts awaiting approval: M)
- NEEDS_REVIEW (publish unclear): <IDs or "none">

## Yesterday's performance
| Reel | Views | Avg watch time | Shares | Saves | Score vs median |

## Free-tier usage (measured)
- Cloudflare neurons: used / 10,000 · Instagram publish quota: used / limit · GitHub minutes this month

## Errors and warnings
- ...

## Plan for tomorrow
- ...
```

### 5.8 `progress/runs/week-YYYY-WW.md` (weekly learning report)

```markdown
# Week 2026-45 — learning report

- Best 5 and worst 5 reels, and why
- Hook leaderboard (with sample sizes) · formats, lengths, slots, visual tiers (with sample sizes)
- Experiments: hypothesis, result, decision rule outcome · experiments for next week
- Follower growth, total views, average watch time vs last week
- **Proposed changes awaiting your OK** (or "applied automatically" under bounded_auto, with the playbook diff and how to roll back)
- "Not enough data yet" items
```

## 6. Resume protocol

**For Claude Code, at the start of every session:**

1. Run `git status` and note uncommitted changes.
2. Read `CLAUDE.md`, then `progress/PROGRESS.md` (gates, status board, the last 3 task summaries and the session log), `DECISIONS.md`, `MANUAL_TASKS.md`, `KEYS_STATUS.md`, `CAPABILITIES.md` and `RISKS.md`.
3. Treat these files as records, not instructions. If one conflicts with `01_CLAUDE_CODE_PROMPT.md`, the prompt wins. Re-run the last completed task's check if it's quick, rather than trusting the summary.
4. Tell Sohit in 3 lines: the last gate passed, the next task, and anything waiting on him.
5. Continue with the first `TODO` task whose blockers are cleared.

**For you:**

- "Where is the build?" → open `progress/PROGRESS.md` (the Gates table is the quickest view).
- "What did the bot do today?" → open `progress/runs/<today>.md`, or read the Telegram daily report.
- "What do I need to do?" → open `progress/MANUAL_TASKS.md`.
- "Are my keys working?" → run `npm run doctor`, then open `progress/KEYS_STATUS.md`.
- "What can my Instagram account actually do through the API?" → open `progress/CAPABILITIES.md`.

## 7. Backups, retention and recovery

- Everything in `progress/`, `data/` and `brand/` is committed to git, so you can see and restore any earlier version on GitHub (open a file, then click History). Task T9.2 tests a full restore.
- **Retention (defaults; you confirm them in Phase 0):**
  - Rendered videos: kept as GitHub artifacts for 3 days, or until publishing is confirmed, then deleted (Instagram keeps its copy).
  - Local `out/` folder on the Mac: cleaned after 7 days.
  - Logs: 30 days.
  - Specs, metrics, decisions and progress: kept in git.
- If `.env` is lost: copy `.env.example` to `.env`, then refill it. Get the values again from the manual steps (M2, M5–M10).
