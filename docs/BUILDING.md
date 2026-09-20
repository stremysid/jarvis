# Building Jarvis

Who builds each milestone, who reviews it, and what to do when a session
gets stuck.

The model is a junior developer with a senior on call. A session works its
milestone on its own. The moment it is genuinely stuck, it stops, commits
what works, and tells Sid which senior to call. It does not grind, and it
does not guess its way forward.

The roadmap is [the 2026-09-19 roadmap](plan/2026-09-19-jarvis-roadmap.md),
written by Sid: seven phases, and no milestone numbers. The `R` numbers in this
file are names carried over from the superseded `2026-09-03-jarvis-roadmap.md`
§7 and have **not** been re-mapped to those phases. Do not open work against an
`R` number from the old file.

---

## The arrangement

**DeepSeek builds. Claude reviews. Both do the deep final review.**

| Layer | Who | What it is |
|---|---|---|
| **Build** | DeepSeek | Writes the code for every milestone, runs the gates, pushes. A builder never merges its own work. |
| **PR review** | Claude | Every PR, at its exact head, before merge — so one vendor builds and a different one reviews, and nothing merges on its own author's sign-off. |
| **Deep final review** | DeepSeek **and** Claude | Not scoped to a PR. A whole-system pass at milestone exit, and the only review that may call something finished. |

The two review layers are not substitutes. A cleared PR is a statement about
one diff at one revision; the deep final review is a statement about the system
as it stands. A milestone can exit with every PR cleared and still fail the deep
final review — that is the second layer doing its job, not contradicting the
first.

---

## The one rule

**A session builds until its milestone's exit test passes, or until it is
stuck. Stuck means stop and report. Never grind.**

Grinding is the failure this project has already had. An unsupervised
session with no stop condition produced a 1,366-line plan requiring a Rust
extension, and 15,000 lines of attestation tooling verifying artifacts that
were never fetched. Nothing was wrong with the model. Nothing told it to
stop.

---

## Who runs each milestone

| Milestone | Build with | Review with |
|---|---|---|
| R0 Deploy what exists | DeepSeek | Claude |
| R1 Calling (v1.0) | DeepSeek | **Claude, max** |
| R2 Cloud memory | DeepSeek | Claude |
| R3 Hermes and PC control | DeepSeek | Claude |
| R5 Deadlines | DeepSeek | Claude |
| R6 Send on command, Siri | DeepSeek | Claude |
| R7 Profile and manager | DeepSeek | Claude |
| R8 Errands, Tesla, wake word | DeepSeek | Claude |
| R9 Dashboard, voice notes | DeepSeek | Claude |
| R10 Later | DeepSeek | Claude |

The vendor pair no longer varies by milestone, so this table assigns work rather
than models: **DeepSeek V4.1 Flash** builds and **Claude Opus 5** reviews, both
at their default effort unless a row says otherwise.

One milestone is not on the default setting, for the reason the old table gave
for two — a quiet mistake there is expensive and hard to notice:

- **R1** is the release gate. Its review runs at max.

**St. Remy is out of scope for this repository.** Its code lives in its own
dedicated chat and is not to be touched from a Jarvis session (`AGENTS.md`).
There is no R4 row here any more: do not re-add one from the superseded roadmap.

One kind of change is not on the default either, whatever milestone it lands
in: **a PR that applies a migration to live data gets reviewed at max.** Code
can be reverted. A migration that has already run on the production database
cannot, and its damage is silent until something reads the wrong rows back.

**Never let the same model build and review the same work.** That is the
cross-vendor gate from
[the builder prompt](plan/2026-08-jarvis-builder-prompt.md): nothing merges
on a single model's own sign-off.

Models not to use here. **GPT Luna** is the cheap high-volume tier —
right for the product's own distillation later, wrong for writing this code.
**Claude Fable 5.1** costs roughly double Opus 5 per token; it is the top of
the ladder below, not a default.

---

## When to stop and call the senior

Stop at the **first** of these. Each one means the next attempt is unlikely
to be better than the last.

**Stuck on the work:**
- The same test or check has failed three times against three different
  fixes. The diagnosis is wrong, not the fix.
- Two full attempts at one item and the exit test still fails.
- The failure is in code the milestone does not touch and no fix exists on
  any branch.

**Out of scope:**
- The fix needs a new service, a new abstraction, or more than about 200
  lines that the roadmap does not name.
- Finishing the item would require starting the next milestone.

**Contradiction:**
- The roadmap says one thing and the code does another, and it is not
  obvious which is right.
- Two documents in the repository disagree on something load-bearing.

**Blocked on a person:**
- A credential, a login, a purchase, or a permission is missing.
- The change would touch money, production, another person, or deletion,
  and no confirmation flow exists yet to gate it.

A reviewer stops on the same terms. A reviewer that cannot tell whether
something is correct says so and escalates; it does not approve to be
agreeable, and it does not reject to be safe.

---

## The escalation ladder

Climb one rung at a time. **Rung 2 is a different vendor, not more
effort** — and that ordering is deliberate.

| Rung | Who | Effort |
|---|---|---|
| 1 | DeepSeek — the builder, in a fresh session | default |
| 2 | Claude — a different vendor | xhigh |
| 3 | Claude | max |
| 4 | Claude Fable 5.1 | high |

Most stuck sessions are stuck on a wrong assumption, not on insufficient
reasoning. A fresh session with a different model breaks the assumption; the
same session at higher effort usually just builds a more elaborate version
of the same wrong answer. Sid measured this directly: running Sol at its top
tier for two days returned very little over the level below.

So: **fresh eyes before more effort.** Rung 4 is rare. If rung 4 is stuck,
the milestone's scope is wrong and the roadmap needs changing, not the
model.

---

## What to tell Sid when you stop

Enough that the next session starts from where you stopped rather than from
nothing:

1. **Which milestone and which item.**
2. **What you tried** — each attempt and what happened, briefly.
3. **The exact error**, test name, or failing command.
4. **What you believe the blocker is**, and how confident you are.
5. **Which rung to try next**, and why.
6. **Where the work stands** — the commit, and what passes and fails on it.

Never include a credential value. Name the secret, never print it.

---

## Before you stop

**Commit what works.** A stuck session that leaves a clean commit costs one
session. A stuck session that leaves a dirty working tree costs two, because
the next one spends its first half working out what state the repository is
in.

Then update `NEXT_STEPS.md` with what is left in the milestone, and add
anything you discovered to `KNOWN_ISSUES.md`. Those two files are how the
next session avoids repeating your dead end.

---

## Running several sessions at once

**Parallel is safe for reading and dangerous for writing.**

Reading cannot collide, so fan out freely: one session on the Hermes docs,
one checking what is already installed, one drafting a config. The review
pass parallelises well too — one checking security, one correctness, one
whether the diff matches the roadmap.

Writing collides. Two sessions editing this repository at once will
overwrite each other, or one will change an interface the other depends on,
and each will look correct in its own window. Inside a milestone the items
are mostly sequential anyway: R0 cannot deploy before it fixes the config.

So: **one building session per milestone.** That session may spawn as many
reading sessions as it likes. Two building sessions run at once only on
genuinely independent milestones, in separate git worktrees — R5 and R6
qualify once R3 is done.
