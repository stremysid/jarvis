# Review protocol

**Status: proposal.** For the independent reviewer to accept, amend or reject.

A builder session wrote this, which is precisely the conflict the document exists to
close — the reviewer's job is being specified by the party it reviews. Sections 6 and
7 are here so it can be attacked rather than adopted.

Basis: the 2026-09-18 sweep at `main` = `5a8acf3`, and the redesign proposal of the
same date. The proposal is not yet in this repository — it is the document that
produced `docs/STATE.md`, `docs/QUEUE.md` and `docs/OWNER-ACTIONS.md` in PR #107.
Every number below is measured, not estimated.

---

## 1. Why this exists

| Measured | Value |
|---|---|
| Review objects GitHub records across 24 PRs | **1** — on #89, 28 seconds *after* it merged |
| PRs merged with no verdict and no log entry | **#101–#104 — 3,661 lines**, including the reviewer's own `gate.ps1`, `mutate.ps1` and manual |
| #104, at 2,215 lines | merged **14 seconds** after opening |
| `max` headings vs `xhigh` | **57 vs 0** — always on, so it reserves nothing |
| Owner actions in 48 h | **~38** — one per 76 minutes; 8 duplicative, 4 avoidable |
| Defects the *optional* read-only audit found in already-cleared code | **5**, one live in production |

The shape is right. The sweep's own verdict — and the reviewer's — is that the
process is expensive, not broken: one session is doing review, orchestration,
release management and documentation at once, with unbounded scope and no stop
condition.

---

## 2. What stays

Nothing here weakens these, and any amendment that does should say so explicitly:

- **The cross-vendor rule.** It stopped three High security defects in #91.
- **Claim-checking against receipts**, and **"run it as written"**. #106 caught a
  change that would have disabled memory correction in production.
- **Mutation testing as a technique** — retargeted by §5, never removed.
- **Post-merge verification** and **flake classification**.
- The owner's **merge, deploy, secret and migration authority**.

---

## 3. Five changes

### 3.1 Priority is a column, not a judgement

`docs/QUEUE.md` carries a `BLOCKS` field. A PR marked `BLOCKS: v1.0` is reviewed ahead
of tooling, documentation and research, within hours. The last calling PR waited 16
hours while review tooling was written — not because the reviewer chose wrong, but
because nothing in the loop ranked the two.

### 3.2 A verdict is a GitHub review object

Every clearance posts a review on the PR, not only a log entry. One review object
across 24 PRs is not a record; it is a file in another repository's history.

The verdict states: **the reviewed head sha** · the claims checked and how · the
falsifier for each finding · **what was not checked**. A verdict with no head sha is
rejected by `scripts/check-state.mjs`'s doc job once it is wired.

### 3.3 `max` means something again

`max` is reserved for R1 and for any PR whose migration touches live data — the rule
`docs/BUILDING.md` already states. Everything else is `xhigh`. Because a tier is
currently self-reported in a heading (one PR signed "max" and ran "high"), it must be
recorded where it can be checked rather than asserted in a title.

### 3.4 The hole: reviewer-authored PRs

The cross-vendor rule holds everywhere except where the reviewer is the author. Fix,
in order of preference:

1. **A second vendor reviews any PR the reviewer wrote.** Its tooling, its manual, its
   documents.
2. If no second vendor is available, the PR is **labelled `unreviewed`** in the queue
   and merged only by the owner, with that fact written in the merge commit.

Silence is the one option not allowed. `REVIEWER-MANUAL.md` says the branch holding
that tooling is "never merged" while PR #104 merged it — a document and a fact
disagreeing is how this rule failed quietly.

**This rule already exists** at `AGENTS.md` §"A reviewer-authored PR gets an
independent pass before it merges". This section supersedes nothing; it supplies the
two fallbacks that section leaves open. If the two ever disagree, `AGENTS.md` wins and
this file is corrected, because a new session is told to read `AGENTS.md` and is not
told to read this.

### 3.5 A stop condition, symmetric to "never grind"

`docs/BUILDING.md`'s stop rule binds builders only. The reviewer's manual tells it
*"something must always be moving, unless it's blocked on him"* — and with nothing
product-shaped it may touch, motion becomes tooling.

> No new tooling unless a named review was blocked by its absence. Every tool must
> name the defect it caught. When the queue holds nothing reviewable, say "nothing
> needs you" and stop.

---

## 4. The audit is promoted to mandatory

The independent read-only audit is currently optional and its findings are labelled
"latent". It found five defects in code the reviewer had already cleared, one live in
production. It becomes **mandatory for any PR touching authority, redaction, memory,
money, third parties or production**, and its findings block clearance.

---

## 5. Mutation testing, retargeted

Keep the technique; change where it is spent. Sweep 5 and the review record agree on
what it actually finds: **unpinned guards**, not wrong behaviour. In #90 all twelve
living-notes tests passed with the forgetting guard neutered. Its own ceiling is
stated by the reviewer in #95: *it proves a guard fires; it cannot prove the guard
reads the right input.*

- Run the mutation sweep for guards in the **money, third-party, deletion and
  production** classes, or where a surviving mutation would fail **silently**.
- Retarget re-runs to the **changed layers** rather than the whole suite on every
  re-review.
- A survivor is a finding about the **tests**, and it must be recorded as one.

---

## 6. What this costs, honestly

| Cost | Size |
|---|---|
| GitHub review objects | about a minute per PR |
| A second vendor for reviewer-authored PRs | money, and a model the owner must choose |
| Fewer hours for tooling | that is the point |

Against: attribution, a durable record, a bounded scope, and an owner who is not
asked the same question twice.

---

## 7. How to attack this

- **§3.1–3.5 assume the reviewer's bottleneck is scope.** The counter-case is that
  the reviewer was right to build tooling while nothing was reviewable, and that the
  real failure was a release-gate PR with no queue entry — a state-carrier problem,
  not a discipline problem.
- **§3.5 could suppress useful work** at exactly the moment a tool would help.
- **§5 narrows mutation coverage** on the strength of one window's evidence. The
  counter-case is that a silent survivor is only silent until it isn't.
- **§4's mandatory audit adds a second reviewer to the critical path**, which is the
  latency problem the sweep already identified.

---

## 8. What the reviewer must decide

1. Accept, amend, or reject §3.4 — and whether a second vendor exists.
2. Whether §3.3's tier should be recorded by a tool rather than a convention.
3. Whether §4's audit belongs before clearance or after.
4. Whether this document replaces the relevant sections of `REVIEWER-MANUAL.md`, or
   sits beside them. Two documents describing one role is the failure this repository
   has already had with handoffs.
