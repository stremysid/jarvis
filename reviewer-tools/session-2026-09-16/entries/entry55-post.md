## 2026-09-15 22:31 UTC — Claude Opus 5, PR #55 xhigh review at 9d3facd: changes requested (small)

This is a docs-only review of `docs/plan/2026-09-15-r7-assistant-manager-plan.md` plus the `NEXT_STEPS.md` pointer, based on main `1cae97b`. No code, migration or configuration is changed.

**What holds.**
- **Exit test:** the plan restates the roadmap's R7 exit exactly.
- **Baseline:** the table separates merged, open and not-started work, and doesn't claim `/why` or `/forget` as a product feature before the R2 Telegram controls slice lands.
- **Slice split:** slices that can start early (P1 minimisation, P2 routing seam with fakes, P3 attention pings, P4 workload and cost lines) are kept apart from slices that must wait, and each names its upstream dependency.
- **Safety:** migrations are never reserved by number. Owner gates D1–D5 are explicit stops. The catalogue items offered but not chosen (receipt photos, end-of-day report) correctly get no slice. The boundaries section carries the phone-first, no-Linux, D1-authoritative, `SELECT RAISE ... WHERE` and no-PC-content rules.

**S1. W5, W6 and the R7 exit depend on R3 through R6, and the plan doesn't say so.**
- **The dependency:** W5 (prep briefs) and W6 (calendar writes) both depend on R6 item 4, the combined read agenda, and W7 composes them.
- **The chain:** the roadmap's R6 section says "Depends on R3". R3 needs Sid's execution-host decision and R2. So as written, the v1.6 exit ("A brief arrives before a class") waits on R3 and R6, even though the roadmap lists R7's dependencies as only R2 and R5. The plan's own risk section notes that a class brief needs a timetable R5 doesn't supply.
- **Fix:** state this transitive dependency in section 3 and section 7. Then propose one of:
  - (a) split R6 item 4 (read-only personal and school calendar agenda, cloud-side, no device needed) into its own slice that doesn't wait on R3, as a roadmap change for Sid to confirm; or
  - (b) source class occurrences from R5 feeds (Classroom and Brightspace calendars) for W5's first version.

  Don't pick one silently.

**S2. Review depth.** The plan gives every slice a Claude Opus 5 xhigh review.
- **What the docs say:** `docs/BUILDING.md` lists R7 at xhigh. It also says a PR that applies a migration to live data is reviewed at max.
- **Current practice:** this cycle, every migration-carrying PR (#52, #53) has had max review before its migration can be applied, because a migration that has already run can't be reverted.
- **Fix:** mark W3 and W6, which carry migrations, as max. Recommend max for W4 (OAuth scopes and untrusted mail and document text) and P2b (paid-route activation). Keep xhigh for the rest.

**N1.** W6 names "R5 step 7, Calendar bridge" as its upstream, but R5 step 7 itself says R7 supplies the reversible calendar writes. Say instead that W6 *is* the write half of R5 step 7, so the dependency isn't circular.
**N2.** D2 should use current evidence, not only the roadmap's September 3 names. As of 2026-09-15, independent coding and security benchmarks put GPT-5.6 Terra below Sol, and Artificial Analysis reports Terra is never the best value at any effort level. Phrase D2 as "compare current candidates on sanitized samples", without naming Terra or Opus 5 as defaults.
**N3.** P4's "Sunday retro" line should say it extends the existing `retro` digest kind (`digest-composer.ts` and `digest-job.ts` take `kind: "daily" | "retro"`), so the build doesn't add a second weekly job.

**Next.** The same R7 plan builder, in a fresh session, fixes S1–S2 and N1–N3 in the plan doc only and asks for a quick re-review. This PR authorizes no build, OAuth consent, spend, migration or deploy.
