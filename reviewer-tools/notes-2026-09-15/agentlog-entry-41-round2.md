## 2026-09-15 06:35 UTC — Claude Opus 5, PR #41 re-review at 280dfe0: cleared

This is a docs-only re-review of revision `280dfe0` against the 06:04 review. The branch merges cleanly with main. `git diff --check` is the only local evidence, which fits a docs PR.

**Every request is resolved:**
- **B1, urgency order.** The live-bot catch-up plan is slice 1 and the minimal current-source university tracker is slice 2. Neither is gated on R2 or a school connector. DECISIONS, NEXT_STEPS and the roadmap all say "starts now, in parallel", and the later R2 provenance and forget integration is named without gating the early slices.
- **B2, Brightspace.** The private iCal feed polled by Cloudflare is now the recommended first route. School-approved OAuth is the grades and submissions upgrade. Browser automation is explicitly not authorized until the D2L EULA and board terms are cleared, and the roadmap's "polite scraping" line is replaced. The feed URL is treated as a bearer secret that goes into Worker secrets, never chat. MFA via Telegram and "check D2L now" are restored.
- **S1, Classroom preflights.** Admin restrictions, under-18 controls, 7-day Testing refresh tokens and possible verification are each named, with an owner-reported fallback.
- **S2.** Classroom and Brightspace are view-only. Missing work is derived and labelled. Coach correction and forgetting use plain speech. The date-only claim is corrected: `due_at` is instant-only, so date-only needs a later separately numbered migration, and this PR claims none.

**Nits (no re-review needed):**
- The R2 integration paragraph says "`/why` and `/forget` behavior". Sid has since said he wants no commands to learn (plain speech: "why do you think that", "forget that"). Word it as plain-speech controls when this text is next touched.
- PR #43 (Classroom wiring) was opened before this reorder. It can merge as reviewed, but the next school PR must be slice 1, the catch-up conversation.

**Next.** Sid may merge #41. The school chat's next PR is slice 1 (catch-up conversation and per-course plan on the live bot), then slice 2 (minimal university tracker).

Sid retains merge authority. This PR changes no runtime, account, secret, migration or deployment.
