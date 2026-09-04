# Next steps

## R0 stopped before item 1 (2026-09-04)

The requested `docs/BUILDING.md` and
`docs/plan/2026-09-03-jarvis-roadmap.md` are absent from `main` at
`aadd5b2b02000633e969bfbfbe9ea8c6d55ef06d`. Both direct reads failed, and
neither file appears in the tracked-file or working-tree inventory.

Make the already-written files available at those paths before beginning
R0. Its seven items and exit test cannot be established from this checkout.
No implementation attempt or exit test ran. The older backlog below does
not substitute for the requested authoritative roadmap.

## What Sid has to do before any of this runs

Nothing below works until these are done. They need a person.

1. **Rotate the credentials that were pasted into a chat.** Three peppers
   (`GUEST_PIN_PEPPER_V1`, `AUTHENTICATION_BUDGET_PEPPER`,
   `IDENTITY_CHALLENGE_HMAC_PEPPER`), the DeepSeek API key, and the PIN
   verifier. Anything that has been in a transcript is compromised. Generate
   each by piping straight into `wrangler secret put` so the value never
   appears on screen or in shell history.

2. **Deploy.** The Worker in production predates every subsystem below.
   Applying migrations 0008-0013 and deploying is what makes the crons,
   commands and decision buttons exist at all.

3. **Set the new secrets** the scheduled jobs read:
   `OWNER_PRINCIPAL_ID` (required -- the digest has nobody to send to
   without it), `DIGEST_TIMEZONE`, `TELEGRAM_BOT_USERNAME`, and optionally
   `GITHUB_TOKEN`. A missing optional one disables its job cleanly rather
   than failing it.

4. **Deploy the watchdog** as its own Worker, with its OWN Telegram bot and
   chat. Rotating the gateway's token during an incident must not take out
   the alert path at the moment it is needed.

## Built and unwired

These have code and tests and nothing calls them yet.

- **Google Classroom ingestion.** `classroom-client.ts` and
  `deadline-ingestion.ts` exist; the hourly poll job does not call them,
  because no deployment holds the Google OAuth credentials. Until it does,
  `deadline_sources` has nothing writing to it and the deadline half of the
  digest is empty rather than stale.
- **The Brightspace scrape.** Deliberately not built. It needs a real browser
  session and belongs in the local agent. `RawDeadlineItem` is the interface
  it feeds.
- **Deadline status.** Nothing sets `submitted`, `missed` or `cancelled`. The
  grade and missing-work watch is what closes this.
- **Decision expiry.** `listOpenQueue` filters lapsed items out of the queue,
  and nothing moves their status to `expired`. The drain job should sweep
  them.
- **`project()` in the vault.** The write path has no authority gate in front
  of it. See KNOWN_ISSUES.

## The release gate

**Live calling is v1.0.** The plan is explicit: Jarvis is not released until
Sid can phone it from the car. The voice code is built and fail-closed. It
needs five Twilio credentials and a Canadian local number, which is a
purchase and therefore Sid's to make.

## The two-stage Obsidian adapter

Stage one shipped -- see DECISIONS.md. Stage two is the Rust/PyO3 bridge:
NTFS object identity, retained handles, namespace fences, USN journal replay,
Cloud Files detection, and VSS backup. It closes every gap listed under the
vault entries in KNOWN_ISSUES.md.

**The redactor comes first.** Vault observations are stored verbatim with no
redaction, so building the cloud upload path before the redactor would ship
Sid's notes to the gateway unredacted. It is a prerequisite for O2/O3/O4, not
a follow-up.

## Hermes H1

Tasks 0-9 are on `main`. Task 10 is started on `codex/hermes-h1-task10`; the
rest installs two Windows services with dedicated accounts and protected
DACLs, and needs an elevated shell. Tasks 11-13 follow.

Finishing this track yields a hardened local model runtime, not a shippable
0.1.0 -- nothing in Tasks 10-13 touches Telegram, memory, or deployment.

## Smaller, worth doing

- Clear the 117 type errors `pnpm --filter @jarvis/cloud-gateway
  typecheck:tests` reports, then make it a CI gate.
- Move the Telegram rate limiter and the provider circuit breaker into a
  Durable Object. Both are per-isolate today.
- Give the watchdog a list of components that MUST report, so one that never
  registers is not silently unwatched.
- Point an external uptime monitor at the watchdog's `/health`. Nothing
  watches the watchdog.
- A process bootstrap for the local agent: there is no `jarvis service`
  command and no Windows service host, so the run loop cannot be started.
