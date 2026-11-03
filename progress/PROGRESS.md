# Reels Engine — Build Progress

## Session

| Field | Value |
|---|---|
| Claude session name | instagram_project (untitled) |
| Claude session ID | c6dd6993-23ec-4027-8a73-8c279b99b85b |
| Resume command | `claude --resume c6dd6993-23ec-4027-8a73-8c279b99b85b` |
| Model | Opus 5.5 |
| Started | 2026-11-03 |

Last updated: 2026-11-03 20:35 IST · Last gate passed: G0 (provisional — default decisions await owner confirmation) · Current phase: 1 · Next task: T1.2 doctor (ops), T2.x (render/audio/qa) in parallel
Waiting on Sohit: confirm DEC-001..DEC-012 defaults; M2 (Claude token), M3–M6 (Instagram/Meta), M11 (GitHub CLI login)

## Gates

| Gate | Status | Evidence | Date |
|------|--------|----------|------|
| G0 Ready | DONE (provisional) | LOCAL — prompt files present (01–07 in api_keys/); decisions DEC-001..013 recorded as owner-authorized defaults (owner said "just build"; confirmation pending); environment report below; capability register seeded C01–C22 UNVERIFIED | 2026-11-03 |
| G1 Foundation | IN_PROGRESS | LOCAL — `npm ci` clean install, typecheck, lint, 98 tests (incl. redaction) pass. Missing: `npm run doctor` PRESENT vs VALID (T1.2, ops), CI from clean checkout (T1.7) | |
| G2 First reel | TODO | | |
| G3 Agents | TODO | | |
| G4 Trend sources | TODO | | |
| G5 State | TODO | | |
| G6 Instagram capabilities | TODO | | |
| G7 Dry-run publishing | TODO | | |
| G8 Live test | TODO | | |
| G9 Staging | TODO | | |
| G10 Growth | TODO | | |
| G11 Production | TODO | | |

## Status board

| ID   | Task                                         | Status      | Evidence     | Blocked by | Done on    |
|------|----------------------------------------------|-------------|--------------|------------|------------|
| T0.1 | Create the progress system                   | DONE        | LOCAL        | —          | 2026-11-03 |
| T0.2 | Ask the kickoff questions                    | NEEDS_OWNER | defaults recorded; OWNER_REVIEW pending | owner confirmation | |
| T0.3 | Check the environment                        | DONE        | LOCAL        | —          | 2026-11-03 |
| T0.4 | Claude headless check (local)                | TODO        |              |            |            |
| T1.1 | Scaffold the repo                            | IN_PROGRESS | LOCAL (partial) | gitleaks pre-commit hook + README (ops) | |
| T1.2 | Config, secrets and doctor                   | IN_PROGRESS | UNIT (config + redaction) | `npm run doctor` (ops) | |
| T1.3 | Schemas, state machine and store             | DONE        | UNIT         | —          | 2026-11-03 |
| T1.4 | Brand files                                  | DONE        | UNIT         | —          | 2026-11-03 |
| T1.5 | Run reporter and structured logs             | DONE        | LOCAL + UNIT | —          | 2026-11-03 |
| T1.6 | Instagram read-only capability check         | NEEDS_OWNER |              | M3–M6      |            |
| T1.7 | GitHub Actions check                         | NEEDS_OWNER |              | M2, M11    |            |
| T2.1 | Remotion setup                               | TODO        |              |            |            |
| T2.2 | Slice scenes and captions                    | TODO        |              |            |            |
| T2.3 | Text-to-speech                               | TODO        |              |            |            |
| T2.4 | Word timings                                 | TODO        |              |            |            |
| T2.5 | Audio mix                                    | TODO        |              |            |            |
| T2.6 | Technical QA with broken fixtures            | TODO        |              |            |            |
| T2.7 | First reel                                   | TODO        |              | M13        |            |
| T3.1 | Format scenes                                | TODO        |              |            |            |
| T3.2 | Mascot                                       | TODO        |              |            |            |
| T3.3 | Music and sound effects                      | TODO        |              |            |            |
| T3.4 | AI images                                    | TODO        |              | M7         |            |
| T3.5 | Image scenes                                 | TODO        |              |            |            |
| T3.6 | Free AI clips (optional)                     | TODO        |              | M10        |            |
| T3.7 | Paid provider stubs (OFF)                    | TODO        |              |            |            |
| T3.8 | Format samples                               | TODO        |              | M13        |            |
| T4.1 | Agent runner                                 | TODO        |              |            |            |
| T4.2 | Agent instructions                           | TODO        |              |            |            |
| T4.3 | Security fixtures                            | TODO        |              |            |            |
| T4.4 | Trend sources                                | TODO        |              | M9 (optional), M12 |    |
| T4.5 | Ideas and Hook Lab                           | TODO        |              |            |            |
| T4.6 | Scripts, fact check and visual plans         | TODO        |              |            |            |
| T4.7 | Full QA                                      | TODO        |              |            |            |
| T4.8 | End-to-end dry run                           | TODO        |              | M13        |            |
| T5.1 | Queue and ledger                             | TODO        |              |            |            |
| T5.2 | Crash and duplicate tests                    | TODO        |              |            |            |
| T5.3 | Artifact retention and expiry                | TODO        |              |            |            |
| T6.1 | Capability gate                              | TODO        |              | T1.6       |            |
| T6.2 | Instagram client                             | TODO        |              |            |            |
| T6.3 | Dry-run publishing pipeline                  | TODO        |              |            |            |
| T6.4 | Single live test post                        | TODO        |              | M14        |            |
| T7.1 | GitHub secrets and variables                 | TODO        |              | M11        |            |
| T7.2 | Workflows                                    | TODO        |              | T1.7       |            |
| T7.3 | Telegram                                     | TODO        |              | M8         |            |
| T7.4 | Staging                                      | TODO        |              | M15        |            |
| T8.1 | Insights collection                          | TODO        |              |            |            |
| T8.2 | Weekly learning                              | TODO        |              |            |            |
| T8.3 | Comment replies                              | TODO        |              |            |            |
| T8.4 | Hook A/B tests through trial reels           | TODO        |              |            |            |
| T9.1 | Security review                              | TODO        |              |            |            |
| T9.2 | Restore drill                                | TODO        |              |            |            |
| T9.3 | Docs                                         | TODO        |              |            |            |
| T9.4 | Sign-off                                     | TODO        |              |            |            |

