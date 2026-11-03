# Reels Engine — Claude Code Build Execution Protocol

Use this protocol for every build session after the prompt-update proposal is approved.

## Session start

1. Inspect the repository and git status before changing files.
2. Read `CLAUDE.md`, `progress/PROGRESS.md`, `progress/DECISIONS.md`, `progress/MANUAL_TASKS.md`, `progress/KEYS_STATUS.md`, and the current task's spec.
3. Read relevant code and tests. Do not assume previous session summaries are accurate.
4. Report: current verified milestone, next task, blockers/owner actions, and any dirty/uncommitted changes.
5. Confirm that the selected task is within the approved scope and does not require a new owner decision.

## Task execution

For each task:

1. State the task ID, intended behavior, files likely to change, and acceptance criteria.
2. Identify the failure cases before coding.
3. Implement the smallest vertical slice that can be tested.
4. Add or update tests alongside the implementation.
5. Run the exact relevant checks; then run regression checks.
6. Inspect diffs for accidental scope changes, secrets, generated files, or unrelated rewrites.
7. Record results with commands and actual outcomes.
8. Update progress only with truthful status and evidence.
9. Commit only when the owner-approved repository workflow permits it and tests are passing. Do not commit secrets or knowingly broken work.

## Stop conditions

Stop the current operation and mark it BLOCKED or NEEDS_OWNER when:
- A required external permission or account action is missing.
- An API capability cannot be verified.
- The action could publish content, incur charges, change account settings, create remote resources, delete production data, or expose secrets without prior authorization.
- A requirement conflicts with a higher-priority safety, budget, or owner instruction.
- A test fails and the cause is not understood after the allowed repair attempts.
- A proposed architectural change materially expands scope.

Continue with unrelated safe tasks only if they do not depend on the blocker.

## Repair-loop limits

- Do not repeatedly modify code to make a failing test disappear without understanding the cause.
- Maximum two focused repair attempts for one failing check before documenting the root cause and stopping that task.
- Never weaken, skip, or delete a test merely to achieve a green result without explicit owner approval.
- No infinite agent loops or uncontrolled retries.
- Use bounded retries for network calls and model outputs; specify timeout, retry count, and backoff.

## Evidence-based status

Use the statuses:
`TODO`, `IN_PROGRESS`, `IMPLEMENTED`, `TESTING`, `VERIFIED`, `BLOCKED`, `NEEDS_OWNER`, `FAILED`, `DEFERRED`, `DONE`.

`DONE` means the acceptance criteria have been verified. Each completed task must record:
- Commands executed.
- Actual pass/fail results.
- Test names or artifacts.
- Commit hash when committed.
- Known limitations.
- Date and environment.

A mocked provider test must be labeled MOCKED. A real provider check must be labeled LIVE and must not be performed without appropriate authorization.

## End of session

- Update progress and session log.
- State exactly what is verified, what remains, and next task.
- Mention test failures and limitations plainly.
- Do not claim end-to-end readiness until the relevant end-to-end gate passes.
