# PR #40 round-3 mutation evidence

Windows 11, after reviewer mailbox `3708ba4`. Each edit below was applied
alone, its named test selection was run through the Cloudflare Vitest
configuration with one worker, and the original file bytes were restored
in `finally`. All 14 mutations produced assertion failures, with no test or
hook timeouts. The six new alarm/close/late-fragment regressions also failed
against the original implementation before the fixes and passed afterward.

The reviewer scratch files named in the mailbox were not present in the
available local checkouts. The expiry-commit-then-throw regression recreates
P1 from the mailbox, with and without hibernation. The word-index logging
mutation recreates port 3d's described behavior; this report does not claim
to have run an unavailable diff file.

Every command uses this shape from the repository root in PowerShell 7:

```powershell
pnpm exec vitest --config vitest.workspace.ts run <test-file> --maxWorkers=1 -t '<test-name selection>'
```

Migration `0018` was not changed or applied to production. The reviewer's
32/32 trigger-deletion result is carried evidence, not a new trigger sweep.

## 1. N5-resume-verdict

File: `apps/cloud-gateway/src/voice/call-session-do.ts`. Test: `tests/acceptance/fake/voice-owner-call-step-up.test.ts`, selection `finishes a committed`.
Result: Tests  2 failed | 24 skipped (26); exit 1, assertion failure.

Replace:
```typescript
      await this.#rejectOwnerStepUp(observedAt, true);
      return;
    }
    if (state.deadlineAt === null)
```

With:
```typescript
      await this.#ownerStepUpAlarm?.clear();
      return;
    }
    if (state.deadlineAt === null)
```

## 2. N5-rejected-core-phase

File: `apps/cloud-gateway/src/voice/call-session-do.ts`. Test: `tests/acceptance/fake/voice-owner-call-step-up.test.ts`, selection `finishes a committed`.
Result: Tests  1 failed | 1 passed | 24 skipped (26); exit 1, assertion failure.

Replace:
```typescript
this.#session.phase !== "pre_auth" && this.#session.phase !== "rejected"
```

With:
```typescript
this.#session.phase !== "pre_auth"
```

## 3. N5-rejected-rehydration

File: `apps/cloud-gateway/src/voice/call-session-do.ts`. Test: `tests/acceptance/fake/voice-owner-call-step-up.test.ts`, selection `finishes a committed`.
Result: Tests  1 failed | 1 passed | 24 skipped (26); exit 1, assertion failure.

Replace:
```typescript
this.#resolveCore(socket, true)
```

With:
```typescript
this.#resolveCore(socket)
```

## 4. N5-mismatch-close

File: `apps/cloud-gateway/src/voice/call-session-do.ts`. Test: `tests/acceptance/fake/voice-owner-call-step-up.test.ts`, selection `live socket when an evicted`.
Result: Tests  1 failed | 25 skipped (26); exit 1, assertion failure.

Replace:
```typescript
        closeSocket(socket, 1008, "relay session mismatch");
        await this.#clearOwnerStepUpAlarm();
```

With:
```typescript
        await this.#clearOwnerStepUpAlarm();
```

## 5. S1-retry-budget

File: `apps/cloud-gateway/src/voice/call-session-do.ts`. Test: `tests/acceptance/fake/voice-owner-call-step-up.test.ts`, selection `exhaust the runtime`.
Result: Tests  1 failed | 25 skipped (26); exit 1, assertion failure.

Replace:
```typescript
if ((alarmInfo?.retryCount ?? 0) < 5) throw error;
```

With:
```typescript
if ((alarmInfo?.retryCount ?? 0) < 6) throw error;
```

## 6. S1-fallback-close

File: `apps/cloud-gateway/src/voice/call-session-do.ts`. Test: `tests/acceptance/fake/voice-owner-call-step-up.test.ts`, selection `exhaust the runtime`.
Result: Tests  1 failed | 25 skipped (26); exit 1, assertion failure.

Replace:
```typescript
      for (const socket of this.ctx.getWebSockets()) closeSocket(socket, 1011, "relay runtime unavailable");
```

With:
```typescript
// Removed.
```

## 7. N6-refusal-send

File: `apps/cloud-gateway/src/voice/call-session-do.ts`. Test: `apps/cloud-gateway/test/voice/call-session-do.test.ts`, selection `relay disconnects during`.
Result: Tests  2 failed | 120 skipped (122); exit 1, assertion failure.

Replace:
```typescript
    try { await this.#relay.sendNeutralText(OWNER_STEP_UP_REJECTED); }
    catch { /* A disconnected caller must not prevent the owner's alert. */ }
```

With:
```typescript
    await this.#relay.sendNeutralText(OWNER_STEP_UP_REJECTED);
```

## 8. N6-close-send

