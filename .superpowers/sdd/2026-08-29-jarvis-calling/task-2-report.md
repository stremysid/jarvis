# Task 2 implementation report

Status: DONE

Commit: `284e8b2 feat(calls): extend shared Twilio provider for signed relay ingress`

Implementers:

- `/root/task2_relay_twiml`: strict current ConversationRelay decoder, fixed voice-tuple TwiML renderer, and 88 focused tests.
- `/root/task2_rest_signature`: Workers-native REST provider, Request-owned signature verifier, nominal immutable verified form, faithful non-idempotent fake behavior, and 70 focused tests.
- Controller integration: changed the old dispatcher concurrency assertion so two raw provider invocations demonstrate duplicate-call risk rather than fake idempotency.

TDD evidence:

- RED: provider/relay modules were absent; contract hardening then exposed 17 expected relay/TwiML failures before implementation.
- GREEN: relay/TwiML suite passed 88/88; REST/signature/fake slice passed 70/70.
- Integrated focused verification after workstation recovery: four files, 165/165 tests passed.
- Integrated full verification after workstation recovery: 31 files, 653/653 tests passed.
- `pnpm typecheck`: all three workspace projects passed.
- `pnpm lint`: all three workspace projects passed.
- `pnpm audit --audit-level high`: no known vulnerabilities.
- `git diff --check`: no errors; Windows line-ending notices only.

Implemented guarantees:

- Twilio call creation uses one fixed-host POST, API-key Basic authentication, `redirect: "manual"`, exact HTTP 201 success, four repeated callback events, bounded streaming response parsing, and no retry/idempotency header.
- Possibly accepted outcomes become `provider_dispatch_unknown`; the fake proves a direct second invocation creates another accepted call.
- Webhook verification consumes the original `Request` once, streams a 64 KiB maximum form body, strictly decodes UTF-8 and percent escapes, verifies HMAC-SHA1 against the exact URL with current Twilio multi-value semantics, and only then mints a nominal frozen form capability.
- Relay decoding accepts current setup/prompt/DTMF/interrupt/error shapes, rejects mixed/obsolete/oversized frames, validates canonical 32-byte base64url nonces, and discards raw provider interrupt/error content.
- TwiML is DTMF-enabled, uses authenticated barge-in settings, carries exactly one opaque nonce, and restricts voice configuration to `en-US` / Deepgram `nova-3-general` / Google `en-US-Journey-O`.

Concerns for reviewer attention:

- Check whether the REST callback/TwiML URL validator should also forbid query strings and non-default ports.
- Check whether the exact URL supplied to signature verification needs a separate scheme/control-character guard without parsing or reserializing the signed value.
- Future routes must never clone, pre-buffer, or reparse the signed request; durable orchestration must own suppression after `provider_dispatch_unknown`.

## Review fix round 1/5

Status: DONE

Base reviewed commit: `284e8b2`

Findings addressed:

- IMPORTANT: outbound REST and TwiML URL inputs are pinned to one validated HTTPS public origin and exact opaque route shapes. Query strings, fragments, credentials, non-default ports, attacker origins, route mismatches, and non-opaque session identifiers fail closed. URL values are snapshotted through `URL.prototype.toString` internal-slot serialization, so subclass overrides cannot alter validation or emitted traffic.
- IMPORTANT: outbound TwiML routes bind to the immutable dispatch `attemptId`, while `commandId` remains lineage and `idempotencyKey` remains correlation only. A later attempt for one command therefore receives a distinct TwiML route and nonce boundary.
- IMPORTANT: status callbacks also bind to `/voice/status/${attemptId}`. Global, command-bound, and other-attempt callback routes fail closed so reconciliation cannot attach a provider outcome to the wrong attempt.
- IMPORTANT: exact webhook and WebSocket signature URLs now require syntactically valid `https://` and `wss://` URLs respectively, with no raw controls, backslashes, malformed percent escapes, userinfo, or fragments. Validation parses only for syntax; HMAC still receives the caller's untouched exact string.
- MINOR: webhook body reader acquisition is inside the guarded path. Already-consumed and externally locked requests resolve to signature failure instead of throwing.

TDD evidence:

- Trusted-origin/route boundary RED: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/providers/twilio.test.ts apps/cloud-gateway/test/providers/conversation-relay.test.ts` produced 19 expected failures and 121 passes. Mutations caught: accepting attacker origins, identity-bearing queries, non-default ports, wrong fixed routes, and overridable URL stringification.
- Trusted-origin/route boundary GREEN: the same command passed 140/140; `pnpm --filter @jarvis/cloud-gateway typecheck` passed.
- Exact-signature-URL boundary RED: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/providers/twilio.test.ts -t "validly signed"` produced 20 expected failures and 47 skips. Mutations caught: signing validly signed HTTP/WS, userinfo, fragment, raw-control, malformed-percent, backslash-normalized, and malformed-authority exact strings.
- Exact-signature-URL boundary GREEN: the full Twilio provider suite passed 67/67; package typecheck passed. Non-canonical but valid exact URL fixtures also proved that validation never replaces the bytes supplied to HMAC.
- Consumed/locked body RED: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/providers/twilio.test.ts -t "already consumed|already locked"` produced 2 expected failures and 67 skips, both rejected `TypeError`s from unguarded reader acquisition.
- Consumed/locked body GREEN: the full Twilio provider suite passed 69/69; package typecheck passed.
- Attempt-bound route RED: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/providers/twilio.test.ts -t "immutable attempt identity|command lineage"` produced 2 expected failures and 69 skips. The old implementation rejected the attempt route and accepted the command route.
- Attempt-bound route GREEN: the same command passed 2/2 with 70 skips; the expanded Task 2/provider-dispatch focused suite then passed 210/210 and package typecheck passed.
- Attempt-bound status callback RED: `pnpm exec vitest --config vitest.workspace.ts run apps/cloud-gateway/test/providers/twilio.test.ts -t "status callback route"` produced 2 expected failures, 2 passes, and 72 skips. The old implementation rejected the attempt route and accepted the unsafe global route; command-bound and other-attempt guards already failed closed.
- Attempt-bound status callback GREEN: the same command passed 4/4 with 72 skips.
- Final Task 2 focused verification: 4 files, 214/214 tests passed; package typecheck passed.
- Final repository verification: 31 files, 702/702 tests passed; all three workspace typechecks and lints passed; `pnpm audit --audit-level high` reported no known vulnerabilities; `git diff --check` reported no errors (Windows line-ending notices only).

Concerns for reviewer attention:

- None remaining in this fix round.
