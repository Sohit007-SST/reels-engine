# Decisions

All kickoff answers below (DEC-001..DEC-012) are **DEFAULT applied — owner said 'just build, all permissions given'; owner must confirm or override (see OWNER_STEPS)**. Each is recorded with the template fields; "Decided by" is "Default (owner instruction)" until the owner confirms.

### DEC-001: Niche and target audience
- **Date:** 2026-11-03 · **Decided by:** Default (owner instruction) — DEFAULT applied — owner said 'just build, all permissions given'; owner must confirm or override (see OWNER_STEPS)
- **Options considered:** "What if" history; mythology and folklore; unsolved mysteries; recurring animal characters; space and science. Realistic AI-video-with-sound formats (street interviews, ASMR) marked "later" (paid models).
- **Decision:** "What if" science & history (space, ancient worlds, Earth) for curious 18–34 English-speaking viewers.
- **Why:** story-driven, suits animated AI stills + motion graphics on the free stack, low likeness/copyright risk.
- **Affects:** brand/brand.json, hooks, formats, trend queries, watchlist (M12)
- **Revisit when:** after 4 weeks of metrics

### DEC-002: Voiceover language
- **Date:** 2026-11-03 · **Decided by:** Default (owner instruction) — DEFAULT applied — owner said 'just build, all permissions given'; owner must confirm or override (see OWNER_STEPS)
- **Options considered:** English (default); Hindi (Kokoro Hindi voices, sample first)
- **Decision:** English (`en`, Kokoro voice `af_heart`, speed 1.08)
- **Why:** best free voice quality
- **Affects:** T2.3, brand.json voice
- **Revisit when:** owner wants a Hindi channel

### DEC-003: Instagram handle
- **Date:** 2026-11-03 · **Decided by:** Default (owner instruction) — DEFAULT applied — owner said 'just build, all permissions given'; owner must confirm or override (see OWNER_STEPS)
- **Decision:** handle TBD; new account (M3)
- **Affects:** brand.json name/handle, M3–M6
- **Revisit when:** owner creates the account

### DEC-004: Where it runs
- **Date:** 2026-11-03 · **Decided by:** Default (owner instruction) — DEFAULT applied — owner said 'just build, all permissions given'; owner must confirm or override (see OWNER_STEPS)
- **Options considered:** GitHub Actions (default); this Mac via launchd
- **Decision:** GitHub Actions; final choice confirmed after T1.7 measures real minutes
- **Affects:** T1.7, T7.x, budget
- **Revisit when:** T1.7 / T7.4 minute measurements

### DEC-005: GitHub repo visibility
- **Date:** 2026-11-03 · **Decided by:** Default (owner instruction) — DEFAULT applied — owner said 'just build, all permissions given'; owner must confirm or override (see OWNER_STEPS)
- **Decision:** private (about 2,000 standard Linux minutes/month on GitHub Free)
- **Affects:** T1.7, T7.x
- **Revisit when:** minutes run short

### DEC-006: Reels per day at launch
- **Date:** 2026-11-03 · **Decided by:** Default (owner instruction) — DEFAULT applied — owner said 'just build, all permissions given'; owner must confirm or override (see OWNER_STEPS)
- **Decision:** 3 (slots 08:30, 13:00, 19:30 IST); final cadence set after staging (T7.4)
- **Affects:** REELS_PER_DAY, brand.json slots
- **Revisit when:** T7.4

### DEC-007: Publishing approval
- **Date:** 2026-11-03 · **Decided by:** Default (owner instruction) — DEFAULT applied — owner said 'just build, all permissions given'; owner must confirm or override (see OWNER_STEPS)
- **Decision:** `approval` at launch; **currently `PUBLISH_MODE=dry_run`** (zero external writes). `auto` only on a later explicit owner instruction.
- **Affects:** PUBLISH_MODE, T6.x, T7.x
- **Revisit when:** G9 passes (owner switches to approval, M15)

### DEC-008: Comment replies
- **Date:** 2026-11-03 · **Decided by:** Default (owner instruction) — DEFAULT applied — owner said 'just build, all permissions given'; owner must confirm or override (see OWNER_STEPS)
- **Decision:** `REPLY_MODE=approval` (drafts go to Telegram)
- **Affects:** T8.3
- **Revisit when:** G10

### DEC-009: Weekly learning
- **Date:** 2026-11-03 · **Decided by:** Default (owner instruction) — DEFAULT applied — owner said 'just build, all permissions given'; owner must confirm or override (see OWNER_STEPS)
- **Decision:** `LEARNING_MODE=propose`
- **Affects:** T8.2, brand/playbook.md
- **Revisit when:** G10

### DEC-010: Mascot narrator
- **Date:** 2026-11-03 · **Decided by:** Default (owner instruction) — DEFAULT applied — owner said 'just build, all permissions given'; owner must confirm or override (see OWNER_STEPS)
- **Decision:** yes — original SVG character (brand/mascot.md)
- **Affects:** T3.2
- **Revisit when:** owner reviews samples (M13)

