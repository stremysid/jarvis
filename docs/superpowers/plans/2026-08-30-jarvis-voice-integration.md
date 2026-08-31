# Jarvis Voice Branch Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the completed Jarvis voice work from Tasks 6-9 into one credential-free verified integration branch without duplicating Task 7 or changing unrelated work.

**Architecture:** Start `codex/jarvis-voice-integration` at the reviewed Task 6 tip because that history already contains `feat/jarvis-v0.1.0` and the Task 7 outbound patch. Replay only the three Task 8 route commits and five Task 9 smoke-evidence commits, preserve their order, resolve conflicts against the newer Task 6 owner/guest session model, and verify the resulting tree without provider credentials or external effects.

**Tech Stack:** Git, TypeScript, pnpm 11.19.0, Node.js 24.19.x, Vitest, Cloudflare Workers local test runtime.

**Spec:** `docs/superpowers/specs/2026-08-29-jarvis-foundation-design.md`

## Global Constraints

- Do not deploy, push, merge to `main`, spend money, or run live provider tests.
- Preserve unrelated user work and stop before overwriting any uncommitted file.
- Integrate reviewed branch work only once; patch-equivalent commits are evidence of coverage, not candidates for replay.
- Keep all automated verification credential-free and local.
- Retain the live voice release gate as a documented prerequisite; local contract tests cannot satisfy it.

## Branch audit and exact commit set

| Source | Audit result | Integration action |
|---|---|---|
| `feat/jarvis-v0.1.0` at `db4c41f` | Ancestor of Task 6 | No replay |
| `codex/task-6-relay-session-core` at `143af7e` | Contains `feat/jarvis-v0.1.0`, Task 7 equivalent, relay sessions, and owner/guest hardening | Integration branch base |
| `codex/task-7-outbound-authorization` at `b2338a3` | `git range-diff` reports equality with already-present `f989649`; trees are identical | No replay |
| `codex/task-8-route-integration` at `476bd0e` | `f989649` is already an ancestor of Task 6; route commits are absent | Replay `06d3298`, `91a7a9b`, `476bd0e` |
| `codex/task-9-release-smoke` at `30b8568` | Five credential-gated harness/evidence commits are absent | Replay `911d96a`, `c000980`, `60ee428`, `3c939bd`, `30b8568` |

## File structure

| File group | Responsibility in this integration |
|---|---|
| `apps/cloud-gateway/src/http/voice-*.ts` | Fail-closed routes, callback verification, callback persistence, and dependency construction. |
| `apps/cloud-gateway/src/index.ts` | Worker entrypoint wiring that must preserve the Task 6 `CallSession` Durable Object export. |
| `apps/cloud-gateway/src/voice/outbound-recipient-lookup.ts` | Resolves only an authorized verified outbound recipient. |
| `apps/cloud-gateway/test/http/*.test.ts` | Route, callback, and Worker wiring verification. |
| `tests/acceptance/fake/voice-call-*.ts` | Credential-free end-to-end voice path. |
| `tests/acceptance/live/voice-smoke*` | Credentialed harness plus credential-free validation of its evidence contract. |
| `docs/runbooks/voice-smoke.md`, `README.md`, `TESTING.md` | Live gate and safe local command documentation. |
| `package.json` | Credential-free smoke-contract command and credentialed live-gate commands. |

---

### Task 1: Integrate the missing reviewed route boundary

**Files:**
- Create: `apps/cloud-gateway/src/http/voice-routes.ts`
- Create: `apps/cloud-gateway/src/http/voice-callback-recorder.ts`
- Create: `apps/cloud-gateway/src/http/voice-callbacks.ts`
- Create: `apps/cloud-gateway/src/http/voice-route-construction.ts`
- Create: `apps/cloud-gateway/src/voice/outbound-recipient-lookup.ts`
- Modify: `apps/cloud-gateway/src/index.ts`
- Test: `apps/cloud-gateway/test/http/voice-routes.test.ts`
- Test: `apps/cloud-gateway/test/http/voice-callback-recorder.test.ts`
- Test: `apps/cloud-gateway/test/http/voice-callbacks.test.ts`
- Test: `apps/cloud-gateway/test/http/voice-route-construction.test.ts`
- Test: `apps/cloud-gateway/test/http/worker-voice-routes.test.ts`
- Test: `apps/cloud-gateway/test/voice/outbound-recipient-lookup.test.ts`
- Test: `tests/acceptance/fake/voice-call-path.test.ts`

