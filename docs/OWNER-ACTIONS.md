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
| Load the R1 bindings on the gateway | `OWNER_PRINCIPAL_ID`, `IDENTITY_CHALLENGE_HMAC_KEY_VERSION`, `OWNER_PASSPHRASE_PEPPER_V1`, `PUBLIC_ORIGIN`, `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_E164` — plus `DEEPSEEK_API_KEY` if not already set. Runbook: `docs/runbooks/deploy.md` | **not started** |
| Enroll the owner phone | `docs/runbooks/owner-phone-enrollment.md`. `/call` dials "your verified phone"; without this it has nothing to dial | **not started** |
| Apply pending migrations, then deploy | `docs/runbooks/deploy.md` — migrate **before** deploying, in that order | **not started** |
| Run the live smoke and commit the redacted evidence | `pnpm smoke:voice`, then `pnpm release:voice-gate`. Both are built and neither has ever been run against production | **not started** |

**Not yet on this list, and deliberately so:** composing the tool-calling agent into
the call session. Until that exists, the four rows above buy a phone call that can
talk and cannot act. It is a builder task, and it is in the queue.

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
| Confirm the doc consolidation is acceptable | Merging `CLAUDE.md` into `AGENTS.md`, folding `NEXT_STEPS.md` into `STATE.md`, marking the seven documents roadmap §6 already ordered superseded. The only fact that must survive the merge is the fleet paragraph in `CLAUDE.md` |
| Re-check disk load after the agents serialise their test runs | See below — this is a decision about whether $260 is needed |

## Rule

A session that needs something from Sid adds a row here **in the same commit** as the
work that needs it. A session that needs the same thing twice reads this file first.
