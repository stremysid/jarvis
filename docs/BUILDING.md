# Building Jarvis

Who builds, who reviews, and what to do when a session gets stuck.

The model is a junior developer with a senior on call. A session works its
item on its own. The moment it is genuinely stuck, it stops, commits what
works, and tells Sid which senior to call. It does not grind, and it does not
guess its way forward.

Work is ordered by [the roadmap](plan/2026-09-19-jarvis-roadmap.md)'s seven
phases and tracked item by item in [QUEUE.md](QUEUE.md). There are no milestone
numbers. A brief that cites one is citing a deleted document.

---

## The one rule

**A session builds until its item's done-when holds, or until it is stuck.
Stuck means stop and report. Never grind.**

Grinding is the failure this project has already had. An unsupervised
session with no stop condition produced a 1,366-line plan requiring a Rust
extension, and 15,000 lines of attestation tooling verifying artifacts that
were never fetched. Nothing was wrong with the model. Nothing told it to
stop.

---

## Who builds and who reviews

| Role | Who |
|---|---|
| **Build** | GPT-5.6 Sol or DeepSeek V4.1 Flash, whichever Sid starts. A builder never merges its own work |
| **Build, when a GPT builder is stuck** | A Claude builder — never Fable 5.1 |
| **PR review** | Claude, at the PR's exact head, before merge |
| **Independent pass on a reviewer-authored PR** | DeepSeek. The reviewer does not clear its own work |

**Never let the same model build and review the same work.** Nothing merges on
a single model's own sign-off.

**A new code-side judgment is a blocking finding.** If the diff adds code that
decides meaning, relevance, how many, which, how long, or whether to act, the PR
does not merge until that decision moves to the model (a tool argument or the
prompt). Registering it in [CODE-VS-JUDGMENT](CODE-VS-JUDGMENT.md) does not
clear it. Permissions, id validation and named system-protection limits are not
judgments; see [AGENTS.md](../AGENTS.md).

Two kinds of change are reviewed at max rather than the default, because a
quiet mistake there is expensive and hard to notice:

- **Calling (Phase 5)** — it is the release gate for live phone calls.
- **A migration that runs on live data.** Code can be reverted. A migration
  that has already run on the production database cannot, and its damage is
  silent until something reads the wrong rows back.

**St. Remy is out of scope for this repository.** Its code lives in its own
chat and is not touched from a Jarvis session.

Models not to use here. **GPT Luna** is the cheap high-volume tier — wrong for
writing this code. **Claude Fable 5.1** is not used at all, on cost.

---

## When to stop and call the senior

Stop at the **first** of these. Each one means the next attempt is unlikely
to be better than the last.

**Stuck on the work:**
- The same test or check has failed three times against three different
  fixes. The diagnosis is wrong, not the fix.
- Two full attempts at one item and its done-when still fails.
- The failure is in code the item does not touch and no fix exists on any
  branch.

**Out of scope:**
- The fix needs a new service, a new abstraction, or more than about 200
  lines that the roadmap does not name.
- Finishing the item would require starting a different one.

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
| 1 | The builder, in a fresh session | default |
| 2 | A different vendor | xhigh |
| 3 | Claude Opus 5 | max |

Most stuck sessions are stuck on a wrong assumption, not on insufficient
reasoning. A fresh session with a different model breaks the assumption; the
same session at higher effort usually just builds a more elaborate version
of the same wrong answer. Sid measured this directly: running Sol at its top
tier for two days returned very little over the level below.

So: **fresh eyes before more effort.** If rung 3 is stuck, the item's scope is
wrong and the roadmap needs changing, not the model.

---

## What to tell Sid when you stop

Enough that the next session starts from where you stopped rather than from
nothing:

1. **Which phase and which item.**
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

Then update [QUEUE.md](QUEUE.md) with what is left. That is how the next
session avoids repeating your dead end.

---

## Running several sessions at once

**Parallel is safe for reading and dangerous for writing.**

Reading cannot collide, so fan out freely. The review pass parallelises well
too — one checking security, one correctness, one whether the diff matches the
roadmap.

Writing collides. Two sessions editing this repository at once will overwrite
each other, or one will change an interface the other depends on, and each
will look correct in its own window.

So: **one building session per item that touches the same files.** Two
building sessions run at once only on items that share no files, in separate
git worktrees.