**Interfaces:**
- Consumes: Task 6 `CallSession`, `CallRepository`, inbound handler, outbound handler, owner/guest access decisions, and the already-present Task 7 outbound adapter.
- Produces: fail-closed Worker route construction, verified callback handlers, callback recording, verified-recipient lookup, and a fake end-to-end call path.

- [ ] **Step 1: Confirm the branch and clean base**

Run: `git status --short --branch && git rev-parse HEAD`

Expected: branch `codex/jarvis-voice-integration`, no uncommitted changes, and HEAD descends directly from Task 6 tip `143af7e67994783f86f8a49f9a5e76cd281688e7` through only the committed integration plan.

- [ ] **Step 2: Replay the fail-closed route boundary**

Run: `git cherry-pick 06d3298d492bb18cea9397ab7c8900b00452f4fa`

Expected: the route handler and its tests are added without duplicating outbound authorization.

- [ ] **Step 3: Replay callback, construction, recipient, and fake-path integration**

Run: `git cherry-pick 91a7a9b55473fd9ffe30a742f33ddb4664107e7c`

Expected: callback modules, recipient lookup, and fake acceptance fixtures are added.

- [ ] **Step 4: Replay the independent route review fixes**

Run: `git cherry-pick 476bd0e11f1f355fce5c5e0777f6a5f4903f6e5e`

Expected: route findings are fixed while `apps/cloud-gateway/src/index.ts` continues to export the Task 6 `CallSession` Durable Object.

- [ ] **Step 5: Run the focused route and fake-acceptance tests**

Run: `pnpm vitest run apps/cloud-gateway/test/http/voice-routes.test.ts apps/cloud-gateway/test/http/voice-callback-recorder.test.ts apps/cloud-gateway/test/http/voice-callbacks.test.ts apps/cloud-gateway/test/http/voice-route-construction.test.ts apps/cloud-gateway/test/http/worker-voice-routes.test.ts apps/cloud-gateway/test/voice/outbound-recipient-lookup.test.ts tests/acceptance/fake/voice-call-path.test.ts`

Expected: all route, callback, recipient, Worker wiring, and fake acceptance assertions pass without credentials.

### Task 2: Integrate the missing reviewed release-smoke contract

**Files:**
- Modify: `README.md`
- Modify: `TESTING.md`
- Modify: `package.json`
- Modify: `tests/acceptance/tsconfig.json`
- Create: `docs/runbooks/voice-smoke.md`
- Create: `tests/acceptance/live/evidence/.gitignore`
- Create: `tests/acceptance/live/voice-smoke-cli.mjs`
- Create: `tests/acceptance/live/voice-smoke.ts`
- Test: `tests/acceptance/live/voice-smoke.test.ts`

**Interfaces:**
- Consumes: Task 5 conversation events, Task 6 owner/guest access roles, route callbacks, immutable commit identity, and live evidence supplied by a future deployed environment.
- Produces: `pnpm test:voice-smoke` for credential-free evidence-contract tests and explicit credentialed `smoke:voice` / `release:voice-gate` commands that are not executed here.

- [ ] **Step 1: Replay the smoke harness**

Run: `git cherry-pick 911d96a2b81a6da562b90067a280dbfc21374264`

Expected: the harness, runbook, package scripts, evidence ignore rule, and contract tests are added.

- [ ] **Step 2: Replay the Task 5 evidence alignment**

Run: `git cherry-pick c0009809aef4bfc8e1f5b5b216bb0bad54df2a03`

Expected: evidence validation matches durable conversation events.

- [ ] **Step 3: Replay immutable commit binding**

Run: `git cherry-pick 60ee4285cc2fe33cd748cc22f3f6eba5a55ac8a1`

Expected: all evidence in one release run is bound to one commit.

- [ ] **Step 4: Replay access-role and identity privacy fixes**

Run: `git cherry-pick 3c939bd2a8dd0f98674daa8f2e1d917eeaf46662 && git cherry-pick 30b85684d983626319a9767509b74b67b970f62e`

Expected: evidence aligns with owner/guest roles and does not expose owner identity.

