# Reels Engine — Acceptance Gates and Test Plan

Claude Code must not advance past a gate until its criteria are satisfied or the owner explicitly accepts a documented blocker/risk.

## Gate 0 — Prompt and environment readiness

**Purpose:** avoid building on incomplete specifications.

- All referenced prompt files exist or are explicitly marked missing.
- Kickoff answers are recorded.
- Project scope and MVP niche/audience/format are decided.
- Dependency and runtime versions are documented.
- Git working tree is inspected.
- External capability uncertainties are listed.
- No secrets are requested in chat.

**Evidence:** checklist, decisions log, environment report.

## Gate 1 — Reproducible project foundation

- Clean install succeeds using lockfile.
- Typecheck, lint, and unit tests pass.
- Config schema validates expected and invalid values.
- Secret redaction tests pass without printing secret suffixes.
- `doctor` differentiates PRESENT from VALID and permission/expiry failure.
- CI runs from a clean checkout.

**Evidence:** CI run, test outputs, clean install instructions.

## Gate 2 — First deterministic local reel

Given a hand-authored fixture ReelSpec:
- Voice/audio is generated or supplied as fixture.
- Scene durations use actual audio duration.
- Captions match canonical script and timing tolerance.
- MP4 is rendered with expected dimensions, frame rate, codec, audio and duration.
- QA catches intentionally broken fixture(s): invalid aspect ratio, missing audio, black frame, overflow or caption timing drift.
- The output is playable and owner-reviewable.

**Must pass before:** trend agents, multi-agent complexity, Instagram integration.

## Gate 3 — Content-agent slice

- Agent outputs conform to strict schemas.
- Malformed output is handled with bounded repair.
- Prompt-injection fixture from a caption/comment cannot override system behavior or trigger unauthorized tools.
- Factual claims have claim-level evidence status.
- Agent run records model, prompt version, input references, output, and validation status.
- No secret is available to the agent.

**Evidence:** fixture tests and red-team test results.

## Gate 4 — Trend source feasibility

For each proposed source:
- Documentation status and source URL are recorded.
- Account/app scopes and review dependencies are known.
- Missing metrics are represented as missing, not zero.
- Rate-limit/error behavior is tested.
- Empty or inaccessible source does not crash unrelated pipeline stages.
- Trend score includes sample count/confidence and documented calculation.

**Evidence:** provider capability matrix and tests. Live account check only with authorization.

## Gate 5 — Queue, state and recovery

- Valid and invalid state transitions are tested.
- Atomic persistence and schema validation are tested.
- Duplicate job submissions are handled.
- Simulated crash at each side-effect boundary is recovered or safely blocked.
- Concurrent writer behavior is tested.
- A remote publish ambiguity does not lead to blind duplicate publishing.
- Expired media container can be recreated only if retained artifact exists.

**Evidence:** idempotency/recovery tests.

## Gate 6 — Instagram capability gate

Before implementing or enabling each endpoint:
- Official docs checked and dated.
- Correct API version recorded.
- Required permissions/app review identified.
- Capability tested with the actual account if owner authorizes it.
- Live status is not inferred from mocked tests.
- Unsupported or blocked feature has fallback or is removed from MVP scope.

**Evidence:** capability matrix. This gate does not grant permission to publish.

## Gate 7 — Dry-run publishing pipeline

- Strict dry-run produces local artifact/report only.
- No external write calls are made.
- Queue status is accurate.
- Duplicate detection is tested.
- Limits and quota guards are tested.
- Pause switch prevents writes and is rechecked before write.

**Evidence:** network call spies or equivalent test proving no writes.

## Gate 8 — Owner-approved single live post

This gate requires separate explicit authorization at the moment of execution.

Before live test:
- Final artifact and caption are shown to owner.
- QA passed.
- API capability status is LIVE_VERIFIED.
- Budget and quota preflight pass.
- Approval binds to the exact artifact/caption version.
- Rollback/cleanup expectations are explained.

After:
- Confirm platform response and permalink.
- Record remote ID and publish state.
- Verify post is visible to owner.
- Report any unknown or partial state.
- No automatic transition to auto mode.

## Gate 9 — Scheduled automation staging

- Manual `workflow_dispatch` succeeds.
- Schedule lateness is handled.
- Overdue items are checked for expiry and policy before publishing.
- State writer concurrency and retries are safe.
- CI/runtime minutes and provider quota are measured, not merely estimated.
- Pause/stop command is tested.
- Failure alerts reach the owner.

**Evidence:** several successful staging runs with no live publish unless separately approved.

## Gate 10 — Analytics and learning

- API metric availability is verified per account.
- Missing metric behavior is explicit.
- Normalization, windows and score formula are documented.
- Experiment design identifies hypothesis, control/treatment, metric, duration and decision rule.
- Minimum sample size prevents premature playbook update.
- Playbook change is versioned and reversible.
- No claim of statistical significance without suitable evidence.

## Gate 11 — Production readiness review

- Security review and secret scan pass.
- Backup/restore has been tested.
- Token expiry and renewal procedures are documented.
- API/provider capability matrix is current.
- Data retention and cleanup are documented.
- Error alerts and kill switch are tested.
- Owner signs off on the specific operating mode and scope.

## Evidence labeling

Every result must be labeled one of:
- `UNIT`
- `MOCKED`
- `LOCAL`
- `CI`
- `LIVE_ACCOUNT`
- `OWNER_REVIEW`

Never substitute one evidence class for another.
