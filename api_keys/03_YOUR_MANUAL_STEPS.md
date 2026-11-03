# Your Manual Steps (things Claude Code can't do for you)

Version 1.1 · Claude Code builds and runs everything else. These steps need your logins, your phone, your password or your decision: creating accounts, accepting terms, verifying your identity and approving what goes public. All of them are free.

Claude Code tracks these in `progress/MANUAL_TASKS.md` and tells you when one is needed ("Please do M6"). Steps marked **Early** are worth doing in the first days. The Instagram steps (M3–M6) and the GitHub steps (M2, M11) let Claude Code test the two biggest unknowns in week 1: what your Instagram account can do through the API, and whether Claude runs on GitHub's computers.

Menu names on Meta, Cloudflare and Google sites change often. If a button in these steps isn't where it should be, ask Claude Code: *"Look up Meta's current steps for <this step>."*

## Overview

| ID | Task | When | Time | Required? |
|---|---|---|---|---|
| M1 | Mac tools (Homebrew) | Early (Phase 0) | 10–20 min | Yes |
| M2 | Claude token for automation | Early (Phase 1 check, T1.7) | 3 min | Yes |
| M3 | Instagram professional account | Early (Phase 1 check, T1.6) | 15 min + warm-up | Yes |
| M4 | Facebook Page linked to Instagram | Early (T1.6) | 10 min | Yes |
| M5 | Meta developer app | Early (T1.6) | 15 min | Yes |
| M6 | Instagram publishing token | When Claude Code asks (T1.6) | 10 min | Yes |
| M7 | Cloudflare account and token | Phase 3 (T3.4) | 10 min | Yes, for AI images |
| M8 | Telegram bot | Before Phase 7 (T7.3) | 5 min | Strongly recommended |
| M9 | YouTube API key | Any time (T4.4) | 10 min | Optional |
| M10 | Hugging Face token | Any time (T3.6) | 5 min | Optional |
| M11 | GitHub account and CLI login | Early (T1.7) | 10 min | Yes |
| M12 | Confirm the watchlist | When asked (T4.4) | 20–30 min | Yes |
| M13 | Review sample reels | When asked (T2.7, T3.8, T4.8) | 10–20 min each | Yes |
| M14 | Approve the first live test post | When asked (T6.4) | 2 min | Yes |
| M15 | Approvals and switching modes | Launch weeks (T7.4 onward) | 2 min/day | Yes |
| M16 | Ongoing maintenance | After launch | ~10 min/week | Yes |
| M17 | Licensed music | Any time | varies | Optional |
| M18 | Paid upgrades | When the page earns | varies | Later |

**Where keys go:** every key you collect goes into the `.env` file in the project folder (see `02_PROGRESS_AND_KEYS.md`). Type keys into `.env` or a setup-script prompt, never into the Claude Code chat, and never into `progress/` files. Claude Code is blocked from reading `.env`; it only sees whether each key is set and working.

---

## M1. Mac tools (Homebrew)

**Summary:** Claude Code needs a few free developer tools on your Mac: Homebrew (an installer), Node.js, Python, ffmpeg (video tools), Git and the GitHub CLI. Claude Code installs most of them itself. You only step in if Homebrew is missing, because installing it needs your Mac password.

**Steps**