## Environment report (T0.3, 2026-11-03, macOS 27.0.1 arm64)

| Tool | Version | Notes |
|---|---|---|
| node | v26.12.1 | project pins engines `>=22`, `.nvmrc` = 22 (Actions use Node 22 LTS) |
| npm | 11.20.0 | lockfile `package-lock.json`; `npm ci` verified |
| Python (venv) | 3.12.16 | `.venv/` from `/opt/homebrew/bin/python3.12`; `.python-version` = 3.12. System `python3` is 3.15.0 (not used) |
| ffmpeg / ffprobe | 9.0.2 | |
| git | 2.54.0 (Apple Git-157) | repo initialized, no commits yet |
| gh (GitHub CLI) | 2.103.3 | login not checked (M11) |
| gitleaks | 8.30.1 | hook/config owned by ops |
| espeak-ng | 1.52.0 | needed by Kokoro for some languages |
| Claude Code CLI | 2.1.317 | headless check is T0.4 |

Python packages (pinned in `requirements.txt`): numpy 2.5.4, soundfile 0.14.0, scipy 1.18.1, kokoro-onnx 0.6.1, faster-whisper 1.2.1, pyloudnorm 0.2.0 (+ resolved transitive deps). Import check: `.venv/bin/python -c "import numpy, soundfile, scipy, kokoro_onnx, faster_whisper, pyloudnorm"` → OK.

Node packages (exact pins): remotion + @remotion/{cli,renderer,bundler,google-fonts,media-utils,captions,layout-utils,transitions} 4.0.540, react/react-dom 19.3.1, zod 4.6.7, dotenv 18.0.9, lucide-react 1.67.0, fast-xml-parser 5.12.0, undici 8.12.3; dev: typescript 6.0.3 (7.x not supported by typescript-eslint 8.72.1), tsx 4.23.15, vitest 5.1.0, eslint 10.14.0, typescript-eslint 8.72.1, prettier 3.9.10, @types/node 26.6.6, @types/react 19.3.0.

## Task summaries (newest first)

### T1.5 — Run reporter and structured logs · DONE · 2026-11-03
- **What was done:** `src/lib/runReport.ts` renders a `RunReport` into the 02 section 5.7 daily template and writes `progress/runs/DATE.md` + `.json` atomically; all text is redacted. `src/lib/logger.ts` writes JSON-lines logs carrying runId/reelId/taskId/provider/stage/duration/status. `npm run report:dummy` writes a dummy report to `out/runs/` (so dummy output never pollutes `progress/runs/`).
- **Why it matters:** every run leaves a readable, secret-free record the owner can check.
- **Files changed:** src/lib/runReport.ts, src/lib/logger.ts, src/schemas/runReport.ts, src/cli/report-dummy.ts, tests/foundation/schemas-brand.test.ts
- **Evidence:** LOCAL — `npm run report:dummy` → wrote out/runs/2026-11-03.md with the template header; UNIT — "a dummy run writes a correct report following the 5.7 template" passed
- **How to check it yourself:** `npm run report:dummy`, then open `out/runs/<today>.md`
- **Known limitations / follow-ups:** the real daily report (`npm run report`, src/pipeline/report.ts) is built by the publish module.

