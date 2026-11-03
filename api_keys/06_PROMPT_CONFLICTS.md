# Reels Engine — Prompt Conflicts, Assumptions and Decisions

This file is a review checklist derived from the two original prompt files. Claude Code must verify the current wording and update status rather than assume an issue is already fixed.

## A. Conflicts or specification ambiguities to resolve

| ID | Original requirement / area | Potential conflict or ambiguity | Proposed resolution |
|---|---|---|---|
| PA-01 | Section 2 publishing rule: every mode change needs owner OK; Phase 8 says auto after 14 good days | Automatic graduation conflicts with explicit authorization | Remove automatic transition; owner must explicitly authorize auto mode |
| PA-02 | `dry_run` says render/report only; architecture says produce run uploads containers | Is container creation/upload part of dry-run? | Define dry-run as no external writes |
| PA-03 | “Every day no manual work” versus mandatory owner review, API setup, and first live approval | Goal overstates autonomy during setup/approval | Distinguish eventual scheduled operation from setup and approval-dependent phases |
| PA-04 | Meta container retained 24h; approvals may be delayed and unreviewed items expire | Workflow might not retain MP4 for container recreation | Specify durable artifact retention and expiry recovery |
| PA-05 | State stored as JSON in git and workflows commit state; concurrency group and pull-rebase | Git commits are not equivalent to transactional runtime persistence | Document serial writer design; evaluate durable DB/store |
| PA-06 | Seven agents; agents mirrored in `agents/` and `.claude/agents/` | Duplicate prompt sources can drift | Pick canonical source and add synchronization test |
| PA-07 | Task DONE criteria often say files exist/tests pass/owner sees item | Completion may not prove functional end-to-end behavior | Require gate evidence and distinguish mocked vs live |
| PA-08 | Progress status template has only TODO/IN PROGRESS/BLOCKED/DONE/SKIPPED | No statuses for implemented-but-untested, failed, or owner-required | Expand status vocabulary and update templates |
| PA-09 | “Show at most last 4 characters” vs “never expose values” | Partial token exposure unnecessary | Remove suffix display; status-only secret reporting |
| PA-10 | README setup references `03_YOUR_MANUAL_STEPS.md` but this file was not among the two supplied files | Setup instructions can dead-end | Mark missing; draft separately and obtain owner approval |
| PA-11 | Instagram trial reels, insights, comments, Business Discovery all specified as features | Account permissions, API support, app review and endpoint availability may differ | Capability gate before feature implementation |
| PA-12 | Budget $0 with free quotas and optional provider models | Free quotas, availability, licensing and limits can change | Date-stamp verification; hard stop; no paid activation |
| PA-13 | 20–100 watchlist accounts and extensive scans | Potential rate-limit, permission, data sparsity, or source coverage constraints | MVP with small verified watchlist; expand after measured tests |
| PA-14 | 12 scenes minimum before sample review | Component count may cause premature complexity | First deliver one/three representative formats; add scenes based on content need |
| PA-15 | Six-frame visual QA | Fixed sparse samples can miss intermittent defects | Scene-aware frame sampling and defect injection |
| PA-16 | Facts require source URLs | URL alone does not establish claim support | Claim-level evidence and verification status |
| PA-17 | AI disclosure line in every caption and bio | Wording alone may not satisfy all platform policy/legal requirements | Verify applicable platform requirements and make disclosure configurable |
| PA-18 | Claude Code CLI used in CI under owner plan/token | Authentication/usage policy and headless mode need real validation | Minimal proof-of-concept before building agents and workflows |
| PA-19 | GitHub private Free minutes estimated and rendering budget target | Rendering cost/time may be underestimated | Benchmark actual render and runner usage before production cadence |
| PA-20 | Weekly learner updates playbook and weights | No defined minimum sample, confidence, or rollback criteria | Bounded, evidence-based updates with review and rollback |

## B. External assumptions to verify

Do not mark these confirmed without current official evidence and applicable account test:

- Meta Graph API version and endpoint field list.
- Instagram publishing permission and app review requirements.
- Business Discovery availability for the owner’s account and requested fields.
- Trial reel creation/graduation parameters and insights access.
- Reels insights metric names and account eligibility.
- Token lifetime, renewal, revocation, and password-change behavior.
- Current publish quota and limit endpoint behavior.
- Instagram media container upload method, expiry, and supported hosting alternatives.
- Cloudflare Workers AI models, pricing/free quota, request limits and commercial-use terms.
- Hugging Face Space GPU availability, token behavior, model license, and commercial-use conditions.
- Kokoro language/voice support and runtime compatibility on both Mac and Linux.
- Remotion licensing and rendering requirements for intended use.
- GitHub Actions current private-repository minutes, schedule reliability, and permissions.
- Claude Code CLI headless authentication, token use, supported flags, and account usage limitations.
- Telegram bot callback security and preview file limits.
- YouTube API quota and relevant search fields.
- Google Trends RSS endpoint stability and allowed usage.

## C. Decisions that must belong to the owner

- Niche and target audience.
- Brand name, handle, mascot, style, language and voice.
- Launch reel cadence and publishing slots.
- Public vs private repository.
- Runtime (GitHub Actions vs Mac) after feasibility/cost comparison.
- Approval mode and whether/when auto-publishing is permitted.
- Permission to create remote resources or configure GitHub secrets.
- Permission for a live Instagram test post.
- Permission to post comment replies autonomously.
- Any paid provider activation or spend ceiling.
- Retention period for generated videos, audio, logs and metrics.
- Final acceptance of content policy and disclosure approach.

Claude Code may recommend options but must not decide these silently.
