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
