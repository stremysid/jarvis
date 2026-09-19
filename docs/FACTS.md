# Facts

**Durable facts about Sid and his environment — the things that cannot be discovered from
the code.**

This file exists because of a specific, repeated failure. On 2026-09-17 Sid said his
school account cannot reach Google Cloud Console. That fact went into an agent's private
memory. `docs/HANDOFF.md` went on calling Classroom consent *"SID'S ACTION, one sitting.
Highest value per hour in the whole plan"*, so on 2026-09-18 another session read the
handoff, opened the runbook, and walked him through an impossible setup a second time.
The same shape had already happened with the D2L calendar feed.

The lesson is not "be careful". It is that **agent memory is private to one agent and the
repository is the only thing every session reads.**

## The three rules

1. **Before asking Sid anything, search this file for the subject.** If the answer is
   here, use it. An answer he has already given once is not a question to ask again.
2. **A fact that contradicts another document is not recorded until that document is
   fixed, in the same change.** A new fact that leaves the old claim standing makes the
   repository disagree with itself, which is worse than not recording it.
3. **Every row carries a source and a date.** No bare assertions. `scripts/check-state.mjs`
   enforces this, and lists rows whose "still true?" is unset or older than 30 days.

## What belongs here, and what does not

| Belongs here | Goes elsewhere |
|---|---|
| Hardware, accounts, platforms, permissions, constraints about Sid or his environment | How the code works → `ARCHITECTURE.md` |
| What he has already set up, ruled out, or decided about the outside world | Defects and unproven guarantees → `KNOWN_ISSUES.md` |
| Durable operational facts a session would otherwise re-ask or re-derive | Product decisions → `DECISIONS.md` |
| | Current state → `STATE.md` · work in flight → `QUEUE.md` |

## The register

| Fact | How we know | Observed | Still true? |
|---|---|---|---|
| The school account is **Microsoft 365**; it cannot reach `console.cloud.google.com`, so Google Classroom OAuth credentials cannot be obtained | Sid stated it directly; a reviewer session had walked him through the setup a second time before recording it | 2026-09-17 | yes |
| Consequence: **Classroom has no usable route.** The REST client is wired but credential-blocked; no Classroom handling exists in the email parser; the notification-email route was proposed, not built | Code read at `5a8acf3`; `GOOGLE_CLASSROOM_EMAIL_FROM_DOMAINS` occurs zero times in `src` | 2026-09-18 | yes |
| LDSB Brightspace exposes **no calendar or iCal feed**, so `BRIGHTSPACE_ICAL_URL` has no value to hold. **Never ask him for one** | `KNOWN_ISSUES.md`; the board's configuration | 2026-09-15 | yes |
| School deadlines work by **notification email**: Outlook web forward to `school@onesid.ca`, done by Sid, with Cloudflare Email Routing wired to the gateway's `email()` handler | Sid set it up; code at `index.ts:705-710` | 2026-09-17 | yes |
| The fleet is a **Windows 11 home PC, a Windows 11 laptop, an iPhone 16**, and a Tesla as an integration rather than a host. There is **no server, NAS or VPS** | `CLAUDE.md`; Sid | 2026-09-18 | yes |
| **There is no Linux machine and Sid has never used Linux.** A bash, `systemd` or `chmod` instruction is not something he can run | Sid, repeatedly | 2026-09-18 | yes |
| The home PC is **off overnight while he sleeps**, so "always-on" means "on except overnight" | Sid | 2026-09-18 | yes |
| His timezone is **Eastern**; the machine reports UTC−4 during daylight saving and will report UTC−5 after it ends | Machine clock, 2026-09-19 | 2026-09-19 | yes |
| DeepSeek **peak** pricing is UTC 01:00–04:00 and 06:00–10:00, **Monday–Friday**; everything else is off-peak at half price. In his time that is 9 pm–midnight and 2–6 am | The published Beijing 9–12/14–18 footnote, verified against the project's own cost code | 2026-09-19 | yes |
| The repository now lives at **`stremysid/jarvis`** (an organisation), not `ksid1229-ops/jarvis`. The old URL redirects, so pushes still work, but anything hardcoding the old path is stale | The transfer, verified 2026-09-19 | 2026-09-19 | yes |
| That organisation is on a **GitHub Enterprise trial** — 50,000 Actions minutes a month versus 2,000 on Free. No payment method is attached, so overage stops rather than bills | Org settings; GitHub's own plan documentation | 2026-09-19 | yes |
| CI was dead from 2026-09-12 on billing and **came back on 2026-09-19** when the repository moved into the organisation | Workflow runs before and after the transfer | 2026-09-19 | yes |
| `hermes-runtime` passes on CI, so `$KnownPreExistingFailures` in `reviewer-tools/gate.ps1` — four named hermes security tests — is **stale**. CI is the authority on which tests fail, not a list in a script or a prompt | The completed `main` run of 2026-09-19: `hermes-runtime suite (windows)` green | 2026-09-19 | yes |
| **No payment method is attached to the personal GitHub account**, deliberately, after an unexpected usage charge. Metered usage there stops rather than bills | Sid | 2026-09-19 | yes |
| The only Windows user profile on this machine is **`Sid`**. The `Ksid1` profile named by older documents never existed | The filesystem; a corrected `AGENTS.md` trap | 2026-09-18 | yes |
| `python` on `PATH` resolves to a real Python 3.12.6, and `uv` is on `PATH`. The older "python is a broken stub" claim is retracted | `python -V`; corrected `AGENTS.md` | 2026-09-18 | yes |
| The agent presets are **outside the repository**, under `~/.dsh/.agent-presets/` — `jarvis-builder` and `jarvis-auditor`. They carry the standing rules for headless sessions | The preset files; `reviewer-tools/dsh-relay.ps1` layers them | 2026-09-19 | yes |
| **Contested:** `README.md` calls the Twilio number *"a purchase"* while the roadmap says Sid already owns the number and credentials. One of the two is wrong and neither cites evidence | Two documents disagree; no citation in either | 2026-09-19 | **unknown — confirm with Sid** |

## Adding a row

One line. `fact | how we know | date observed | still true?` — and if it contradicts
something, fix that something in the same commit.
