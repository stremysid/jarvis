# H0 Voice Consolidation Evidence

## Immutable inputs

- `ownerGuestSourceHead`: `143af7e67994783f86f8a49f9a5e76cd281688e7`
- `voiceSourceHead`: `909098f11886d3a4f4ddd7f0b11272e103717478`
- `hermesDesignPlanSourceHead`: `bab90140d0de822492ef4c655feda2155422172d`
- `approvedHermesDesignCommit`: `2cb294eb131aeba8e85c47e7f5aca75e8cee81b9`
- `exactMergeBase`: `143af7e67994783f86f8a49f9a5e76cd281688e7`
- `candidateTree`: `e3923ae0b3371fe0ffef818ae590d178f49977c7`
- `voiceHeadContainsOwnerGuest`: `true`

The candidate tree is the staged, conflict-free merge result captured before
the documentation-only H0 corrections and this evidence record. The H0
identity is the commit that contains this evidence record; downstream work
must use that commit as its immutable base.

## Toolchain

- Git `2.55.0.windows.5`
- Node.js `v24.19.0`
- pnpm `11.19.0`

## Verification command record

1. `pnpm install --frozen-lockfile`
2. `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/http/voice-routes.test.ts apps/cloud-gateway/test/http/voice-callback-recorder.test.ts apps/cloud-gateway/test/http/voice-callbacks.test.ts apps/cloud-gateway/test/http/voice-route-construction.test.ts apps/cloud-gateway/test/http/worker-voice-routes.test.ts apps/cloud-gateway/test/voice/outbound-recipient-lookup.test.ts apps/cloud-gateway/test/voice/call-session-do.test.ts apps/cloud-gateway/test/security tests/acceptance/fake/voice-call-path.test.ts tests/acceptance/live/voice-smoke.test.ts`
3. `pnpm test:voice-smoke`
4. `pnpm test`
5. `pnpm typecheck`
6. `pnpm lint`
7. `pnpm audit --audit-level high`
8. `pnpm smoke:voice -- --scenario inbound`
9. `pnpm release:voice-gate`

## Expected credential-gated outcomes

The default voice smoke command exits zero as a safe skip and emits
`live_execution_not_authorized`. The read-only voice release gate is
intentionally nonzero and emits `release_voice_evidence_incomplete`. H0 does
not create live-call evidence or perform a live action.
