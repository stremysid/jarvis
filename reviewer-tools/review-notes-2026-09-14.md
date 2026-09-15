# Reviewer notes, PRs #29–#32 (2026-09-14)

Facts gathered so far, for the final AGENT_LOG entries. All checks ran locally on Sid's Windows 11 PC in `C:\Users\Sid\jarvis-deploy`.

## #29 `codex/r1-owner-phone-enrollment-options`
- Cleared at 502e23c. Docs only: 4 files vs main 4833b74. Posted to AGENT_LOG as 86e1832.
- Conflicts with #31 in `docs/AGENT_LOG.md` only.
- Merged by Sid as f2424f5. The tree is identical to the reviewed 86e1832.

## #30 `codex/r1-device-key-replacement-runbook`
- Changes requested at f2f25b6 (AGENT_LOG 185e41b); follow-up at 1556530.
- Focused test 12/12.
- Blocker: `--remote --file` goes through the D1 import API, so result rows (`replacement_ready` / `replacement_complete`) are never printed. Verified in wrangler 4.127.1 source, `executeRemotely`.
- Should-fix: bare `pnpm` (resolves to `pnpm.ps1`) with no `--config`/`--env ''`; session-only `JARVIS_DEVICE_ID`/`JARVIS_DEVICE_KEY_PATH`.
- Nit: rendered SQL files in `%TEMP%`.
- Step 2 dry run on this PC passed: `uv run --project apps/local-agent jarvis enroll` exit 0, parser finds all 6 fields, fingerprint matches, DPAPI prefix present, second run reuses the key.
- Throwaway key left under `scratchpad/dryrun-keys` (never enrolled).
- The temp worktree `C:/Users/Sid/jarvis-pr30` (with `.venv`) is kept for re-review.
- Codex fix 5318bbf re-reviewed: all 4 items fixed. Focused test passes 16/16. Cleared; posted to AGENT_LOG as 20611fd.
- After #29 merged, the branch conflicted with main in AGENT_LOG only. Resolved as b8e32a3 with `scratchpad/agentlog-union.mjs`:
  - Entry counts: ours 77, theirs 79, merged 84, duplicates 72.
  - The only deleted line vs main is a blank line that became a `---` separator.
  - The merged tree vs main shows only #30's own files. It merges clean with main.
- Sid told: ready to merge.
- Note: #31 (84e1f69) and #32 (f47e2ca) also conflict with main in AGENT_LOG only. Codex resolves these when it pushes fixes; check at re-review.

## #31 `codex/r1-owner-phone-enrollment` (head fc84bdb)
- Workspace: 2559/2560. The one failure is the archival "seeks a many-segment tail read" 5 s timeout, a known flake that also fails on main.
- Gateway `tsc --noEmit`: clean.
- Local agent (3 files changed): pytest 808 passed / 32 skipped; ruff clean; mypy strict clean (56 files).
- Merges clean with main. Conflicts only in `docs/AGENT_LOG.md` with #29 and #32.
- The security review agent finished (`scratchpad/review-pr31.md`): 2 blockers, 8 should-fix, 10 nits.
- B1 is PROVEN by the reviewer's executed probe (`scratchpad/owner-phone-enrollment-b1-probe.test.ts`, copied into the checkout, run, then removed):
  - The "expected behaviour" test fails with `owner_phone_enrollment_state_changed`.
  - The failure-mode test passes: exactly one live `challenge:2`, expiring 14:11, is committed.
  - Root cause: `meta.changes === 1` counts the 0002 reclaim trigger's delete.
- B2 is confirmed from facts:
  - The route returns 503 unless `IDENTITY_CHALLENGE_HMAC_KEY_VERSION` is valid (route `configured()`).
  - That key is not in production's secret list (handoff §3).
  - The runbook's order puts PR #30's preflight before the gateway deploy.
- Changes requested, posted to AGENT_LOG as 9a1daca on `codex/r1-owner-phone-enrollment`.
- MUT results: all 9 predicted survivors SURVIVED (MUT-1..8, MUT-10), with 23 tests across the 2 enrollment test files. Each needs a killing test.
- KILL-1..4 and Python MUT-9, MUT-11, KILL-5 are running (b3ivk7ewr).
- #30 fix 5318bbf: reviewed by reading; all 4 items addressed. Clearance draft is `agentlog-entry-30c.md` ({{TESTS}} pending the focused run).
- Adversarial agent finished (`scratchpad/pr31-adversarial-report.md`): 65 attack scenarios, 121 test cases.
  - No auth bypass, no identity injection, no phone or code leak.
  - 8 findings: B1 reproduced plus a first-begin variant, the S1/S2/S4/S7 items, a number-guess oracle, a CLI traceback, pre-auth config disclosure, and 500 on a non-canonical body.
  - Posted to AGENT_LOG as 2e959bf, together with the R1 caller-ID finding.
