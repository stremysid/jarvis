# Owner actions

Everything that only Sid can do. Nothing here can be done by a builder or a reviewer
session — if it could, it would be in [QUEUE.md](QUEUE.md) instead.

**One row per action.** The whole point of this file is that an action cannot be
asked for twice: if it is already here, the answer is "see the row", not a second
request. That failure has happened — Google Classroom consent was ruled out on
2026-09-17 and walked through again on 2026-09-18, because the fact lived in an
agent's memory and never in the repository.

Last regenerated: 2026-09-18. Order within a section is the order to do them in.

## Blocking v1.0 — "phone Jarvis from the car"

| Action | Exact steps | State |
|---|---|---|
| ~~Load the R1 bindings on the gateway~~ — done; a real call has been placed | `OWNER_PRINCIPAL_ID`, `IDENTITY_CHALLENGE_HMAC_KEY_VERSION`, `OWNER_PASSPHRASE_PEPPER_V1`, `PUBLIC_ORIGIN`, `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_E164` — plus `DEEPSEEK_API_KEY` if not already set. Runbook: `docs/runbooks/deploy.md` | **not started** |
| Enroll the owner phone | `docs/runbooks/owner-phone-enrollment.md`. `/call` dials "your verified phone"; without this it has nothing to dial | **not started** |
| ~~Apply pending migrations, then deploy~~ | Done 2026-09-20: `0038` applied, Worker `74f2a003` and watchdog `c940f9b7` deployed | **done** |
| Run the live smoke and commit the redacted evidence | `pnpm smoke:voice`, then `pnpm release:voice-gate`. Both are built and neither has ever been run against production | **not started** |

**Not yet on this list, and deliberately so:** composing the tool-calling agent into
the call session. Until that exists, the four rows above buy a phone call that can
talk and cannot act. It is a builder task, and it is in the queue.

## Blocking the school half of the first release

| Action | Exact steps | State |
|---|---|---|
| Send one real Google Classroom notification, forwarded, so a parser can be written | The Classroom REST route is dead on this board, so the notification email is the only route. A builder session stopped rather than inventing the format: *"guessing at the format and shipping tests built on a guessed fixture is worse than nothing, because it would look like coverage."* Forward one real notification to the school mailbox and say so | **not started** |
| Say whether the forward is an **automatic M365 rule** or a **manual Outlook Forward** | It decides whether Classroom can work at all. Automatic M365 forwarding (SRS) preserves the original DKIM signature; a classic Outlook *Forward* recomposes the body, destroys it, and every message then quarantines as `from_domain_unpinned`. The repository models the first and records the second as unsettled | **not started** |
| Watch the first real D2L delivery land | Two assumptions in `d2l-email-authenticity.ts` are fail-closed only while they hold: Cloudflare's `authserv-id` string, and the delivered header order. Only a live delivery settles them, and the receipt keeps the evidence | **waiting on a real email** |

## Decisions only you can make

| Decision | Why it is yours | State |
|---|---|---|
| Is the deployed `DEFAULT_GUEST_PIN` equal to the committed test fixture value? | If it is, the guest PIN is in the repository. Only you can read the deployed secret | **unanswered** |
| CI: pay to revive it now, or enable it at the free 2026-10-01 reset? | It is a recurring cost. Recommended: the reset, after the fix-first pass | **unanswered** |
| Does the reviewer keep merge authority? | It is your authority being delegated | **unanswered** |
| Is there a second vendor for reviewer-authored PRs, or are they labelled unreviewed? | Needs a model you are willing to pay for | **unanswered** |

## Merges waiting on you

| PR | What it needs first |
|---|---|
| [#105](https://github.com/ksid1229-ops/jarvis/pull/105) | Reviewer clearance |
| [#106](https://github.com/ksid1229-ops/jarvis/pull/106) | Reviewer clearance, and the `0035` comment corrected first |

## Standing, one-time, or later

| Action | Notes |
|---|---|
| Re-check disk load after the agents serialise their test runs | See below — this is a decision about whether $260 is needed |

## Rule

A session that needs something from Sid adds a row here **in the same commit** as the
work that needs it. A session that needs the same thing twice reads this file first.
