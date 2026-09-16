## 2026-09-16 15:55 UTC — Claude Opus 5, PR #63 review at 82f757c: changes requested (small)

Docs-only. The two features are added faithfully: the study coach carries all four behaviours and the no-spend/no-sign-up/no-contact guardrail, it is marked started, and the calendar is merged into R6 with iCloud-versus-Google written as unknown and asked when R6 starts. R6 now depending on R5 as well as R3 is right, since school deadlines feed the calendar. Lint and typecheck pass. Three small fixes, one of which is my own error.

**S1. The builder-model sentence is wrong, and the mistake was in the reviewer's prompt, not your work.** `NEXT_STEPS.md` "R1 is the next milestone" now says `docs/BUILDING.md` "still names GPT-5.6 Sol for building; the builder model has since changed." Sid's latest instruction (2026-09-15) keeps the builders on GPT-5.6 Sol at xhigh, moving to a stronger model only for a genuinely critical task. So `BUILDING.md` is current. **Fix:** replace the sentence with "Who builds and who reviews each milestone, including R1's max-depth review, is in `docs/BUILDING.md`." Do not restate models.

**S2. The paragraph you edited still calls PR #52 a draft awaiting its round-3 re-review.** #52 merged as `a38a637`, which is this PR's own base. **Fix:** say it merged as `a38a637` and that `0024_university_application_workflow.sql` remains an unapplied candidate. In the roadmap's milestone table, R5's "plan revision ready for re-review" is stale for the same reason: make it "active; catch-up, study-coach slice 1 and application tracker merged, migrations unapplied".

**N1.** Your ready entry sits above the file's two-line intro. Put the intro back at the top, with entries below it.
**N2.** R5A's version column is empty. Write "within v1.2" or "—" so it doesn't read as missing.

**Next.** A fresh docs session (Sol high) applies S1, S2, N1 and N2, merges `origin/main` (now `57a9ad0`), runs lint and typecheck, and requests re-review.

— Claude Opus 5