### T1.4 — Brand files · DONE · 2026-11-03
- **What was done:** `brand/brand.json` (niche, audience, voice af_heart @1.08, palette, fonts, safe zone, slots 3/5 a day, hashtag pool, disclosure line, style suffix, negative prompt, formats, scoring weights, retention), `hooks.json` (12 formulas + empty leaderboard), `blocklist.json`, `watchlist.json` (empty, "pending M12"), `mascot.md`, `playbook.md` v1. Zod schemas in `src/schemas/brand.ts`, loaders in `src/config.ts`.
- **Why it matters:** every module reads one validated brand source instead of hard-coded values.
- **Files changed:** brand/*, src/schemas/brand.ts, src/config.ts
- **Evidence:** UNIT — "all brand files validate" and "brand hashtags are well-formed" passed
- **How to check it yourself:** `npm test -- schemas-brand`
- **Known limitations / follow-ups:** values come from DEFAULT decisions (DEC-001..012); brand name and handle are "TBD" until the owner decides.

### T1.3 — Schemas, state machine and store · DONE · 2026-11-03
- **What was done:** zod schemas with `schemaVersion` for Trend, Idea, Hook, ReelSpec, QueueItem, Ledger, Approval, Metrics, RunReport, AssetProvenance, AgentRunRecord plus Brand/HookLibrary/Blocklist/Watchlist, Control, Usage, VoiceTrack, RenderReport, QaReport. Central transition validator (`src/lib/transitions.ts`) blocks undefined transitions, allows QA_PASSED→APPROVED only in auto mode, and forbids any re-publish once a publish was requested. Atomic store (`src/lib/store.ts`): temp file + fsync + rename, schema-validated writes, bounded file lock.
- **Why it matters:** state can't be corrupted by a crash, and a duplicate publish can't happen by accident.
- **Files changed:** src/schemas/*, src/lib/transitions.ts, src/lib/store.ts, tests/foundation/transitions.test.ts, tests/foundation/store.test.ts
- **Evidence:** UNIT — `npm test` → transitions (20 tests) and store (8 tests) passed
- **How to check it yourself:** `npm test -- transitions store`
- **Known limitations / follow-ups:** crash-at-every-boundary and concurrent-writer scenarios for the publish flow are T5.2 (publish module).

### T1.2 — Config, secrets and doctor · IN_PROGRESS · 2026-11-03
- **What was done:** `src/config.ts` loads `api_keys/.env` (ENV_FILE overrides; process env wins), validates every variable from `.env.example` with zod and spec defaults, refuses paid providers while `MAX_DAILY_SPEND_USD=0`, registers every secret with the redactor, and exposes only MISSING/PRESENT. Redacting logger and error sanitizer in `src/lib/`.
- **Why it matters:** keys can't leak into logs, errors or reports, and bad settings fail fast with the key name (never the value).
- **Files changed:** src/config.ts, src/lib/redact.ts, src/lib/logger.ts, tests/foundation/config.test.ts, tests/foundation/redact.test.ts
- **Evidence:** UNIT — config (20 tests) and redaction (19 tests) pass, including "no key fragment (any prefix/suffix ≥ 4 chars) in logs or errors"
- **How to check it yourself:** `npm test -- config redact`
- **Known limitations / follow-ups:** `npm run doctor` (PRESENT vs VALID with fake keys, writes KEYS_STATUS.md) is owned by ops.

### T1.1 — Scaffold the repo · IN_PROGRESS · 2026-11-03
- **What was done:** git init (no commit), `.gitignore` (secrets incl. api_keys/.env, .venv, node_modules, out, models, *.mp4, *.wav), package.json (ESM, engines node >=22, exact pins), tsconfig strict, ESLint flat config + Prettier, Vitest, `.nvmrc`, `.python-version`, `api_keys/.env.example` exactly as 02 section 3, all npm scripts (stubs exit 2 until built).
- **Why it matters:** reproducible installs and one set of checks for every builder.
- **Files changed:** .gitignore, package.json, package-lock.json, tsconfig.json, eslint.config.js, .prettierrc.json, .prettierignore, vitest.config.ts, .nvmrc, .python-version, requirements.txt, api_keys/.env.example
- **Evidence:** LOCAL — `npm ci` OK; `npm run typecheck` OK; `npm run lint` OK; `npm test` → 7 files, 98 passed, 0 failed; `prettier --check .` OK
- **How to check it yourself:** `npm ci && npm run typecheck && npm run lint && npm test`
- **Known limitations / follow-ups:** gitleaks pre-commit hook, `.gitleaks.toml` and README.md are owned by ops. `api_keys/.env` could not be re-created from the template by this agent (the tool sandbox blocked overwriting it); the owner/manager should run `cp api_keys/.env.example api_keys/.env && chmod 600 api_keys/.env` while it still holds no secrets.

### T0.3 — Check the environment · DONE · 2026-11-03
- **What was done:** checked and recorded node, npm, Python 3.12 venv, ffmpeg, git, gh, gitleaks, espeak-ng and the Claude CLI (table above); created `.nvmrc` and `.python-version`.
- **Why it matters:** pinned versions make Mac and Linux builds match.
- **Files changed:** progress/PROGRESS.md, .nvmrc, .python-version
- **Evidence:** LOCAL — every tool reported a version (see Environment report)
- **How to check it yourself:** `node -v; .venv/bin/python --version; ffmpeg -version | head -1; gh --version; gitleaks version`
- **Known limitations / follow-ups:** none.

### T0.1 — Create the progress system · DONE · 2026-11-03
- **What was done:** created progress/ (PROGRESS, DECISIONS, MANUAL_TASKS, KEYS_STATUS, CAPABILITIES, RISKS, runs/) from the 02 section 5 templates, CLAUDE.md with the hard rules and session protocol, and `.claude/settings.json` denying reads of `.env` files.
- **Why it matters:** anyone can see the true state and resume after a break.
- **Files changed:** progress/*, CLAUDE.md, .claude/settings.json, PROGRESS.md (now a pointer)
- **Evidence:** LOCAL — files exist; every task T0.1–T9.4 listed; C01–C22 seeded UNVERIFIED
- **How to check it yourself:** open `progress/PROGRESS.md`
- **Known limitations / follow-ups:** none.

## Session log

| Date       | Verified this session              | Next step | Blockers / failing tests |
|------------|------------------------------------|-----------|--------------------------|
| 2026-11-03 | G0 (provisional); T0.1, T0.3, T1.3, T1.4, T1.5 DONE; T1.1, T1.2 IN_PROGRESS; 98 tests pass | parallel builders: T1.2 doctor, T2.x slice, T4.1, T5.1 | owner: confirm DEC defaults; M2, M3–M6, M11 |

## Manager log — build pause (2026-11-03 20:49 IST)
- **Session:** instagram_project (untitled) · ID `c6dd6993-23ec-4027-8a73-8c279b99b85b` · resume: `claude --resume c6dd6993-23ec-4027-8a73-8c279b99b85b`
- **Workflow run:** `wf_74f3c45c-fa2` (script: `~/.claude/projects/-Users-sohitkumarnagar-Desktop-instagram-project/c6dd6993-23ec-4027-8a73-8c279b99b85b/workflows/scripts/reels-engine-build-wf_74f3c45c-fa2.js`)
- **Done:** tools installed (ffmpeg 9.0.2, gh 2.103.3, Python 3.12.16, gitleaks 8.30.1, espeak-ng); brief saved in `api_keys/01–07`; Foundation agent COMPLETED (repo scaffold, schemas, config, lib, progress system, brand files) — result cached in the run.
- **Interrupted (partial files on disk):** 6 parallel builders — render, audio, qa, agents, publish, ops. Their bug-checkers, integrator, final review and recorder have NOT run.
- **Why paused:** owner asked to save tokens (plan usage ~90%) until 21:49 IST.
- **Resume plan:** at 21:49 IST re-run the workflow with `resumeFromRunId: wf_74f3c45c-fa2` (foundation cached; builders continue from partial files; then bug-check → integrate → review → OWNER_STEPS.md). A one-shot timer is set in this session for 21:49.
- **Owner action:** `api_keys/.env` still holds the old blank template. Before adding keys, run in Terminal: `cp api_keys/.env.example api_keys/.env && chmod 600 api_keys/.env` (Claude is not allowed to overwrite it).
- **20:53 IST break agent (audio, single agent):** Kokoro TTS LOCAL-verified (1 sentence → 1621 ms, model cached in models/kokoro); added tests/media/tts.test.ts (`npx vitest run tests/media/` → 16 passed); music (3 moods) + sfx (6) assets exist; mix/loudnorm and whisper alignment NOT yet run end-to-end (raw music −20 LUFS). Multi-agent build resumes 21:52 IST.
- **21:51 IST:** limits reset; multi-agent build RESUMED from run wf_74f3c45c-fa2 (foundation cached; 6 builders → bug-checkers → integrator → reviews → recorder). Session ID c6dd6993-23ec-4027-8a73-8c279b99b85b.
- **21:56 IST:** switched to a token-lean plan to finish before the 02:30 limit reset: foundation cached; 6 builders run 2 at a time (self-review included); 1 combined bug-checker; 1 integrator; 1 final reviewer/recorder (9 agents total, max 2 concurrent).
