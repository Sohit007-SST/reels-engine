# Upgrade to paid providers

The default budget is **$0**. Paid providers are switched off in three separate places, so one typo cannot spend money:

1. `src/config.ts` refuses to load if a paid provider is selected while `MAX_DAILY_SPEND_USD` is `0`.
2. `src/providers/paid.ts` refuses unless `VIDEO_PROVIDER` names that exact provider, the budget is above 0, **and** the code passes `ownerApprovedPaid: true`.
3. Each call checks its estimated cost against `MAX_DAILY_SPEND_USD`.

The Veo and Kling providers (`src/providers/veo.ts`, `src/providers/kling.ts`) are interface stubs only: no paid API code is built yet.

## Recommended order (M18)

1. AI video clips for hook shots: Veo 3.1 Lite (about $0.05 per second, re-check the price) or Kling 3.0.
2. A better voice (ElevenLabs).
3. More reels per day (also costs GitHub Actions minutes on a private repo).

## Steps

1. Create an account with the provider and add billing **there** (set a hard monthly cap at the provider too).
2. Put the key in `api_keys/.env`. Run `npm run doctor`.
3. Ask Claude Code to: add the key name to the GitHub allowlist (after you confirm), build the real adapter behind the existing interface with mocked contract tests, and set `ownerApprovedPaid: true` where the provider is selected.
4. Set repository variables: `MAX_DAILY_SPEND_USD` (for example `2`) and `VIDEO_PROVIDER` (`veo` or `kling`).
5. Run `produce.yml` once by hand in `dry_run` and read the cost line in the daily report.
6. Record the decision in `progress/DECISIONS.md`.

## Going back to free

Set `VIDEO_PROVIDER` to `hf_free` (or `none`) and `MAX_DAILY_SPEND_USD` to `0`. Then revoke or delete the paid key.