- [ ] **Step 5: Run the credential-free smoke contract tests**

Run: `pnpm test:voice-smoke`

Expected: all harness validation tests pass without invoking Twilio, Cloudflare, DeepSeek, or a deployed Worker.

### Task 3: Review the consolidated integration diff

**Files:**
- Review: every path changed by the eight replayed commits.
- Modify only if required: overlapping route wiring or tests whose assumptions conflict with the newer Task 6 session/access model.

**Interfaces:**
- Consumes: Task 6 authority/session invariants plus Task 8 and Task 9 reviewed patches.
- Produces: one coherent tree with no duplicate outbound implementation and no loss of the `CallSession` export.

- [ ] **Step 1: Confirm the skipped Task 7 equivalence remains true**

Run: `git range-diff 0c81fee..b2338a3 0c81fee..f989649 && git diff --exit-code b2338a3 f989649`

Expected: one equal patch and no tree diff.

- [ ] **Step 2: Inspect branch ancestry and exact replay list**

Run: `git log --graph --decorate --oneline codex/task-6-relay-session-core..HEAD`

Expected: the plan commit plus exactly three Task 8-derived commits and five Task 9-derived commits; no Task 7 replay.

- [ ] **Step 3: Inspect the full integration delta and whitespace health**

Run: `git diff --stat codex/task-6-relay-session-core...HEAD && git diff --check codex/task-6-relay-session-core...HEAD`

Expected: only plan, route integration, fake acceptance, and smoke-contract paths; no whitespace errors.

- [ ] **Step 4: Verify the Worker entrypoint preserves both integrations**

Run: `pnpm vitest run apps/cloud-gateway/test/http/worker-voice-routes.test.ts apps/cloud-gateway/test/voice/call-session-do.test.ts`

Expected: Worker route construction and the Task 6 Durable Object session suite both pass.

### Task 4: Run full credential-free release verification

**Files:**
- Verify: the entire repository tree and lockfile.

**Interfaces:**
- Consumes: the consolidated integration tree.
- Produces: fresh test, typecheck, lint, dependency-audit, security-test, and repository-hygiene evidence.

- [ ] **Step 1: Verify the pinned toolchain and install exactly the lockfile**

Run: `node --version && pnpm --version && pnpm install --frozen-lockfile`

Expected: Node.js satisfies `>=24.19.0 <25`, pnpm is `11.19.0`, and install completes without changing tracked files.

- [ ] **Step 2: Run the complete automated test suite**

Run: `pnpm test`

Expected: every configured contracts, cloud, acceptance, route, security, and smoke-contract test passes with zero failures.

- [ ] **Step 3: Run all workspace static checks**

Run: `pnpm typecheck && pnpm lint`

Expected: all workspace projects typecheck and lint with zero errors.

- [ ] **Step 4: Run the focused security and dependency gates**

Run: `pnpm vitest run apps/cloud-gateway/test/security tests/acceptance/live/voice-smoke.test.ts && pnpm audit --audit-level high`

Expected: all security and evidence-privacy assertions pass and no high-or-critical dependency vulnerability is reported.

- [ ] **Step 5: Verify repository hygiene and final state**

Run: `git diff --check && git status --short --branch && git log -12 --decorate --oneline`

Expected: no whitespace errors, no uncommitted files, the integration branch is named, and the expected commits are visible.

### Task 5: Report branch and deferred live gates

**Files:**
- Read: `docs/runbooks/voice-smoke.md`
- Read: `package.json`

**Interfaces:**
- Consumes: fresh verification output and the final Git history.
- Produces: exact branch name, commit list, test counts/commands, audit result, and a list of live prerequisites deliberately not executed.

- [ ] **Step 1: Record exact branch, HEAD, and integrated source commits**

Run: `git branch --show-current && git rev-parse HEAD && git log --reverse --format='%H %s' codex/task-6-relay-session-core..HEAD`

Expected: an auditable mapping from the integration branch to the plan and eight replayed source patches.

- [ ] **Step 2: List live gates without executing them**

Read the runbook and report the required deployed inbound, unauthorized-caller, outbound-answer, outbound-no-answer, failure-callback, transcript/recall, latency, and interruption evidence. Do not run `pnpm smoke:voice` or `pnpm release:voice-gate`.