1. Open the **Terminal** app.
2. Type `brew --version` and press Enter. If it prints a version number, skip to step 4.
3. Go to **brew.sh**, copy the install command shown at the top of the page, paste it into Terminal and press Enter. Type your Mac password when asked (nothing shows while you type; that's normal). When it finishes, run the "Next steps" commands it prints.
4. Tell Claude Code: *"Homebrew is ready."* With your OK, it installs the rest (`node`, `python`, `ffmpeg`, `git`, `gh`).

**Done when:** `brew --version`, `node -v`, `python3 --version`, `ffmpeg -version` and `gh --version` all print versions.

---

## M2. Claude token for automation

**Summary:** The daily automation runs on GitHub's computers, where Claude needs a token to use your existing Claude plan. There's no extra cost, but it needs a Pro, Max, Team or Enterprise plan. The token lasts 1 year. Automated runs count toward your plan's usage limits. Claude Code tests this early (task T1.7) so a problem shows up in week 1, not after everything is built.

**Steps**

1. In Terminal, run `claude setup-token`.
2. A browser window opens. Sign in to your Claude account and click to approve.
3. The token prints in Terminal. Copy it now, because it isn't saved anywhere.
4. Paste it into `.env` as `CLAUDE_CODE_OAUTH_TOKEN=<token>`. Claude Code uploads it to GitHub secrets later, after you confirm the list.
5. Set a calendar reminder for 11 months from today to repeat this step.

**Done when:** `npm run doctor` shows Claude as `VALID`.

**If you hit usage limits:** lower `REELS_PER_DAY`, or ask Claude Code to set `CLAUDE_MODEL` to a lighter model for routine steps.

---

## M3. Instagram professional account

**Summary:** Only Instagram professional accounts (Creator or Business) can publish through the official API. Use a fresh account dedicated to this niche.

**Steps**

1. In the Instagram app, create a new account with a new email. Pick a short handle that says what the page is about.
2. Fill in the profile: name, photo (you can switch to the mascot once Claude Code designs it), and a bio that says what viewers get plus "AI-generated videos".
3. Switch to professional: Profile → menu (three lines, top right) → **Settings and activity** → **Account type and tools** → **Switch to professional account** → choose **Creator** → pick a category such as "Digital creator" → finish.
4. Turn on two-factor authentication: **Accounts Center** → **Password and security** → **Two-factor authentication**.
5. Suggested warm-up for 3–5 days: use the account like a person would. Follow 20–30 accounts in your niche, like and comment genuinely, and **post 1–2 reels by hand**. A brand-new account that posts by API on day 1 looks more automated. (This is common practice, not an official Meta rule.) Your hand-made reels also let Claude Code test the insights and comments features in the read-only check.

**Done when:** your profile shows the **Professional dashboard**.

---

## M4. Facebook Page linked to Instagram

**Summary:** The system uses "Instagram API with Facebook Login". It's the only setup that can scan other accounts' trending reels (Business Discovery), upload videos directly without hosting, and use a token that normally never expires. It requires your Instagram account to be linked to a Facebook Page. Your personal Facebook profile stays private.

**Steps**

1. Log in to Facebook.
2. Create a Page at **facebook.com/pages/create**. Use the same name as your Instagram brand, pick a category such as "Digital creator", then **Create Page**. You can skip the optional steps.
3. Link Instagram: open the Page → **Settings** → **Linked accounts** → **Instagram** → **Connect account** → log in to your M3 account → allow. (Alternative: Meta Business Suite at business.facebook.com → Settings → Instagram accounts → Connect.)
4. Check that business.facebook.com shows both the Page and the Instagram account.

**Done when:** both appear together in Meta Business Suite.

---

## M5. Meta developer app

**Summary:** A developer app is your private key to Instagram's official API. Keep it in Development mode, which normally covers publishing to your own account without Meta's App Review. (The week-1 read-only check confirms what your account can actually do.)

**Steps**

1. Go to **developers.facebook.com** and log in with the same Facebook account that manages the Page. Click **Get started** and register as a developer (verify your phone or email).
2. Go to **My Apps** → **Create app**.
3. When asked for a use case, choose the option for managing Instagram content **with Facebook Login**. If you're offered **Other**, choose it, then the app type **Business**. (This screen changes often. If unsure, ask Claude Code to check Meta's current docs for "Instagram API with Facebook Login".)
4. App name: "Reels Engine" (any name works). Contact email: yours. If asked for a business portfolio, select yours or skip.
5. Create the app. In the dashboard, add the **Instagram** product and choose **API setup with Facebook login**, if it isn't already added.
6. Go to **App settings** → **Basic**. Copy the **App ID** and the **App Secret** (click Show and enter your password) into `.env` as `META_APP_ID` and `META_APP_SECRET`. These two stay on your Mac and are never uploaded to GitHub.
7. Leave the app in **Development** mode.