- Tests pushed to `claude/pr31-adversarial-tests` (ea1bc1c, 8 files). On the merged head they pass: gateway 90/90, CLI 31/31. The pointer was posted to the #31 AGENT_LOG.
- The adversarial worktree was removed after the push.
- #31 head 4be8c7d was only Codex merging main in (parents 84e1f69 and 8150e36). No fixes yet.
- **#31 fix push, re-review started:** head 327ddda. Commits:
  - cd038e0 "fix(r1): harden owner phone enrollment review gaps"
  - 90ae444 merge of the reviewer's entries 2e959bf and 07dc0b1
  - 327ddda Codex's AGENT_LOG entry
- It merges clean with main 8150e36. The #31-only diff vs main is 18 files, +2547/−43 (routes, service, device-repository, identity-challenge, index.ts, CLI, cloud_client, tests, runbooks).
- Codex claims: B1, B2, S1–S8 and the adversarial findings fixed; 11 killing tests plus a retry-after-expiry regression added; 22 mutations verified; 2,575 workspace tests; 818 local-agent tests passing and 32 skipped.
- Running:
  - bqqph73x3: full workspace, tsc, pytest, ruff, mypy on 327ddda.
  - a110889780791624b: fix-verification agent, writing `scratchpad/review-pr31-fixes.md` with updated mutation strings.
- Next, once jarvis-deploy is free:
  - B1 probe: the EXPECTED test should pass and the FAILURE MODE test should fail.
  - Adversarial branch tests: the FINDING tests should now fail.
  - Updated mutations.
- bqqph73x3 results on 327ddda, local checks:
  - Full workspace: 2572/2575. The 3 failures are the known timeout flakes seen before under machine load (two agents were running), and none is in a file #31 touches:
    - archival "seeks a many-segment tail read" (5 s);
    - `voice-guest-access` "keeps successful and rejected guest PIN candidates out of logs" (15 s);
    - a cascade in "activates a pending guest".
  - These same two files passed 55/55 in isolation on #28's head. Rerun them in isolation on 327ddda once the tree is free.
  - Gateway tsc: clean.
  - Local agent: pytest 818 passed and 32 skipped; ruff clean; mypy clean (56 files).
- bojr2lhgv: the B1 probe and adversarial branch tests against 327ddda. Both are STALE against the new contract:
  - the service now needs `ownerPrincipalId`;
  - the begin body now needs a `requestSalt` (32-byte base64url).
  - So they fail with `owner_phone_enrollment_configuration_invalid`, and the result is not evidence either way. Gateway adversarial: nearly all fail on construction. CLI adversarial: 9 fail, 22 pass.
  - My cleanup left untracked adversarial files in jarvis-deploy; since cleaned.
- Isolated rerun of the flaky files on 327ddda (bu0j7daum): archival plus `voice-guest-access` pass 55/55, so the 3 full-run failures were load timeouts, not regressions.
- **B1 is PROVEN FIXED by the reviewer's adapted probe on 327ddda** (probe now passes `ownerPrincipalId` and `requestSalt`):
  - "EXPECTED BEHAVIOUR" PASSES: a same-phone retry after expiry returns a fresh pending `challenge:2`, expiring 14:11, with exactly one live challenge.
  - "OLD B1 FAILURE MODE" FAILS with `expected 'none' to be 'owner_phone_enrollment_state_changed'`, meaning the retry no longer throws.
