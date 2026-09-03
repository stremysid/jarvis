# JARVIS BUILD — Session 1 Kickoff

You are building Jarvis, Sid's personal assistant system. `jarvis-expansion-plan.md` (in this folder) is the source of truth — read it fully before writing anything. This prompt sequences the work and sets the rules; the plan carries the design.

## What already exists — do not rewrite for taste
- A built-but-never-run local agent: HUD, local server, Claude brain with SQLite memory, PC-control tools, voice stack — the `jarvis` folder (Sid will place it in this workspace)
- A Phase-1 Telegram bot (Cloudflare Worker + D1 + Claude API), written, never deployed — the `sid-assistant` folder
- Work from these codebases and their existing stack. Refactor only where the plan requires it (HUD demoted to on-demand view, memory rebuilt two-tier). Sid's standard is explicit release gates over speculative changes.

## Session 1 objectives, in order
1. Create the private GitHub repo under Sid's project standard: README.md, AGENTS.md, VERSION, CHANGELOG.md, NEXT_STEPS.md, KNOWN_ISSUES.md, DECISIONS.md, REQUIREMENTS.md, TESTING.md, docs/HANDOFF.md. Seed REQUIREMENTS.md from plan §1–9, DECISIONS.md from the resolved-decisions list, NEXT_STEPS.md from the build order. Main stays stable; work on feature branches; focused commits.
2. Import the existing `jarvis` + `sid-assistant` code as the initial commit (as-received state, so provenance is clean).
3. Build-order step 1: deploy the Telegram bot to Sid's Cloudflare account (Workers Paid is already active). Verify a full round-trip: Sid messages the bot, the bot replies via the Claude API.
4. Build-order step 2: two-tier memory per plan §7/§8 — raw append-only archive + distilled SQLite + content-hash dedup + local embedding index — migrating the existing SQLite memory in.
5. Stop. Session 2 builds build-order step 3 — live calling (Twilio + ConversationRelay), which is the v1.0 release gate: Jarvis is not "released" until Sid can phone it from the car. Steps beyond belong to later sessions.

## Working rules
- Run freely on execution; stop and check in at genuine decision points — approach changes, schema choices, anything that shapes the rest. Once the Telegram bot is live, use it to reach Sid's phone for exactly this.
- Honor the plan's hard design rules: background-first tray service and resource budget (§6), tiered autonomy + prompt-injection defenses + memory promotion rules (§4, §8), model-cost tiering (Haiku for distillation/triage, the big model only for reasoning-heavy work).
- Shadow mode precedes any tier-2 autonomy (§8). Enable no autonomous actions in session 1 at all.
- Never touch the St. Remy repo, codebase, or its Cloudflare resources — the `st-remy-wholesale` worker and its D1 are off-limits; St. Remy dev lives in its own dedicated Claude Code chat. How Jarvis eventually reads Penny Lane/St. Remy data is an OPEN decision: do not implement it, log it as open in DECISIONS.md.
- Scraper conduct (future sessions, but record it now): LDSB Brightspace scraping is polite — a few runs daily, Sid's real browser profile, alert-don't-silently-fail, human-in-the-loop for MFA (§3). No aggressive polling.
- Credentials live in a local encrypted store only; never in code or commits. `.env` is gitignored from commit zero.

## Sid's side — confirm each with him before it blocks you
- [ ] Anthropic API key into `.env`
- [ ] Telegram bot token (via BotFather) into `.env`
- [ ] OpenAI API key into `.env` (Whisper STT for voice notes)
- [ ] Twilio account + Canadian local number purchased (needed for session 2's calling build)
- [ ] Existing `jarvis` + `sid-assistant` folders placed in this workspace
- [ ] Later sessions: BIOS "Power On by RTC Alarm" at 7:30 · disable mic audio enhancements before knock work · Tesla Fleet API registration

## Known-pending inputs — do not guess
- `knock_probe.py` results (zone feasibility). Pattern-based knocks are the committed baseline regardless of outcome.
- This session's machine: the laptop is the decided first deploy target; the home PC is a later second install via the shared backend.

## Session-end deliverable
Pushed repo under the standard, a live Telegram round-trip, two-tier memory passing tests, CHANGELOG/NEXT_STEPS/docs/HANDOFF.md updated — and a message to Sid's phone summarizing state, what shipped, and the next decision points.

Cross-review gate: session output goes to a second model (a different vendor than the builder) for an adversarial audit against the plan and repo standard before merging to main. Expect findings back as your next input; nothing releases on a single model's own sign-off.