### DEC-011: Main feed vs trial reels
- **Date:** 2026-11-03 · **Decided by:** Default (owner instruction) — DEFAULT applied — owner said 'just build, all permissions given'; owner must confirm or override (see OWNER_STEPS)
- **Decision:** all main feed in week 1; later 3 main + extras as trial reels
- **Affects:** placement field, T6.4 (the single live test is a trial reel per spec), T8.4
- **Revisit when:** after week 1

### DEC-012: Data retention
- **Date:** 2026-11-03 · **Decided by:** Default (owner instruction) — DEFAULT applied — owner said 'just build, all permissions given'; owner must confirm or override (see OWNER_STEPS)
- **Decision:** rendered videos 3 days or until publishing is confirmed; local out/ 7 days; logs 30 days; specs, metrics and progress kept in git
- **Affects:** ARTIFACT_RETENTION_DAYS, brand.json retention, T5.3
- **Revisit when:** storage limits are hit

### DEC-013: Keys stored in api_keys/.env
- **Date:** 2026-11-03 · **Decided by:** Sohit (owner request)
- **Options considered:** spec's root `.env`; owner's `api_keys/` folder
- **Decision:** real keys in `api_keys/.env` (gitignored, mode 600), template `api_keys/.env.example`. Loaders read it via `src/config.ts` (`ENV_FILE` may override). `.claude/settings.json` denies reading it. Root `.env` is also gitignored and denied in case it is ever created.
- **Why:** owner wants all key material in one folder
- **Affects:** src/config.ts, setup scripts (ops), .gitignore, .claude/settings.json, docs
- **Revisit when:** never unless the owner asks

### DEC-014: TypeScript 6.0.x instead of 7.x
- **Date:** 2026-11-03 · **Decided by:** Claude Code (engineering)
- **Decision:** typescript 6.0.3, because typescript-eslint 8.72.1 supports `>=4.8.4 <6.1.0`
- **Revisit when:** typescript-eslint supports TS 7

## Prompt conflicts (06_PROMPT_CONFLICTS.md, section A) — status checked against v1.1 wording

| ID | Resolution |
|---|---|
| PA-01 | Resolved in v1.1: no automatic graduation; every mode change is an explicit owner instruction (01 §2.6). |
| PA-02 | Resolved: dry_run = zero external writes; enforced by the http write guard + network spy (src/lib/http.ts). |
| PA-03 | Resolved: setup, first live post and every mode change need the owner; only daily operation is automatic (01 §1). |
| PA-04 | Resolved: MP4 kept as a GitHub artifact (3 days), container created at publish time, re-created only from a hash-matching artifact (01 §7.8). |
| PA-05 | Accepted for MVP: per-reel JSON files, one writer per file, atomic writes, file lock, commit retry; evaluate a DB before scale (04 §4). |
| PA-06 | Resolved: agents/ is canonical; `npm run agents:sync` generates .claude/agents/ + drift test (T4.2). |
| PA-07 | Resolved: evidence labels + gates; mocked never counts as live. |
| PA-08 | Resolved: statuses TODO/IN_PROGRESS/BLOCKED/NEEDS_OWNER/FAILED/DEFERRED/DONE (02 §5). |
| PA-09 | Resolved: no suffix display anywhere; redaction tests check every prefix/suffix ≥ 4 chars. |
| PA-10 | Resolved: 03_YOUR_MANUAL_STEPS.md is present in api_keys/. |
| PA-11 | Resolved: capability register + read-only check T1.6 + gate G6 before Instagram features. |
| PA-12 | Resolved: free claims date-stamped in CAPABILITIES.md; paid providers refuse while MAX_DAILY_SPEND_USD=0 (config validation). |
| PA-13 | Resolved: start with 10–20 confirmed accounts (M12); grow after measured rate limits. |
| PA-14 | Resolved: no minimum scene count; build what the formats need (01 §7.6, T3.1). |
| PA-15 | Resolved: scene-aware sampling (first/middle/last of every scene + frame 0 + cover) with defect injection (01 §7.7). |
| PA-16 | Resolved: claim-level Fact records with SUPPORTED/HYPOTHETICAL status (ReelSpec schema). |
| PA-17 | Resolved: disclosure configurable in brand.json; Meta AI-label rules to be checked (C10). |
| PA-18 | Resolved: T0.4 (local) and T1.7 (Actions) proofs before agents/workflows. |
| PA-19 | Resolved: staging T7.4 measures real minutes before the cadence is fixed. |
| PA-20 | Resolved: ≥ 8 reels per group, ≥ 7 days, ±20% bounded changes, versioned playbook with rollback (01 §7.11). |

## Mode-change log (only you can authorize these)

| Date | Setting | From → To | Authorized by | Note |
|------|---------|-----------|---------------|------|
| 2026-11-03 | PUBLISH_MODE | (new) → dry_run | default | initial state; no live writes |
