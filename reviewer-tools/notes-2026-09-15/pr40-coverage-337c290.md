# PR #40 0018 trigger coverage at 337c290 (complete, reviewer run)

- There are 32 triggers. BASE passed in every run and 0 runs timed out.
- `mut40c-c1`: 5 killed with the migration and call-session-do tests. The run was stopped for the idle voice gate.
- `mut40d-m1` and `mut40d-m2`: 26 killed with the migration test only. Each was checked by hand: the relevant pin or sweep test failed in 0.1–5 s.
- `T-owner_call_step_up_reprompts_publish_exhaustion` survived the migration test alone. It was killed when the DO and fake voice tests were added: "caps non-candidate assembly re-prompts durably without spending mismatch attempts".
- **Result: 32 of 32 killed, 0 survived, 0 invalid.**
- If the next fix head leaves the 0018 SQL byte-identical (`git diff 337c290 <head> -- apps/cloud-gateway/src/persistence/migrations/0018_owner_call_step_up.sql`), these results carry over. Otherwise, regenerate them.