**Done when:** `META_APP_ID` and `META_APP_SECRET` are in `.env`.

---

## M6. Instagram publishing token

**Summary:** This creates the token that lets the system post reels, read insights and comments, and scan your watchlist. You make a short-lived token in Meta's Graph API Explorer. A small setup script then turns it into a long-lived Page token and saves it for you. Right after, Claude Code runs a few **read-only** checks to see what your account can really do. Nothing is posted or changed.

**Before you start:** M3, M4 and M5 are done, and Claude Code has built `npm run setup:meta` (task T1.6, early in the build). It will tell you when.

**Steps**

1. Open **developers.facebook.com/tools/explorer** (Graph API Explorer).
2. On the right, under **Meta App**, select your app. Under **User or Page**, choose **Get User Access Token**.
3. Add these permissions: `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `instagram_manage_comments`, `pages_show_list`, `pages_read_engagement`, `business_management`. If your Page is managed through a business portfolio, also add `ads_read`.
4. Click **Generate Access Token** and log in. When asked, select **your Page and your Instagram account**, and allow everything.
5. Copy the token from the **Access Token** box. It expires within a couple of hours, so continue right away.
6. In Terminal, in the project folder, run `npm run setup:meta` and paste the token when asked. The script swaps it for a long-lived Page token, finds your Page ID and Instagram user ID, and writes them to `.env`.
7. Run `npm run doctor`. Meta should show as `VALID`, with your Instagram username.
8. When Claude Code asks, give your OK for the read-only checks: account info, your posting limit, scanning 1–2 watchlist accounts, and insights and comments on one of your hand-made reels. The results go into `progress/CAPABILITIES.md`.

**Done when:** doctor shows Meta as `VALID` with the right username, and the read-only check results are recorded.

**If it breaks later** (you changed your Facebook password, removed the app's access, or doctor shows error 190): repeat this step.

---

## M7. Cloudflare account and token (free AI images)

**Summary:** Cloudflare Workers AI gives 10,000 free "neurons" a day, enough for roughly 100+ AI images. The system stops at 85% of the daily allowance, and skips AI images altogether if it can't confirm how much is left, so you won't be charged.

**Steps**

1. Sign up at **dash.cloudflare.com** on the free plan and verify your email. Don't add a payment method.
2. Copy your **Account ID**. It's shown on the account home or the Workers AI page (usually in a side panel). Put it in `.env` as `CLOUDFLARE_ACCOUNT_ID`.
3. Create an API token: profile icon → **My Profile** → **API Tokens** → **Create Token** → use the **Workers AI** template. (If there's no template: **Custom token** → Permissions: Account → Workers AI → Read and Edit.) Click **Continue**, then **Create**, and copy the token. It's shown only once.
4. Put it in `.env` as `CLOUDFLARE_API_TOKEN`.

**Done when:** doctor shows Cloudflare as `VALID`.

---

## M8. Telegram bot

**Summary:** A private Telegram bot sends reel previews, daily reports and alerts to your phone, with **Approve**, **Reject** and **Pause** buttons. Only your own chat can use the buttons. Free.

**Steps**

1. In Telegram, open a chat with **@BotFather** (it has a verified badge).
2. Send `/newbot`. Choose a display name (for example "Reels Engine"), then a username ending in `bot` (for example `sohit_reels_engine_bot`).
3. BotFather replies with a token. Put it in `.env` as `TELEGRAM_BOT_TOKEN`.
4. Open your new bot from the link in BotFather's message, press **Start** and send "hi".
5. In Terminal, run `npm run setup:telegram`. It finds your chat ID, writes `TELEGRAM_CHAT_ID` to `.env` and sends you a test message.

**Done when:** you receive the test message.

Keep the bot's username private. The system ignores messages and button presses from anyone except your own chat.

---

## M9. YouTube Data API key (optional)

**Summary:** Adds YouTube Shorts as a second trend source. AI-video trends usually show up on both platforms. Free; no billing needed.

**Steps**

1. Go to **console.cloud.google.com**, sign in and create a project called "reels-engine".
2. **APIs & Services** → **Library** → search "YouTube Data API v3" → **Enable**.
3. **APIs & Services** → **Credentials** → **Create credentials** → **API key**, then copy it.
4. Click the key → **API restrictions** → **Restrict key** → select **YouTube Data API v3** → **Save**.
5. Put it in `.env` as `YOUTUBE_API_KEY`. Don't enable billing.

**Done when:** doctor shows YouTube as `VALID`.

---

## M10. Hugging Face token (optional)

**Summary:** Lets the system try a few free AI video clips a day (a free account gets about 5 GPU-minutes daily), used only for hook shots. If a clip fails, the system uses animated AI images instead, so nothing breaks.

**Steps**

1. Sign up free at **huggingface.co** and verify your email.
2. Profile picture → **Settings** → **Access Tokens** → **Create new token** → type **Read** → copy it.
3. Put it in `.env` as `HF_TOKEN`.

**Done when:** doctor shows Hugging Face as `VALID`.

---

## M11. GitHub account and CLI login

**Summary:** GitHub stores the project and runs it on a schedule for free, even when your Mac is off. Claude Code tests this early (T1.7) with a tiny workflow, before building the full automation.

**Steps**

1. Create a free account at **github.com** if you don't have one, and turn on two-factor authentication (**Settings** → **Password and authentication**).
2. In Terminal, run `gh auth login` and choose: GitHub.com → HTTPS → Yes (authenticate Git) → Login with a web browser. Copy the one-time code, paste it in the browser and click **Authorize**.
3. Tell Claude Code: *"GitHub login done."* It creates the repository (private by default) and pushes the code.
4. Before uploading any secret, Claude Code shows you the **exact list of names** it will upload (from `02_PROGRESS_AND_KEYS.md`, section 4). Check it and reply "confirmed". It never uploads your whole `.env`, and never uploads your Meta app secret.

**Done when:** `gh auth status` shows you're logged in, the repo appears on github.com with an **Actions** tab, and `gh secret list` shows only the confirmed names.

---

## M12. Confirm the watchlist

**Summary:** This is the list of Instagram accounts the system checks every day for trending AI videos. It's how the system "scrolls" for you, within Instagram's rules. Only Business or Creator accounts can be scanned. Start small (10–20 accounts) and grow the list once scanning works smoothly.

**Steps**

1. Claude Code proposes about 20–30 candidates in `brand/watchlist.json`, with a note on each.
2. Open each one in Instagram. Keep accounts that:
   - post AI-generated videos in your niche
   - posted within the last 2 weeks
   - have reels with views well above their follower count (a sign Instagram is pushing them)
3. Remove repost or aggregator pages; they teach the system bad habits.
4. Add any accounts you already like.
5. Tell Claude Code: *"Watchlist confirmed."* Each scan reports and skips accounts that can't be scanned.

**Done when:** 10–20 usernames are confirmed. Refresh the list monthly and grow it toward 100 once Claude Code reports that scanning is stable.

---

## M13. Review sample reels

**Summary:** You're the creative director. You check the look, voice and hooks before anything goes public. This happens three times: after the first complete reel (T2.7), after one sample per format (T3.8), and after the first trend-driven dry run (T4.8).

**Steps**

1. Claude Code tells you where the videos are (in the `out/` folder). Open them on your Mac.
2. Watch each one twice: once as a scroller (would you stop in the first second?), then once for details.
3. Give specific feedback: fonts, colours, voice speed, music volume, caption size, hook wording, mascot design.
4. Repeat until you'd happily post it yourself.

**Done when:** you tell Claude Code "approved".

---

## M14. Approve the first live test post

**Summary:** The first real post is a **trial reel**, which Instagram shows only to non-followers, so a mistake won't reach your followers. Claude Code asks you at that exact moment, and your approval covers only that exact video and caption.

**Steps**

1. Claude Code shows you the final video, caption and QA report and asks *"Publish this test reel now?"*
2. Reply "yes", or ask for changes. If anything changes, you'll be asked again.
3. In Instagram, check that the trial reel appears (look in your Professional dashboard or Reels tab) and that the caption is right. Tell Claude Code you've seen it.
4. **If you want it removed**, delete it in the Instagram app (open the reel → **…** → **Delete**).

**Done when:** you confirm you've seen it. Publishing mode stays unchanged until you decide (M15).

---

## M15. Approvals and switching modes

**Summary:** You stay in control at every step. The system goes live in stages (**dry run**: nothing posts → **approval**: you tap Approve in Telegram → **auto**: fully automatic), and it never moves to the next stage by itself. Comment replies and automatic learning have their own separate switches.

**Steps**

1. After at least 3 clean days of dry runs on GitHub, read the daily reports (they include the measured minutes and quotas). If you're happy, tell Claude Code which cadence you want and: *"Switch to approval mode."*
2. Each morning, around 06:00 IST, Telegram sends the day's reels. Tap **Approve** or **Reject** before the first slot (08:30 IST). Each approval covers only that exact video and caption; if a reel is regenerated, you get a fresh preview. Reels you don't approve aren't posted.
3. When you're confident (for example, after about 14 days with few rejections and no account warnings), tell Claude Code: *"Switch to auto mode."* The system may suggest this, but only your message changes it. You can switch back any time.
4. **Comment replies** start in approval mode (drafts arrive in Telegram). To let them post automatically, tell Claude Code: *"Set replies to auto."*
5. **Weekly learning** starts as proposals you approve in Telegram. To let small, reversible changes apply automatically, tell Claude Code: *"Set learning to bounded auto."*
6. **Emergency stop:** send `/pause` to your bot, or set `PIPELINE_PAUSED` to `true` (repo → Settings → Secrets and variables → Actions → **Variables**). Send `/resume` to continue.

**Done when:** each change is recorded in the mode-change log in `progress/DECISIONS.md`.

---

## M16. Ongoing maintenance (about 10 minutes a week)

**Summary:** Once it's running, the system only needs light check-ins from you.

- **Daily (1 min):** glance at the Telegram daily report, and handle anything marked `NEEDS_REVIEW`.
- **Weekly (5–10 min):** read the weekly learning report and approve or reject proposed changes; check Instagram → Settings → **Account status** for any warnings; reply personally to a few comments, which builds a real connection with your audience.
- **Monthly:** refresh the watchlist (M12). If your repo is private, check GitHub Actions usage (**Settings** → **Billing and plans**).
- **Yearly:** renew the Claude token (M2) and ask Claude Code to update the GitHub secret.
- **If Meta stops working** (doctor shows a Meta error or error 190): redo M6.
- **If you ever share a key by mistake:** send `/pause`, then follow "If a key leaks" in `02_PROGRESS_AND_KEYS.md` (section 4).

---

## M17. Licensed music (optional)

**Summary:** By default, the system makes its own background music, so there's no copyright risk. If you want real tracks, add them yourself.

**Steps**

1. Download only tracks whose license explicitly allows commercial use on social media (with no attribution, or with attribution you're happy to put in captions).
2. Save them as MP3 or WAV in `assets/music/<mood>/`.
3. Record each track in `assets/music/LICENSES.md`: title, artist, source link, license name and download date.
4. Tell Claude Code to switch the music source to "library".

Even "free" music can trigger copyright claims on Instagram. Procedural music avoids that.

---

## M18. Paid upgrades (when the page earns money)

**Summary:** Upgrade the parts that matter most for quality, in this order:

1. AI video clips for hook shots (Veo 3.1 Lite at about $0.05 per second, or Kling 3.0)
2. A better voice (ElevenLabs)
3. More reels per day

**Steps**

1. Create an account with the provider and add billing there.
2. Put the key in `.env` and tell Claude Code, which adds it to the GitHub allowlist after you confirm.
3. Ask Claude Code to set `MAX_DAILY_SPEND_USD` (for example `2`) and switch the provider (for example `VIDEO_PROVIDER=veo`).
4. Watch the cost line in the daily report.
