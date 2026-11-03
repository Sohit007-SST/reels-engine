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

## Notes (2026-11-03, foundation step — none of these change a status)
- C01/C02: Claude Code CLI 2.1.317 is installed on the Mac; the headless JSON check is T0.4 (not run yet).
- C14/C15: `faster-whisper` 1.2.1 and `kokoro-onnx` 0.6.1 are installed in `.venv` and import cleanly; no model downloaded or run yet.
- C17: Remotion 4.0.540 packages installed; no render run yet.
- All outbound HTTP in the code base goes through `src/lib/http.ts` (timeouts, bounded retry, network spy, dry-run write guard).

## Notes (final review 2026-11-03) — no docs were read with URLs this session, so nothing is DOCS_VERIFIED; LOCAL results do not change a status
- C01: LOCAL — 3 real `claude -p --output-format json` calls (CLI 2.1.317, sanitized env HOME/PATH/USER); agents ran in `npm run produce --dry-run`.
- C14: LOCAL — faster-whisper word timings on the fixture, drift ≤ 50 ms.
- C15: LOCAL (Mac only) — Kokoro beats synthesized; Linux not tested (T1.7).
- C17: LOCAL (Mac only) — Remotion renders 1080x1920 MP4; Linux not tested (T1.7).
- C22: LOCAL — https://trends.google.com/trending/rss?geo=IN read-only GET 200 text/xml (feed fetched, docs not read).
- C03–C13, C16, C18–C21: only MOCKED contract tests; need keys/logins (M2–M11).

