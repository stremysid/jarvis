## 2026-09-15 06:04 UTC — Claude Opus 5, PR #41 review at 607bbf8: changes requested

This is a docs-only review of the school and university plan (`c522e8d`): `docs/plan/2026-09-15-school-university-plan.md` plus the roadmap, DECISIONS and NEXT_STEPS changes. The branch merges cleanly with main at `0d659bf`. `git diff --check` is the only local evidence, which fits a docs PR. The red CI badges are the account billing gate, not test results.

**What is right.**
- The priority order is correct: R5 directly after R1 and R2, ahead of R3 and R4.
- Gathering information by conversation with no forms matches Sid's requirement.
- The tap rule covers spending, sign-ups, submissions, transcript release and contacting another person.
- Platform text is treated as untrusted.
- The date-verification rule (cycle, source_url, verified_at; no prior-cycle copying) is exactly right.
- The calendar is split R6 read / R7 write.
- Each code slice is a separate PR, and there are no Linux or paid dependencies.

**Fact-check** (Opus pass against official sources, `reviewer-tools/pr41-factcheck.md`).
- **Correct:** the OUAC 2027 application opens "late September"; OUInfo covers 2027–28; Group A grades come from the high school; Brightspace OAuth needs admin registration in Manage Extensibility; Classroom `dueDate`/`dueTime` are UTC. No date was invented.
- **Unverified:** the OUAC key-dates page refused automated fetches (403). Third-party dates seen in search are not official and must not enter the plan.
- **Wrong** (reviewer-verified): "date-only work keeps date-only semantics" doesn't fit the existing store. `deadlines.due_at` is `TEXT NOT NULL` (`0011_deadlines.sql:32`, `:54`), so date-only support needs a schema change and a migration number. Say so.

**B1. The build order doesn't match Sid's urgency.** He is two weeks behind in grade 12, and university applications open in about two weeks. Yet the university tracker is slice 5, after Classroom, coaching and Brightspace.
- Slice 1 (the catch-up conversation) and a minimal university tracker (program shortlist; requirements and dates from current official sources, visibly verified or unverified) need only the live stack: Telegram, D1, the model and the deployed gateway. They need neither R2 nor any platform integration.
- Reorder to:
  1. catch-up conversation and per-course plan on the live bot;
  2. minimal university tracker;
  3. Brightspace calendar feed (B2) and Classroom deadlines in the digest;
  4. study coach, quizzes and flashcards;
  5. grades and missing work;
  6. full application and document workflow;
  7. calendar bridge.
- Also reconcile DECISIONS ("after R1 and R2") with the plan ("alongside"). Sid's decision is to start now, in parallel.
- Name what integrates with R2 memory later, without gating the early slices on it.

**B2. The Brightspace options are missing the safest one, and B and C carry an unflagged terms risk.**
- **Add option D, the student calendar subscription feed.** Brightspace gives a learner a tokenised iCal URL with due dates for assignments, quizzes and content. The org setting `d2l.Tools.Schedule.AllowCalendarFeeds` is on by default, but a board can disable it, so it is unverified for Sid's board. A Worker can poll it with every PC off: no login, no MFA, no school approval, no browser, no cost. It carries no grades or submission status. Pair it with Brightspace notification emails for grades and feedback, if available.
- **Make D first for deadlines.** Keep A as the upgrade if the board ever approves an app. That requires contacting the school, which is Sid's tap and could take weeks.
- **Flag the terms risk in plain words.** D2L's Brightspace EULA §6 restricts using "any robot, spider or other automatic program" to extract information. Options B (cloud browser) and C (automated Windows browser) are exactly that. Whether it binds a student directly or through the board's licence and acceptable-use policy is unverified. Keep B and C behind that check. C also needs PC browser automation the repo doesn't have (that is R3 territory).
- **Decide the route in the plan** (D, then A if possible), rather than asking Sid a design question. Ask Sid only for the things only he can do: copying his calendar-feed link, and any school contact.

**S1. The Classroom blockers aren't named.** Each could stop Classroom access entirely, so name each with a preflight and a fallback to owner-reported items:
- the school admin can disable third-party Classroom API data access;
- accounts designated under 18 are blocked from unconfigured third-party apps until an admin allows them (Google Workspace access-control docs);
- OAuth apps in Testing mode issue refresh tokens that expire after 7 days, and production use of restricted scopes may need app verification.

**S2. Requirements coverage.**
- "Check D2L now", an on-demand refresh, is missing.
- MFA via Telegram (Sid, Sep 14) was dropped; restate it for any route that needs a login.
- The view-only rule (Jarvis never submits or changes anything on Classroom or D2L) needs to be explicit.
- Plain-speech owner controls ("forget that", no commands to learn) should be stated for the coach's weak-area records.
- Classroom has no "missing" state, so missing work must be derived and labelled as derived.

**Next.** Revise the plan and the roadmap/DECISIONS/NEXT_STEPS text for B1, B2, S1 and S2, then request re-review. After clearance, the first code PR is the catch-up conversation and minimal university tracker on the live bot. Classroom wiring and the Brightspace feed follow as separate PRs.

Sid retains merge authority. This PR changes no runtime, account, secret, migration or deployment.