File: `apps/cloud-gateway/src/voice/call-session-do.ts`. Test: `apps/cloud-gateway/test/voice/call-session-do.test.ts`, selection `relay disconnects during`.
Result: Tests  1 failed | 1 passed | 120 skipped (122); exit 1, assertion failure.

Replace:
```typescript
      try { this.#relay.close(1008); }
      catch { /* The relay may already have closed during verification. */ }
```

With:
```typescript
      this.#relay.close(1008);
```

## 9. N7-close-alarm

File: `apps/cloud-gateway/src/voice/call-session-do.ts`. Test: `tests/acceptance/fake/voice-owner-call-step-up.test.ts`, selection `pre-auth hang-up`.
Result: Tests  2 failed | 24 skipped (26); exit 1, assertion failure.

Replace:
```typescript
    await this.#ownerStepUpAlarm?.clear();
    this.#socketClosed = true;
```

With:
```typescript
    this.#socketClosed = true;
```

## 10. N8-late-fragment

File: `apps/cloud-gateway/src/voice/call-session-do.ts`. Test: `tests/acceptance/fake/voice-owner-call-step-up.test.ts`, selection `late fragment so`.
Result: Tests  1 failed | 25 skipped (26); exit 1, assertion failure.

Replace:
```typescript
        if (this.#ownerStepUpDeadlineAt !== null) await this.#ownerStepUpAlarm?.arm({
          sessionId: this.#session.sessionId, lifecycleGeneration: 1, kind: "window", deadlineAt: this.#ownerStepUpDeadlineAt,
        });
        await this.#relay.sendNeutralText(OWNER_STEP_UP_FORMAT_PROMPT);
```

With:
```typescript
        await this.#relay.sendNeutralText(OWNER_STEP_UP_FORMAT_PROMPT);
```

## 11. S3-index-logging

File: `apps/cloud-gateway/src/voice/owner-call-step-up.ts`. Test: `tests/acceptance/fake/voice-owner-passphrase-security.test.ts`, selection `requires a real successful`.
Result: Tests  2 failed | 36 skipped (38); exit 1, assertion failure.

Replace:
```typescript
    if (matched) return "matched";
```

With:
```typescript
    if (matched) { console.info("owner_step_up_verified_word_indexes 0-1-2"); return "matched"; }
```

## 12. plaintext-word

File: `apps/cloud-gateway/src/voice/owner-call-step-up.ts`. Test: `tests/acceptance/fake/voice-owner-passphrase-security.test.ts`, selection `requires a real successful|exactly three mismatches`.
Result: Tests  3 failed | 35 skipped (38); exit 1, assertion failure.

Replace:
```typescript
    canonical.fill(0);
    const at = iso(now);
```

With:
```typescript
    canonical.fill(0);
    await this.#database.prepare("CREATE TABLE IF NOT EXISTS fixture_candidate_leak (value TEXT)").run();
    await this.#database.prepare("INSERT INTO fixture_candidate_leak (value) VALUES (?)").bind(candidate.split(/\s+/u)[0]).run();
    const at = iso(now);
```

## 13. plaintext-base64

File: `apps/cloud-gateway/src/voice/owner-call-step-up.ts`. Test: `tests/acceptance/fake/voice-owner-passphrase-security.test.ts`, selection `requires a real successful|exactly three mismatches`.
Result: Tests  3 failed | 35 skipped (38); exit 1, assertion failure.

Replace:
```typescript
    canonical.fill(0);
    const at = iso(now);
```

With:
```typescript
    canonical.fill(0);
    await this.#database.prepare("CREATE TABLE IF NOT EXISTS fixture_candidate_leak (value TEXT)").run();
    await this.#database.prepare("INSERT INTO fixture_candidate_leak (value) VALUES (?)").bind(btoa(String.fromCharCode(...new TextEncoder().encode(candidate)))).run();
    const at = iso(now);
```

## 14. plaintext-hex

File: `apps/cloud-gateway/src/voice/owner-call-step-up.ts`. Test: `tests/acceptance/fake/voice-owner-passphrase-security.test.ts`, selection `requires a real successful|exactly three mismatches`.
Result: Tests  3 failed | 35 skipped (38); exit 1, assertion failure.

Replace:
```typescript
    canonical.fill(0);
    const at = iso(now);
```

With:
```typescript
    canonical.fill(0);
    await this.#database.prepare("CREATE TABLE IF NOT EXISTS fixture_candidate_leak (value TEXT)").run();
    await this.#database.prepare("INSERT INTO fixture_candidate_leak (value) VALUES (?)").bind(Array.from(new TextEncoder().encode(candidate), (b) => b.toString(16).padStart(2, "0")).join("")).run();
    const at = iso(now);
```

