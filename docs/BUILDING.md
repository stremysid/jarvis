# Building Jarvis

Who builds each milestone, who reviews it, and what to do when a session
gets stuck.

The model is a junior developer with a senior on call. A session works its
milestone on its own. The moment it is genuinely stuck, it stops, commits
what works, and tells Sid which senior to call. It does not grind, and it
does not guess its way forward.

Milestones R0 to R10 are defined in
[the roadmap](plan/2026-09-03-jarvis-roadmap.md), section 7. Each has an
exit test a person can perform.

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
| R0 Deploy what exists | GPT-6 Astra, xhigh | Claude Opus 5, high |
| R1 Calling (v1.0) | GPT-6 Astra, xhigh | **Claude Opus 5, max** |
| R2 Home node and memory | GPT-6 Astra, xhigh | Claude Opus 5, high |
| R3 Hermes and PC control | GPT-6 Astra, xhigh | Claude Opus 5, high |
| R4 St. Remy | **Claude Opus 5, max** | GPT-6 Astra, xhigh |
| R5 Deadlines | GPT-6 Astra, xhigh | Claude Opus 5, high |
| R6 Send on command, Siri | GPT-6 Astra, xhigh | Claude Opus 5, high |
| R7 Profile and manager | GPT-6 Astra, xhigh | Claude Opus 5, high |
| R8 Errands, Tesla, wake word | GPT-6 Astra, xhigh | Claude Opus 5, high |
| R9 Dashboard, voice notes | GPT-6 Astra, xhigh | Claude Opus 5, high |
| R10 Later | GPT-6 Astra, xhigh | Claude Opus 5, high |

Two milestones are not on the default setting, and both for the same
reason — a quiet mistake there is expensive and hard to notice:

- **R1** is the release gate. Its review runs at max.
- **R4** touches a real business and a machine Sid's parents rely on. Claude
  builds it and GPT reviews, the reverse of everywhere else.

**Never let the same model build and review the same work.** That is the
cross-vendor gate from
[the builder prompt](plan/2026-08-jarvis-builder-prompt.md): nothing merges
on a single model's own sign-off.

Two models not to use here. **GPT Luna** is the cheap high-volume tier —
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
| 1 | GPT-6 Astra | xhigh |
| 2 | Claude Opus 5 | high |
| 3 | Claude Opus 5 | max |
| 4 | Claude Fable 5.1 | high |

Most stuck sessions are stuck on a wrong assumption, not on insufficient
reasoning. A fresh session with a different model breaks the assumption; the
same session at higher effort usually just builds a more elaborate version
of the same wrong answer. Sid measured this directly: running Sol at its top
tier for two days returned very little over the level below.

So: **fresh eyes before more effort.** Rung 4 is rare. If rung 4 is stuck,
the milestone's scope is wrong and the roadmap needs changing, not the
model.

When R4 is the milestone, the ladder starts at rung 3 and steps up to
rung 4; its reviewer escalates to Claude Opus 5 at max instead.

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