- The R2 memory Codex chat started. Per Sid's screenshot it paused correctly at the storage gate:
  - local draft `08a5826`, nothing pushed, no PR opened, no migration 0016;
  - its validation passed: 2,528 workspace, 789 local-agent (fewer than #31's 818, because main lacks #31's CLI tests) and 119 watchdog tests, with only Hermes' 3 known R3 baseline failures;
  - a 15-minute heartbeat watches `claude/r2-memory-research` for the storage decision.
- Next steps:
  - probe updated with `ownerPrincipalId` and `requestSalt` and rerun (B1 fixed; see above);
  - adversarial harness adaptation delegated (a29443b421336d177, worktree `C:/Users/Sid/jarvis-pr31-adv2`, report `pr31-adversarial-rerun.md`);
  - fix verification running (a110889780791624b, `review-pr31-fixes.md`, with updated mutation strings).
- Entry draft: `scratchpad/agentlog-entry-31.md`.
- **Adversarial rerun on 327ddda done** (a29443b421336d177, `pr31-adversarial-rerun.md`, worktree `C:/Users/Sid/jarvis-pr31-adv2`, harness v2 in `pr31-adversarial-v2/`):
  - Gateway: original 90 = 62 pass / 28 fail; 30 new inverted+classify all pass. CLI: 31 = 29 / 2; 2 new inverted pass.
  - Every fixed FINDING fails on its own claim, and its inverted test passes: 1d' (S1 owner-principal pin), 3c ×4 (S2 id check = inbound SAFE_ID), 4b (receipt check), 5a/5a' (B1 via RETURNING challenge_id), INFO 8c (auth before config 503), Finding 5 (non-canonical body 400), CLI traceback (OSError mapped), CLI S4 (config message).
  - Still present, non-blocking: 5d number-guess oracle (needs device key; in KNOWN_ISSUES at 327ddda); 9c spoofed activation calls exhaust the 5-min attempt window (tied to caller-ID gap; passphrase work); D1 meta.changes over-count (product no longer reads it).
  - Deliberate contract changes, not regressions: 3a ×13 nonce row now written on a misconfigured signed begin (no enrollment row; replay after config fix → 401); 3b 503 not 500; 8a expired envelope → `signed_request_expired`.
  - Reviewer spot-check of 8a: `signed-request.ts` unchanged by #31 (empty diff vs 8150e36); the freshness check throws before `readCurrentKey`, so an expired body reveals nothing about devices/keys/principals.
  - Reviewer confirmed the raw run files: run2-gateway "28 failed | 92 passed (120)", run2-cli "2 failed, 31 passed"; the worktree files are byte-identical to `pr31-adversarial-v2/`.
  - Reviewer read the route at 327ddda: when unconfigured, it runs `DeviceRequestVerifier.verify` with an identity validator, then returns 503. Failures map to 401 `device_key_mismatch`, except `signed_request_expired`. So the 3a nonce row is benign, and config state is hidden from unauthenticated callers.
  - The CLI signs each request with a fresh 32-byte nonce (`crypto/signed_request.py:112`, `secrets.token_bytes`), so a rerun after the config fix isn't blocked by the 3a nonce row. KNOWN_ISSUES at 327ddda records both leftovers: caller-ID spoofing including budget burn (lines 3-10), and the number oracle (about lines 20-27).
  - Verdict entry draft: `scratchpad/agentlog-entry-31b.md` (placeholders: VERDICT, FIX_SUMMARY, MUTATIONS, REMAINING).
  - Pushed harness v2 plus the rerun report to `claude/pr31-adversarial-tests` as 80f4c45 (fast-forward over ea1bc1c via `-s ours`; tree = 327ddda + 9 files).
- **Fix-verification agent done** (a110889780791624b, `review-pr31-fixes.md`, read-only, no test runs).
  - No new blockers. Of 14 items: 9 fixed; 4 partial (B2 values, S2 docs, S8 overclaims, CLI dropped connection); the number oracle deferred to KNOWN_ISSUES.
  - New should-fix NS1 (step 2 gives no value sources; a wrong OWNER_PRINCIPAL_ID → key-mismatch message → runbook dead-end; voice-smoke.md says reuse existing records) and NS2 (salt freshness and the stdin TTY half not pinned).
  - Nits NN1–NN4. Mutations in `pr31-fix-mutations.json` (33 entries).
  - Reviewer verified the NS1 text at 327ddda: runbook step 2 "Set and verify…" with no source; mismatch guidance "stops the rollout… do not work around it by… editing identifiers"; voice-smoke "Owner voice configuration" "to the existing verified owner records, not newly invented identifiers"; the runbook "Tests and evidence boundary" claims "both TTY directions" and "fresh 32-byte request salts".
  - Reviewer mutation run started: b62q2t4da, spec `mut31b.json` (BASE-TS, BASE-PY, then 33), output `mut31b-run.txt`, root jarvis-deploy on origin/codex/r1-owner-phone-enrollment.
  - Verdict plan: changes requested (docs + tests only). Draft `agentlog-entry-31b.md` (placeholders UTC, MUTATIONS, NS2_SALT, NS2_TTY).
- **Reviewer mutation run b62q2t4da on 327ddda** (`mut31b-run.txt`):
  - Baselines: BASE-TS 46/46, BASE-PY 29/29.
  - 30/33 KILLED: MUT-1..11, KILL-1..5, FIX-B1, FIX-S1a, FIX-S2, FIX-S3, FIX-S4a-d, FIX-S5a, FIX-N1, FIX-I2, FIX-N8.
  - SURVIVED: FIX-S1b (equivalent), FIX-S5b (constant salt), FIX-TTY (stdout-only check).
  - Sampled killer names match (MUT-1, MUT-7, KILL-5, FIX-B1, FIX-S5a, FIX-N8).
  - jarvis-deploy is back on main 8150e36, clean.
  - Verdict: changes requested (docs + tests only). Entry in `agentlog-entry-31b.md`.
  - **Posted** to `codex/r1-owner-phone-enrollment` as 4820b78 (06:36 UTC), fast-forward from 327ddda. Status board republished: #31 "Small fixes", #33 "Reviewing".
- **PR #33** `codex/r1-owner-call-passphrase-design` at f6eb083 (draft, intentionally red: 13/14 contract cases fail): design review and test-strength agents running (`review-pr33-design.md`, `review-pr33-tests.md`; test worktree `C:/Users/Sid/jarvis-pr33-tests`).
- **Obsidian research landed** (`obsidian-memory-research.md`, recommends C: vault + D1 ledger, git/GitHub transport, GitSync trial). Fact-check agent running (`obsidian-research-factcheck.md`, includes a C vs C-lite comparison).
- Codex R1 chat started the passphrase design: branch `codex/r1-owner-call-passphrase-design` at 87c6419 ("reserve owner passphrase design work"); no PR yet.

## #32 `codex/r1-retire-legacy-pin` (head 2828236)
- Workspace: 2510/2511, with the same archival flake.
- Gateway `tsc --noEmit`: clean.
- No local-agent changes.
- Merges clean with main and with #30.
- The correctness review agent finished (`scratchpad/review-pr32.md`). No blockers.
- S1, verified by me: spec §5.2 steps 6-7 promise voicemail non-disclosure and a purpose statement.
  - On the branch, `call-session-do.ts` speaks the voicemail line, calls `mintOwner`, then goes `active` immediately.
  - No answering-machine detection exists in gateway src; grep hits for `answered_by` are unrelated decision-repo fields.
  - Risk: a voicemail greeting could get an owner, memory-backed reply.
  - Real R1 product gap. Sid's decision (AMD costs money, or require a key press or spoken confirmation).
- S2, verified: main gateway src has no `PIN_VERIFIER_JSON` outside migration 0001 (removed in `8de35e7`, 2026-09-04). #32's deploy.md adds an unfounded "must remain until #32 deployed" wait.
- Brief correction, verified: 0006 rebuilds `principals` without pin columns or the human CHECK, and drops the one-human index.
- Mutations (via `scratchpad/mut32.json`):
  - M1 (exists failure proceeds): killed.
  - M2 (try/catch removed): killed.
  - M3 (guest budget bypassed): killed by 3 guest tests.
  - M4: not run; its search text matched twice in call-session-do.ts.
- Posted "changes requested (docs only)" to AGENT_LOG as f47e2ca on `codex/r1-retire-legacy-pin`.
- The status page row says "Needs fixes".
- Sid was given a queued Codex message: fix #32 after #30.
- Codex fix 4e78fc9 addresses S1, S2 and the nits:
  - spec §5.2 corrected, plus a KNOWN_ISSUES voicemail entry
  - "deletable now" wording with the cautions restored
  - comment fix, plan banners, and a guest construction test
- Local checks at 4e78fc9: focused `call-session-do` + `voice-smoke` pass 142/142; gateway tsc clean.
- Codex then merged main into the branch as 0c79bf2 (parents 4e78fc9 and f2424f5).
  - The only non-log additions are #29's docs; the code is identical to 4e78fc9.
  - It merges clean with main, so no reviewer union-merge is needed.
- Re-review mutations (`mut32b.json`: M4 with unique context, plus M1 and M3 re-runs) are running as bsfivurwp.
- Re-review mutations on 0c79bf2: M4 KILLED by the new guest construction test (the first-review gap is closed); M1 and M3 KILLED.
- Cleared. Posted to AGENT_LOG as 7b64772.
- Sid merged #30 as ca51a9b; main's non-log tree is identical to b8e32a3. That merge made #32 conflict in AGENT_LOG.
- Resolved with a union merge as a010c41:
  - entry counts: ours 83, theirs 84, merged 88, duplicates 79; AGENT_LOG vs main +129/−0.
  - the merged tree vs main shows only #32's files; it merges clean.
- Sid told #32 is ready to merge.
- Full workspace on the final merge candidate a010c41 (#32 + main with #30): 2527/2528. The only failure is the known archival 5 s timeout ("seeks a many-segment tail read"), which also fails on main. The isolated rerun of that file on a010c41 passed 46/46, so #32 is fully verified for merge.

## #35 and #36 (R2 memory), reviewed 21:53 UTC
- #35 at 10347b2: pnpm test 2,556; typecheck and lint pass; pytest 806/32 skipped; ruff and mypy clean. Probe `pr35-probe.test.ts` 6/6 pass (defects proven). Mutations `mut35.json`: 16/32 killed; `mut35b.json`: MP6/PY5 survive full suites. Changes requested (B1 substring first-person quote).
- #36 at 81b84ab: docs only. Changes requested (B1 no event-level forget suppression in 0016; B2 stale base conflicts with main; S1–S7, S7 = Sid's DeepSeek→Claude/GPT plan).
- Memory Plan page republished (v6) from `jarvis-memory-plan.html`.

- #35 re-review 22:53 UTC at be0e3fb: cleared with follow-ups F1-F4. pnpm 2625/2626 (archival flake; 46/46 isolated), pytest 850/32, ruff+mypy clean. Old probe 6/6 now fail (fixed). probe2 3/3 pass (F1 penalty scale, F3 two-sentence, F4 hedges). mut35c 32/37 killed; survivors ME6, NC7-9, NC19.

- #36 union-merged with main as 1be6191 (0 entries lost). #37 max review 23:09 UTC at b438666: changes requested (S1 0016 coupling, S2 STT-variant words, S3 no disable/revoke transition, 11 mutation survivors). pnpm 2607/2610 (3 flakes 73/73 isolated), pytest 829/32. KAT recomputed with Node crypto: match.

- #38 review 23:45 UTC at f9b528f (code = 3f884b5): cleared with nits N1 (would vs I would like / contraction), N2 (decimal + interior ! vectors). pnpm 2635/2638 (3 flakes 126/126 isolated), pytest 860/32, ruff+mypy clean. Probes v1+v2 9/9 fail (all fixed). mut38 14/17 killed.

- #37 re-review 00:01 UTC at 66d99fa: changes requested (small). S1 disable guard pins producerVersion cloud-gateway@0.1.0 (hard-coded webhook constant). pnpm 2687/2687, pytest 871/32. Word list v2 + new KAT verified. mut37b 17/23 killed; survivors D2 freshness, D8 unverified telegram identity, D4 scope, D6 event type, D9 inactive head, PY7.

- #37 second re-review at aad3a7f: CLEARED. S1 producerVersion clause removed + version-bump test. pnpm 2693/2694 (archival flake 46/46 isolated), pytest 872/32. mut37c 23/23 killed.

- #39 (0016 schema) max review at 4f2c1c0: CHANGES REQUESTED. B1 tautological trigger contract; valid trigger-removal run 26 killed / 42 survived (first run discarded: placeholder broke migration apply, all skipped). Adversarial agent (Opus) report pr39-adversarial.md: H1-H5 verified by reading SQL; H2 runtime-confirmed by pr39-h2-probe.test.ts (INSERT OR REPLACE rewinds cursor). Money/authority B7: any old owner message authorizes reprocess job up to $1000. Merged-tree pnpm 2774/2777 (flakes 55/55 isolated). Lesson: count kills only when a test fails, never all-skipped.

- #39 re-review at eb70b70: CHANGES REQUESTED (round 2). pnpm 2870/2872 (flakes 55/55 isolated), pytest 878/32. H2 probe now fails (memory_cursor_duplicate) = fixed. Valid trigger removal 75/75 killed (B1 fixed; run split in 4 batches after a tool timeout killed a single long run at 8/75). Re-verify agent pr39-reverify.md: 12 fixed / 6 partial; new R1 UPDATE OR REPLACE on projection update guards (key not pinned), R2 rowid-alias REPLACE, R3 rules overwrite owner confirm/supersede, R4 day-range + cancelled-job cost path broken, R5 partial episode sources. Lesson: keep background mutation calls to ~20-25 runs.
