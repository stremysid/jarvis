# PR #33 security design review: owner call passphrase boundary

- PR: [#33](https://github.com/ksid1229-ops/jarvis/pull/33) (draft). Head `f6eb083`, base `origin/main` `8150e36`.
- PR #31 context was read at `327ddda` (`origin/codex/r1-owner-phone-enrollment`).
- Review type: read-only security design review for Claude Opus 5, 2026-09-14.
- Method: `git fetch`, `git archive f6eb083`, `git diff origin/main...f6eb083`, `gh pr view/checks`, `gh run view`, and reading code and docs. No tests were run, nothing was edited, and no production command was issued.
- Citations:
  - Docs and tests are cited at `f6eb083`.
  - The PR changes only docs and tests (`git diff --stat`), so every `apps/**` line is identical on `origin/main` `8150e36`. [V]
  - PR #31 files are marked `@327ddda`.
- Tags: [V] verified by reading or by running a command; [R] reasoning.

Abbreviations used below:

| Short | Path |
|---|---|
| `design` | `docs/superpowers/specs/2026-09-14-owner-call-passphrase-design.md` |
| `test` | `tests/acceptance/fake/owner-call-passphrase-security.test.ts` |
| `harness` | `tests/acceptance/fake/voice-call-system.ts` |
| `cid` | `docs/research/2026-09-14-callerid-spoofing-options.md` |
| `vm` | `docs/research/2026-09-14-outbound-voicemail-options.md` |
| `foundation` | `docs/superpowers/specs/2026-08-29-jarvis-foundation-design.md` |
| `owner-guest` | `docs/superpowers/specs/2026-08-30-jarvis-owner-guest-call-access-design.md` |
| `roadmap` | `docs/plan/2026-09-03-jarvis-roadmap.md` |
| `do` | `apps/cloud-gateway/src/voice/call-session-do.ts` |
| `calls` | `apps/cloud-gateway/src/persistence/call-repository.ts` |
| `access-repo` | `apps/cloud-gateway/src/persistence/voice-access-repository.ts` |
| `budget` | `apps/cloud-gateway/src/voice/inbound-auth.ts` |
| `pin-verifier` | `apps/cloud-gateway/src/security/guest-pin-verifier.ts` |

## Verdict

**CHANGES REQUESTED. Keep the PR in draft; do not merge it as-is.**

What is right:
- The documents carry the structure of Sid's decision consistently: both directions, three tries then the call ends, the waiver built but off, outbound never waived, and answering-machine detection (AMD) optional.
- The exact-value `StirVerstat` rule is correct.
- Current code has no path to the model or to owner access administration before owner authority exists.

Seven defects would ship in any implementation that follows the text faithfully:
1. B1: "three-word" is recorded as Sid's choice.
2. B2: "no lockout" is contradicted by the shared attempt budget and the two-session cap. A spoofer can keep Sid from reaching Jarvis by voice in both directions.
3. B3: the per-call wrong-phrase count resets when the Durable Object hibernates.
4. B4: the CLI set/rotate path cannot compute the specified peppered verifier or share its canonicalizer.
5. B5: there is no phrase-generation or entropy rule, and no lockout means guessing is only limited by call rate.
6. B6: the "existing five-minute pre-authentication deadline" does not exist.
7. B7: after a silent success, a repeated phrase is committed to transcripts and sent to DeepSeek.

Recommended landing: split. Merge a docs-only PR after the fixes, and move the red tests to the implementation branch after PR #31 merges. Separately, CI currently starts no jobs at all because of a billing failure. Fixing that is a money action only Sid can take.

| Severity | Count |
|---|---|
| BLOCKER | 7 |
| SHOULD-FIX | 13 |
| NIT | 7 |

## What holds up [V]

- **Pre-authority boundary in current code.**
  - The model is reachable only from the `active` prompt path (`do:1010`, `:1061-1068`).
  - Owner access administration requires owner authority and `access.manage` (`do:888-893`, `:1016-1030`). Owner DTMF administration runs only in `active` (`do:1109`).
  - `OwnerAccessService` is constructed only inside the call DO runtime (`apps/cloud-gateway/src/voice/production-runtime.ts:70-73`).
  - Once minting is removed from `#resumeBoundPreAuthentication` (`do:829-841`), owner prompts in `pre_auth` already fall through to `return` at `do:1010`. The default is fail-closed.
- **Exact `StirVerstat` handling.**
  - No normalization; `-Diverted` and `-Passthrough` never qualify (`design:101-111`).
  - A duplicated value gets the same 403 used for duplicated `From`, `To` and `CallSid` (`apps/cloud-gateway/src/voice/inbound.ts:312-331`).
  - Missing or unknown policy means the phrase is required (`design:158-162`).
- **Provider exposure is scoped honestly.** The design and DECISIONS say Twilio and the STT processor see the spoken candidate (`design:43-46`, `DECISIONS.md:28-32`). B7 is a separate, unscoped exposure.
- **Verifier choice.** Peppered HMAC into PBKDF2-SHA-256 at 600,000 iterations, 16-byte salt, 32-byte digest, constant-time compare and `finally` zeroing, the same as the reviewed guest code (`pin-verifier:152-243`).
- **No migration and no migration number** are added. `0016` is left to R2 (`design:83-86`), except for the research heading in S11.
- **No new Linux assumption** in any changed text. N3 is only about placement.

## Question 1: fidelity to Sid's decision [V]

| Sid's decision | Carried? | Where |
|---|---|---|
| Phrase on inbound and outbound owner calls | Yes | `design:8`, `:14-16`, `:25`, `:151-154`; `DECISIONS.md:9-13`; `foundation:125-131`; `owner-guest:33-34`, `:184-189` |
| 3 tries, then the call ends | Yes, as "three complete wrong candidates" (definition gaps in S2 and B3) | `design:16-17`, `:136-139` |
| No lockout | Stated, but contradicted by the shared budget and the slot cap | `design:17-18`, `:140`; B2 |
| Passed-A waiver built, shipped off | Yes | `design:20-25`, `:156-168` |
| Outbound never waived | Yes | `design:25`, `:99`; `owner-guest:185-186`; `foundation:167` |
| AMD optional | Yes | `KNOWN_ISSUES.md:21-22` |
| Reverse the 2026-08-30 line | Yes, but the quote's capitalisation changed | `DECISIONS.md:15-20`; N1 |
| Onboarding call: set phrase, PINs and security in an enrollment-trusted session, then an interview | Recorded; "enrollment-trusted" is undefined; "parked, not driving" is dropped | S5 |
| Guardrails: nothing in transcripts, model, events or logs; store only a verifier; CLI fallback | Stated, but the CLI path cannot work as written and there is a post-success leak | B4, B7 |
| Attribution | "Three-word" and the waiver's evidence gate are recorded as Sid's | B1 |

## Question 2: where each threat is covered

| Threat | Items |
|---|---|
| Brute force across redials, entropy, call rate, cost | B5 (arithmetic), B2, S12 |
| Cost floods | B6, S12, B2 (slots) |
| Overheard or recorded phrase, rotation | S13; replay is acknowledged at `design:56-57`; rollback protection is in B4 |
| STT normalization, false rejects, what counts as a candidate | B5, S1, S2; reconnect and hibernation in B3 |
| Provider-side exposure | Scoped correctly (above); B7 adds an unscoped DeepSeek and archive exposure |
| Waiver: exact match, variants, Canada | Holds (above; `cid:95-113` expects no attestation on a Canadian number); S4; S9 (duplicate case) |
| Owner-only capabilities before step-up | Holds in code (above); S4 for waived sessions |
| PR #31 activation-only session and the "enrollment-trusted" definition | S5, S6, S7 |
| Device-signed CLI set/rotate path | B4, S13 |

## BLOCKER

### B1. "Three-word" is recorded as Sid's decision, but he decided on "a phrase"

Evidence:
- The authority text says Sid was asked about "a short secret phrase" and replied "okay add a phrase" (`cid:8-13`). [V]
- Three words is the research's recommendation (`cid:166-168`, `cid:189-192`). [V]
- It is recorded as his in five places. [V]
  - `DECISIONS.md:9`: "Sid chose a three-word spoken passphrase".
  - `KNOWN_ISSUES.md:18`: "Sid decided on a three-word spoken passphrase".
  - `NEXT_STEPS.md:95-96`: Sid "requires a three-word spoken passphrase".
  - `roadmap:416`: "the decided three-word owner passphrase".
  - The PR body: "Sid chose a three-word spoken passphrase".
- The same owner-decision entry makes enabling the waiver conditional on "real-call evidence" (`DECISIONS.md:23-26`). That gate comes from the research (`cid:193`, `cid:323-327`). Sid said only to build the waiver and ship it switched off. [V]

Scenario: [R] A later session treats the word count as fixed by Sid and refuses to change it when B5 or S2 show another format is needed, for example four short common words for STT reliability. Or someone tells Sid "you chose three words". This is the misattribution pattern `CLAUDE.md` says has already happened twice. The word count also drives the guessing margin, so it must stay a reviewable design parameter.

Fix:
- In all five places, attribute to Sid only what he said: a spoken phrase on every owner call, both directions, 3 tries then the call ends, no lockout, waiver built but switched off.
- Label the three-word format and the waiver's evidence gate as design choices taken from the 2026-09-14 research.

### B2. "No lockout" is not reconciled with the shared attempt budget or the two-session cap

A spoofer can keep Sid from reaching Jarvis by voice, in both directions, for as long as the attack runs.

Evidence:
- **Design text.** Each complete candidate "reserves an authentication attempt before verification" (`design:135`) and "There is no account or device lockout" (`design:140`). The design never names the budget or says what happens when it is full. [V]
- **Existing budget.** Scopes over a sliding 300 s window (`budget:26-32`, `:225-247`). [V]
  - Per `CallSid`: 3.
  - Per (principal, identity, direction): 6.
  - Global, one bucket for every caller (`budget:228`): 30.
  - The research proposes reusing this budget for owner step-up (`cid:251`).
- **Exhaustion rejects the call** on the guest path (`do:1146-1149`). [V]
- **The attacker spends Sid's bucket.** A spoofed owner call binds Sid's own principal and identity (`access-repo:847-859`). [V]
- **Session admission** allows fewer than two non-terminal sessions per principal, counting both directions and any `pre_auth` relay. Inbound: `calls:770-779`, `:821-822`. Outbound: `calls:864-873`, `:894`. [V]
- **No deadline.** `pre_auth` has none (B6), so a relay holds its slot until someone hangs up. [V]
- **No throttle-clear path.** The foundation still says "Sid can clear throttles through authenticated Telegram or local CLI recovery" (`foundation:152-155`, re-flowed by this PR). No code clears `authentication_attempt_reservations` in `apps/cloud-gateway/src` or `apps/local-agent` (grep returns nothing). [V]

Scenarios: [R]
1. **Budget.** The attacker spoofs Sid's number and speaks six wrong phrases across two short calls every five minutes, about 576 calls a day. Sid's inbound bucket stays full. His real first candidate fails its reservation and, with guest semantics, his call is rejected. Ten calls per five minutes fill the global bucket, which blocks outbound owner step-up and every guest too.
2. **Slots.** The attacker holds two spoofed calls open in `pre_auth`, silent or saying non-three-word filler, which the design re-prompts at no cost (`design:131-133`). Sid's inbound call gets the neutral 403 at admission (`inbound.ts:344-347`). A Telegram `/call` outbound session is refused (`calls:864-873`).

Fix: write these into the design.
1. **Per call:** at most three complete candidates, counted durably (B3), then the call ends.
2. **Across calls:** owner step-up never rejects a candidate because a composite or global scope is full. With a generated phrase (B5), the composite cap adds no meaningful protection and only creates lockout. If CPU protection is needed, delay or queue verification rather than reject it.
3. **Bound each unauthenticated relay** with a short, alarm-backed step-up window and a re-prompt cap (B6).
4. **Reserve an outbound path.** Make sure an outbound owner session can always be created while inbound `pre_auth` relays exist. For example, exclude inbound `pre_auth` sessions from the outbound admission count, or reserve one outbound-owner slot. Keep outbound step-up out of every scope that inbound candidates can fill. Telegram `/call` then remains a working path during an inbound flood.
5. **Alert Sid** with a coalesced Telegram message on rejected step-ups and on owner-identity admission refusals, so he knows to close the inbound webhook.
6. **Recovery claim:** implement the foundation's throttle-clear recovery, or delete that sentence.
7. **Define "no lockout"** in the design: no state that outlives the attack, and no cross-call rejection of a candidate.

### B3. The wrong-phrase count is not durable, so "3 tries then the call ends" fails across hibernation

Evidence:
- **Design text.** It counts the first, second and third mismatch (`design:136-139`). On eviction it "reconstructs `owner_step_up` from the immutable binding and durable phase" (`design:147-149`). The count is not in that list. [V]
- **The guest pattern keeps the count in memory.** [V]
  - `#failedPinAttempts = 0` (`do:651`), incremented at `do:1152-1154`.
  - Cores are cached in an in-memory map and rebuilt on demand (`do:1335`, `:1637-1668`).
  - The DO uses the Hibernation API (`ctx.acceptWebSocket`, `do:1570`).
- **Cloudflare docs.** During hibernation "In-memory state is reset", and when an event arrives "the Durable Object is re-initialized and its `constructor` runs" (developers.cloudflare.com/durable-objects/best-practices/websockets/, "How hibernation works"). [V]
- **The only durable per-call limit is a sliding window.** The `CallSid` scope allows 3 reservations per 300 s, each expiring five minutes after creation (`budget:27`, `:31`, `:232`, `:238-239`). Minting is refused 30 minutes after connect (`access-repo:333-337`, `:1408-1412`). [V]
- **Reconnecting does not reset the count; only hibernation does.** [V]
  - A socket that closes in `pre_auth` fails the session (`do:1246`).
  - A second socket is refused (`do:1564`).
  - A terminal session gets no new core (`do:1652-1654`).

Scenario: [R] The attacker says two wrong phrases, stays silent until the DO hibernates, then continues. The rebuilt core counts from zero. Repeating this within the `CallSid` window gives up to about 18 guesses over the 30-minute mint window instead of three. The session never reaches `rejected` and the owner alert never fires.

Fix:
- Specify a durable per-session attempt ordinal, written before verification. Options: an insert-once D1 row `(session_id, ordinal 1..3)` with no candidate data, or a counter in DO storage.
- A mismatch on ordinal 3 commits `rejected` in the same batch.
- Add an eviction test: two wrong candidates, rebuild the core, third wrong candidate, expect `rejected`.
- The guest PIN path has the same defect today (P1).

### B4. The CLI set/rotate path cannot produce the specified verifier or share its canonicalizer

Evidence:
- **Only the pepper holder can compute the digest.** [V]
  - The owner verifier "matches the reviewed guest-PIN construction" with a dedicated `OWNER_PASSPHRASE_PEPPER_V1` Worker secret (`design:48-49`, `:68-76`).
  - The guest construction applies the pepper first: HMAC(pepper, domain‖0‖grant‖0‖PIN), then PBKDF2 keyed by that HMAC (`pin-verifier:152-155`, `:158-182`).
- **The CLI can only send a finished record.** The recovery path is the Windows CLI with "local canonicalization, and a signed request that sends only the verifier record" (`design:178-180`). [V]
- **The canonicalizer crosses languages.** "The same canonicalizer is used when creating and verifying a record" (`design:80`): creation runs in Python (`apps/local-agent`), verification in the TypeScript Worker. [V]

Scenarios: [R]
- An implementer following the text must either copy the pepper to the home PC, widening the one secret that makes a D1 dump useless offline, or quietly skip the pepper for records the CLI creates.
- Python `str.lower()`/`isalpha()` and JavaScript `toLowerCase()`/`\p{L}` disagree on some Unicode input. A record created by one never verifies in the other, so Sid fails three times on every call until he rotates.

Fix: choose one of these in the design.
- **Preferred.** Follow PR #31's precedent: the gateway generates the six-digit response, HMACs it with a Worker pepper, and returns it to the device-signed CLI (`apps/cloud-gateway/src/sync/owner-phone-enrollment.ts:174-182`, `:213-219` @327ddda).
  - The CLI sends a signed "generate" request.
  - The Worker draws the words (B5), stores the peppered verifier, and returns the words once for terminal display.
  - Nothing is typed.
- **Alternative.** The CLI sends the canonical phrase in the signed body and the Worker builds the verifier. The route neither stores nor logs the body.

Either way:
- Make the canonical alphabet ASCII `a-z` with single spaces, so there is no cross-language Unicode rule.
- Ship known-answer test vectors.
- Make rotation compare-and-swap on the expected current verifier version, so a captured older signed request cannot roll back to a leaked phrase.

The PR #31 CLI already refuses to run anywhere but the enrolled Windows 11 PC (`apps/local-agent/jarvis_local/phone_enrollment.py:128-129`, `:164` @327ddda), which suits Sid's hardware. [V]

### B5. No phrase-strength rule: a self-chosen phrase with no lockout is guessable, and some words can never match STT

Evidence:
- **Self-chosen phrase.** The only rule is "exactly three non-empty words made of letters" (`design:78-81`). Sid either types the phrase ("two hidden entries", `design:179`) or speaks it during onboarding ("entered twice", `design:187`). [V]
- **Generation dropped.** The research required words generated locally from a homophone-filtered list (`cid:263`) and based its security figure on that (`cid:166-168`, 4.7×10¹¹). The design dropped both. [V]
- **Fixed STT, no hints.** Deepgram `nova-3-general`, `en-US` (`apps/cloud-gateway/src/voice/twiml.ts:12-18`, `:93`); the design forbids hints (`design:81`). [V]

Guessing arithmetic: [R]

Assumptions:
- About 20 s per call of three guesses.
- Two concurrent relays.
- No composite cap, as B2 requires.

That gives about 18 guesses a minute, 26,000 a day and 9.5 million a year.

| Phrase space | Time to a 50% chance of a correct guess |
|---|---|
| 3 random words from 7,776 (38.8 bits) | about 25,000 years |
| 3 random words from 2,048 (33 bits) | about 450 years |
| 3 random words from 1,296 (31 bits) | about 115 years |
| Self-chosen, guessable space of 10⁶ | about 19 days |
| Self-chosen, guessable space of 10⁵ | about 2 days |

- The attack costs Sid about $226 a day in relay minutes (2 × 1,440 min × $0.0785, using list prices at `cid:146`), until the daily Twilio capacity limit refuses every call.
- Keeping the composite cap (1,728 guesses a day) only stretches a 10⁶ space to about 290 days, with Sid locked out the whole time.

Ways a legitimate phrase can fail STT: [R]
- Typed Canadian spellings (colour, grey, centre, harbour) against `en-US` output (color, gray, center, harbor).
- Number words rendered as digits fail the letters-only rule and loop on re-prompts.
- Homophones: right/write, for/four.
- Hyphenated words merge when punctuation is stripped, which changes the word count.
- Rare words are misheard without hints.

Scenario: [R] Sid types "grey harbour lantern" and fails three times on every call. Or he picks names and places that a dictionary finds in days.

Fix:
- The phrase is generated, never chosen.
- A CSPRNG draws words uniformly from a versioned list of common, phonetically distinct `en-US` words. Exclude number words, homophones, spelling variants, hyphenated or compound words, and long words.
- The design states the resulting bits and the guessing budget it assumes. Choose the word count for that list (see B1).
- Require one attended, successful spoken verification in the car before inbound opens (`cid:265`).
- Onboarding rotation uses the generated path, then one spoken confirmation (S5).

### B6. The design relies on a five-minute pre-authentication deadline that does not exist

Evidence:
- **Design claim.** `design:132-133` says "The existing five-minute pre-authentication deadline bounds noise and echo that never form a candidate." [V]
- **What the 300 s values actually are.** [V]
  - The relay-setup window for inbound sessions that never connected (`calls:750`, `:774-778`; `apps/cloud-gateway/src/persistence/migrations/0004_call_sessions.sql:59`).
  - The attempt-budget window (`budget:31`).
- **No deadline ends a connected session.** [V]
  - The call DO sets no alarm (no `alarm` or `setAlarm` anywhere under `apps/cloud-gateway/src/voice`).
  - The only later bound refuses minting 30 minutes after connect but does not end the session (`access-repo:333-337`, `:1412`).
  - A connected `pre_auth` session stays non-terminal until the socket closes or a provider callback arrives.

Scenario: [R] A spoofed caller, or voicemail answering an outbound call, keeps the relay in `pre_auth` indefinitely. Each minute costs $0.0785, and the call holds one of Sid's two principal slots (B2). Voicemail records repeated re-prompts until its own recording limit.

Fix:
- Add an owner step-up window enforced by a DO alarm, for example 45 to 60 s from the prompt, checked against the lifecycle generation as the voicemail research proposes (`vm:238-240`).
- Cap re-prompts for finals that are not candidates, for example at 3.
- Both limits end the call through the S3 path, count as neither a mismatch nor a lockout, and record no candidate data.
- Add fake tests driven by a manual clock.

### B7. After a silent success, a repeated phrase becomes a normal owner turn: committed, archived and sent to the model

Evidence:
- **No cue after success.** On a match the session moves to `active` (`design:141-145`), and the design defines nothing Jarvis says next. Today's owner activation also sends nothing after `active` (`do:829-841`). [V]
- **Any final prompt in `active` is committed and sent to the model** (`do:1010`, `:1061-1068`). [V]
- **The secrecy claim does not cover it.** It covers "every passphrase candidate" (`design:34-41`); a repeat after success is no longer a candidate. [V]
- **Prompts are not serialized.** The guest path has no in-flight guard (`do:995-1009`, `:1132-1175`), so a second final arriving during PBKDF2 or the D1 batch is handled concurrently. [V for the code; whether the DO input gate holds during D1 I/O is R]

Scenario: [R] In the car, Sid says the phrase and hears about a second of silence (PBKDF2 plus the D1 commit), so he says it again. The repeat lands in `active`. It goes into D1 `conversation_turns`, the event log and archive, and a DeepSeek request. That is the real secret in durable stores, not a wrong guess. If the repeat arrives while verification is still running, it spends a second attempt instead.

Fix:
- Send a fixed, non-model acknowledgement immediately after the commit. It must not be three words (S1).
- Serialize step-up: at most one verification in flight. Drop finals received during verification and for a short guard window after success.
- Treat the first final in `active` that canonicalizes to three words as a possible repeat: verify it, and drop it silently on a match.
- Add a secrecy test for the matching path (S9).

## SHOULD-FIX

### S1. The fixed prompt "Say your passphrase." is itself a complete three-word candidate

Evidence:
- **The prompt canonicalizes to three letter-words** (`design:127-128`). [V]
- **The re-prompt is described as a "fixed three-word re-prompt"** (`design:132`). [V]
- **Speech during agent speech is reported to the DO:** `interruptible="any"` and `reportInputDuringAgentSpeech="any"` (`twiml.ts:93`). [V]
- **The research names echo as a car failure mode** and relies on the word-count rule to absorb it (`cid:171-173`, `cid:271`). [V]

Scenario: [R] Tesla Bluetooth echo is transcribed as a final "say your passphrase", which is mismatch 1. The echoed retry prompt is mismatch 2. Sid is rejected, and alerted, without saying anything wrong.

Fix:
- No fixed utterance in step-up may canonicalize to exactly three words. That covers the prompt, the retry, the re-prompt, the acknowledgement (B7) and the outbound neutral line.
- Enforce this with a table-driven unit test.
- Silently discard any final that canonically equals a fixed utterance.

### S2. "Complete candidate" is undefined for real speech-to-text output

Evidence:
- **Three words is a candidate; anything else is re-prompted** (`design:130-133`). [V]
- **`partialPrompts="false"`** (`twiml.ts:93`). [V]
- **The fake always sends `last: true`** (`tests/acceptance/fake/voice-relay-system.ts:172`). [V]

Scenarios: [R]
- Sid pauses mid-phrase in road noise. Endpointing emits "meadow" and then "lantern synthetic" as two finals. Both are re-prompted, so he never succeeds.
- Leading filler such as "hey it's me" or "what's up jarvis" is three words and spends a try.
- Number words rendered as digits loop on re-prompts.

Fix:
- State whether finals arriving within a short window are joined before counting.
- Make the prompt ask for the phrase alone.
- Exclude number words from the list (B5).
- Add fake cases: split finals, digits, 2-word and 4-word finals, leading filler, and a final arriving around an `interrupt`.

### S3. Rejection needs a defined hang-up mechanism; the red test pins a WebSocket 1008 close the design never states

Evidence:
- **The test expects `closeCodes: [1008]`** (`test:137`); the design says only "closes the relay" (`design:137-138`). [V]
- **Today, rejection does not close the relay.** [V]
  - A rejected guest session is not closed when it is rejected (`do:1154`).
  - Later frames on the cached core are ignored (`do:1010`, `:1637-1638`).
  - A 1008 appears only if the core is rebuilt after eviction (`do:1591-1593`, `:1652-1654`).
  - A provider callback closes with 1000 (`do:1453`).
- **Twilio behaviour on a server close.** The voicemail research reports that Twilio marks a call `failed` on an unexpected WebSocket disconnect. It recommends the ConversationRelay `end` message plus `<Hangup/>` from the action URL (`vm:256-259`). [V as research text; Twilio's behaviour was not re-fetched]

Scenario: [R] The live `owner-step-up-refused` record (`design:232-233`) shows Twilio `failed` instead of a clean completion. The attended scenario then fails, or muddies its validator, and the fake test has locked in the wrong mechanism.

Fix:
- Specify the sequence: a fixed refusal line, then `end` with fixed `handoffData`, then `/voice/relay-ended` returning `<Hangup/>` for that reason.
- Use a policy close only if `end` fails.
- The test should assert the `end` frame and a durable `rejected`, not 1008.

### S4. Waived sessions keep owner access administration, and guest-grant changes are silent

Evidence:
- **The waiver accepts SIM-swap and mis-attestation risk** (`design:56-58`). [V]
- **Owner authority includes `access.manage`** (`production-runtime.ts:60`; `do:888-913`). [V]
- **No notification path.** `apps/cloud-gateway/src/voice/owner-access-service.ts` has no Telegram, notify, outbox or alert code (grep returns nothing). [V]
- **The only designed alert** is on the third mismatch (`design:138-140`). [V]

Scenario: [R] Sid later enables the waiver. An attacker SIM-swaps his number, gets a genuine Passed-A (`cid:136-142`), is admitted without the phrase, and adds a guest grant for a burner phone. After Sid recovers his SIM, the attacker keeps guest access, and Sid was never told.

Fix: cheap now, and dormant until the waiver is enabled.
- A `waived_passed_a` session cannot use `access.manage` or security settings unless the phrase is also passed in that call.
- Every guest-grant mutation sends a fixed Telegram notice with the masked target, the operation and the time.

### S5. The onboarding "enrollment-trusted" session is undefined and conflicts with PR #31 and the D1 rule

Evidence:
- **Design text.** The session "starts from enrollment-trusted authority", then ordinary owner authority starts the interview (`design:183-190`). [V]
- **PR #31's activation-only call ends after verification.** It says "Please call again to use Jarvis" (`do:1211-1214`), and the runbook says the call "ends after verification" (`docs/runbooks/owner-phone-enrollment.md:137-138` @327ddda). [V]
- **The interview's owner authority has no permitted source.** [V]
  - The binding enum has no onboarding value (`design:90-95`).
  - The D1 rule refuses owner authority without `waived_passed_a` or a step-up row (`design:116-119`).
- **Sid's "parked, not driving" guardrail is missing** from `NEXT_STEPS.md:105-112` and `roadmap:452-456`. [V]
  - Guest PINs are entered by DTMF (`design:187`), which needs the keypad.
  - The research found using the handset keypad while driving is illegal in Ontario (`cid:176-185`).

Scenario: [R] The onboarding builder either reuses the activation-only session, which cannot continue into setup, or mints owner authority from the setup segment. The second means loosening the trigger this PR introduces.

Fix: define it now in the design.
1. A device-issued, single-use onboarding challenge, in the same shape as PR #31's, opens a setup segment with no owner authority.
2. That segment runs only deterministic handlers that write verifier and guest-PIN records.
3. Ordinary owner authority then requires speaking the newly set phrase once. That is a normal step-up row, and it also proves STT recognizes the phrase in that environment.
4. Add "make this call parked, not driving" to the NEXT_STEPS and roadmap entries.

### S6. PR #31's live enrollment window opens caller-ID-only owner calling before the passphrase exists

Evidence:
- **Inbound goes live with the webhook.** PR #31's runbook: "Inbound calling is live from that moment" (`docs/runbooks/owner-phone-enrollment.md:109-110` @327ddda). [V]
- **Closing inbound afterwards is not a required step;** it is only described (`:170-171`). [V]
- **An active phone is admitted by caller ID.** Once the phone is active, owner authority comes from caller ID alone (`access-repo:853-859`, `do:829-841`). [V]
- **The rollout ignores the window.** This PR says inbound must stay closed until step-up ships (`KNOWN_ISSUES.md:19-20`), but its rollout (`design:220-233`) never mentions PR #31's live window. [V]

Scenario: [R] Sid runs the attended enrollment, and status reads `active`. The webhook stays set while the passphrase implementation is still in review. Any caller spoofing his number now reaches memory and guest administration.

Fix: in the design rollout, in NEXT_STEPS, and in PR #31's runbook when it is rebased, do one of the following.
- Defer the live enrollment call until the passphrase is deployed.
- Or make "remove the webhook immediately after `active`, then confirm with status" a required numbered step.

### S7. PR #31's caller-ID entries become stale and will conflict

Evidence:
- **KNOWN_ISSUES.** PR #31 adds `KNOWN_ISSUES.md:3-16` @327ddda: "The reviewer is sizing attestation gating... Do not make a live call or build one of those options until Sid records the decision". [V]
- **NEXT_STEPS.** It adds `NEXT_STEPS.md:107-108` @327ddda: "Before any live call, Sid must choose how owner admission will address caller-ID spoofing". [V]
- **This PR records that choice** (`KNOWN_ISSUES.md:3-24`, `NEXT_STEPS.md:95-103`). [V]

Scenario: [R] Whichever PR lands second either conflicts, or leaves an entry saying Sid has not decided next to one saying he has.

Fix: in the rebase plan, replace PR #31's two paragraphs with a pointer to this PR's entry.

### S8. The R2 latency check measures against the wrong limit

Evidence:
- **Design text.** `design:192-195` and `NEXT_STEPS.md:110-112` say to measure the R2 retriever against the voice model deadline of 30 seconds. [V]
- **Retrieval runs outside the model timers.** Context retrieval runs before the model call (`apps/cloud-gateway/src/conversation/conversation-service.ts:799-811`, before `:850-858`). The voice budget is 8 s to first token and 30 s total (`:171`). [V]
- **The release gate** is p95 time to first audible response at or below 4 s (`foundation:194`). [V]

Scenario: [R] A 3 s retrieval is well under 30 s but pushes p95 first-audible past 4 s. A hung retrieval never trips any model timer, because those timers have not started yet.

Fix:
- Measure retrieval against the 4 s first-audible budget.
- Add a retrieval timeout on the voice path that falls back to no extra context.

### S9. The tests diverge from the stated contract (brief; test strength is reviewed separately)

- **Nothing typechecks or gates the new file.** [V]
  - `tests/acceptance/package.json` runs `tsc --noEmit` against `tests/acceptance/tsconfig.json`, which includes only `safe-log-types.ts` and two `live/` files.
  - `tests/acceptance/tsconfig.voice.json` includes only `fake/voice-*.ts`.
  - The release gate runs only `tests/acceptance/fake/voice-*` (`scripts/voice-release-gate.mjs:6`).
  - So `owner-call-passphrase-security.test.ts` is never typechecked. Neither `pnpm test:voice-access` nor `release:voice-gate` will run it, even once it passes. The PR body's "`pnpm typecheck:voice-access`: passed" does not cover it.
  - Fix: rename it `voice-owner-passphrase-security.test.ts`.
- **`as never` turns off type checking for the whole inbound dependency object** (`harness:208-216`), in a file that is typechecked. [V] Fix: until the property exists, use `// @ts-expect-error` on that single property.
- **Two promises are untested.** The design says there is no personal-context read and no owner-only command before step-up (`design:14-16`). The tests assert only authority and model requests (`test:48-52`). [V] Fix: add a context-retriever spy and a pre-step-up "add guest ..." utterance.
- **Duplicate `StirVerstat`.** It must get the neutral reject (`design:106-108`). The harness accepts arrays (`harness:238-246`), but no case uses one. No case covers `-Diverted`, `-Passthrough` or padding either (`design:110-111`). [V]
- **The third-mismatch alert is untested** (`design:138-140`). [V]
- **Secrecy is tested only for a wrong candidate,** not for the matching path (B7). [V]

### S10. Operational docs still describe the PIN-free owner contract

Evidence: [V]
- `docs/runbooks/voice-smoke.md:37`: "Owner inbound and outbound, without a PIN".
- `docs/runbooks/voice-smoke.md:317`: owner scenarios require `authenticationMode: "owner_identity_pin_free"`.
- **Five records versus six.**
  - `docs/runbooks/voice-smoke.md:29` and `NEXT_STEPS.md:115-116` still say five scenarios or records.
  - The foundation now adds a sixth gate item (`foundation:190-191`), and the design adds `owner-step-up-refused` (`design:232-233`).
- `docs/HANDOFF.md:99` still calls PIN-free owner the current design.
- **The calling plan** says it is "superseded ... by PIN-free owner authority ... in the current foundation and owner/guest access designs" (`docs/superpowers/plans/2026-08-29-jarvis-calling.md:572`, `:899`). That is no longer true.
- **The code contract still requires the PIN-free mode** (`tests/acceptance/live/voice-smoke.ts:185`). That is expected until implementation.

Scenario: [R] The R1 live-smoke operator, or the next session reading HANDOFF, prepares PIN-free owner evidence and treats the passphrase as optional.

Fix:
- Add a one-line "superseded" banner to each document, pointing at the 2026-09-14 design.
- Leave code changes to the implementation PR.

### S11. Research section 6.2 still says "Migration `0016`"

Evidence:
- `cid:239` headings item 6 "**Migration `0016`.**". [V]
- The design (`design:83-86`) and `NEXT_STEPS.md:103` reserve 0016 for R2. [V]
- `docs/AGENT_LOG.md:102-103` tells the builder to "build the passphrase per the research design notes". The correct numbering rule appears only later, at `:111`. [V]

Scenario: [R] A builder follows section 6.2 literally, takes 0016, and collides with R2.

Fix: add a one-line correction either under the research header, which already carries post-research decisions, or in the design's source-reports paragraph (`design:235-238`).

### S12. Cost and alert floods are unbounded

Evidence:
- **Capacity check.** Inbound capacity is checked per call, after signature verification (`apps/cloud-gateway/src/http/voice-routes.ts:83-91`). [V]
- **Daily limit.** It uses a postpaid daily Twilio budget (`apps/cloud-gateway/src/archive/production-capacity.ts:21`, `:40`), and admission stops at that limit (`DECISIONS.md:34-42`). [V]
- **Refused calls still cost.** Refused callers may still incur Twilio charges (`NEXT_STEPS.md:92-93`). [V]
- **Uncoalesced alerts.** The step-up alert fires once per rejected call (`design:138-140`). [V]

Scenario: [R] A sustained spoofing campaign spends the day's Twilio budget by midday. Capacity then refuses Sid's own calls until the next day, while he receives hundreds of Telegram alerts.

Fix:
- Coalesce step-up alerts: send the first immediately, then a periodic count.
- State the cost bound per call: step-up window × $0.0785 per minute (B6).
- Consider a separate sub-budget for pre-authentication minutes, so a flood exhausts that rather than Sid's whole voice budget.

### S13. Sid cannot stop a compromised phrase while away from the home PC

Evidence:
- **The CLI is the only set or rotate path.** Setting and rotating go only through the device-signed Windows CLI (`design:177-181`). [V]
- **The CLI runs only on the home PC.** PR #31's CLI refuses to run anywhere but the enrolled Windows 11 PC (`apps/local-agent/jarvis_local/phone_enrollment.py:164` @327ddda). The device key lives on the home PC (`docs/runbooks/owner-phone-enrollment.md:8` @327ddda). [V]
- **The home PC is off overnight** (`CLAUDE.md`). [V]
- **No revoke path.** The design accepts replay and overhearing (`design:56-57`) but defines no revoke or disable path. [V]

Scenario: [R] A passenger hears the phrase on the Tesla speakerphone during a trip. Sid cannot rotate until he is back at the home PC. For those days, anyone who can spoof his number and knows the phrase has owner authority.

Fix:
- Add a Telegram command that only disables owner step-up. It marks the verifier revoked, and every owner call is refused with a fixed line until the CLI rotates the phrase.
- No phrase is ever accepted from Telegram, so `design:181` still holds.
- Link the command from the step-up alert, and add rotate-on-suspicion guidance to the runbook.

## NIT

- **N1. Quote capitalisation.** `DECISIONS.md:15-16` quotes the 2026-08-30 line with a lowercase "the". [V]
  - The original reads "The owner accepts Caller ID possession risk for the PIN-free owner experience." (`owner-guest:29` on `origin/main`).
  - Use "[t]he", or start the quote at "accepts".
- **N2. Overstated database guarantee.** "D1 protects direct or future writers" (`design:121-122`) goes too far. [R]
  - A writer that can insert the authority row can insert the step-up row in the same batch. Scope the claim to writers that omit step-up.
  - Have the trigger require the step-up row's `verifier_version` to equal the active verifier version, so a proof issued just before a rotation cannot mint.
  - Write out the HMAC input as domain‖0‖owner identity‖0‖verifier version‖0‖canonical phrase, mirroring `pin-verifier:158-165`.
- **N3. Roadmap placement.** The onboarding step sits inside the Linux home-node milestone (`roadmap:452-456`, under `:429-439`, whose steps provision a Linux server running under systemd). [V]
  - The text adds no Linux assumption.
  - But an owner-facing step now depends on the unresolved node decision in `CLAUDE.md`.
  - State the dependency as "R2 memory, however it is hosted", in a note that spans milestones.
- **N4. Trigger SQL guidance.** No SQL is sketched, so there is no CASE/RAISE hazard yet. Say it now anyway. [V]
  - Migrations are already applied, so extending the owner branch (`cid:243`) means dropping and re-creating `call_session_authorities_require_current_lineage` in the new migration.
  - Use only the two forms remote D1 accepts: `WHEN ... BEGIN SELECT RAISE(ABORT, ...); END` (`0006_voice_access.sql:608-663`) or `SELECT RAISE(ABORT, ...) WHERE ...` (`0015_voice_runtime.sql:136-141`).
  - Never use `CASE WHEN ... THEN RAISE`.
- **N5. Silent policy typo.** The fallback for an unknown policy value (`design:158-162`) silently ignores a typo in `waive_on_passed_a`. That is the safe direction, but log a fixed configuration warning so an intended enablement is not lost unnoticed during evidence runs. [R]
- **N6. Undefined term.** "Stale frames" (`design:130-131`) is undefined. Name them, for example frames from a previous lifecycle generation or after a terminal transition. [V]
- **N7. Outbound alert field.** The alert's "attestation category" (`design:139`) never applies to outbound calls. Say so. [V]

## Question 3: verifier and storage, summary

- **Construction** [V]
  - Pepper-first HMAC into PBKDF2-SHA-256 at 600,000 iterations, constant-time compare, zeroing (`pin-verifier:152-243`).
  - The pepper makes a D1 dump useless offline, and PBKDF2 adds cost if the pepper also leaks.
  - WebCrypto offers no memory-hard KDF, so PBKDF2 is the right available choice.
- **Normalization and who computes the verifier:** B4.
- **Phrase generation:** B5.
- **Where attempt counters live:** the design never says DO or D1; see B3.
- **Recommended storage**
  - Count attempts durably in D1, keyed by session, with no candidate data.
  - Use budgets only to protect CPU, and delay rather than reject (B2).
  - Keep the immutable step-up receipt as designed (`design:114-122`).
- **Migrations:** none added and no number taken (`git diff --stat`; `design:83-86`). The only 0016 conflict is the research heading (S11). [V]
- **Remote D1 trigger forms:** no SQL is sketched yet; see N4.

## Question 4: latency

- **No model call before the gate.** [V] The model is reachable only from the `active` prompt path (`do:1010`, `:1061-1068`), and the design keeps retrieval and model calls after the commit (`design:143-145`).
- **The prompt is fast.** [V]
  - There is no TwiML `welcomeGreeting` (`twiml.ts:93`).
  - The step-up prompt is fixed DO text sent on entering `pre_auth`, like today's guest prompt (`do:844`).
  - Outbound sends the neutral line first (`do:818-820`).
- **Cost of a correct phrase.** [R] Speech endpointing, plus one PBKDF2 at 600,000 iterations (not measured in workerd), plus one D1 batch. With the fixed acknowledgement from B7, Sid should hear a response within about 1 to 2 s.
- **The 4 s release gate is unaffected.** [V] It is measured on authenticated turns (`foundation:194`), so step-up time sits outside it. The design should still state that step-up adds a few seconds to every call; the research estimated 3 to 5 s (`cid:204`).
- **Serialize verifications (B7).** Concurrent PBKDF2 runs on one DO waste CPU and spend attempts.

## Question 5: doc accuracy

- **Consistent with code and each other:** the spec edits (`foundation:125-155`, `:167-178`, `:190-191`, `:293-304`; `owner-guest:5-60`, `:163-219`). [V]
- **Accurate:** KNOWN_ISSUES' description of the current gap (`KNOWN_ISSUES.md:5-16`) matches the code (`access-repo:847-859`, `do:818-841`). [V]
- **Inaccurate or stale:**
  - The throttle-clear sentence (B2).
  - The nonexistent five-minute deadline (B6).
  - The latency yardstick (S8).
  - The research's 0016 heading (S11).
  - The PIN-free operational docs (S10).
  - PR #31's stale caller-ID entries (S7).
  - The roadmap placement (N3).
- **Linux:** no new Linux assumption anywhere in the changed text.

## Question 6: landing plan

Facts:
- **The red file would fail the `workspace suite` CI job.** [V]
  - That job runs `pnpm test` (`.github/workflows/ci.yml:27-40`) on every PR and every push to `main` (`:3-7`).
  - The default Vitest project includes `tests/acceptance/**/*.test.ts` (`vitest.workspace.ts:29-30`).
  - So the 13 red cases fail the job on this PR and, if merged, on every later push to `main`.
- **CI is not running at all right now.** [V]
  - All seven jobs in this PR's run 34813519917 failed in 2 to 4 s with "The job was not started because recent account payments have failed or your spending limit needs to be increased".
  - The last five merge runs on `main` (PRs #27 to #32) failed the same way in 4 to 7 s.
  - No PR, including #31 and #33, currently has any CI evidence. Fixing this is a billing action only Sid can take.
- **Nothing enforces a green check.** [V] Branch protection and rulesets are unavailable on this plan: the GitHub API returns 403, "Upgrade to GitHub Pro or make this repository public". Nothing mechanically blocks merging a red PR.
- **Inconsistent signals.** [V] The new file is outside the voice gate and the typecheck (S9). A red file on `main` would break `pnpm test` but not `pnpm test:voice-access`.

Options:

| Option | For | Against |
|---|---|---|
| (a) Keep a single draft; implement on this branch after #31; merge everything together | `main` is never red. Contract and code are reviewed together. | The misattributed 2026-08-30 line, the PIN-free runbook and PR #31's stale entries remain the current contract on `main`. That lasts through implementation (the research estimates 1.5 to 2 builder-weeks, `cid:206`), while R1 rollout work reads `main`. The design review and the implementation review get merged into one. |
| (b) Split: a docs-only PR now; the tests move to the implementation branch | `main`'s contract, release blockers and attribution are corrected now. CI stays green once it runs again. The implementation PR must turn the cases green. | Specs on `main` describe behaviour that is not built yet; the KNOWN_ISSUES release blocker already covers that. The executable contract is not on `main` until implementation. |
| (c) Merge the tests as `it.fails` | The executable contract is on `main`. Vitest starts failing once the behaviour is fixed, forcing the flip. | `it.fails` passes on any throw (harness breakage, a renamed fixture, the `as never` shape), so the contract can rot silently. The combined `toEqual` objects keep "failing" under a partial implementation. The one currently passing case cannot be marked. The file is outside the gate and the typecheck, so `release:voice-gate` never sees the flip. |

Recommendation: **(b)**.
1. Fix B1 to B7 and the documentation SHOULD-FIXes on this branch.
2. Move the test file and the harness change to the implementation branch. Create that branch from `main` after #31 merges, and rename the test per S9.
3. Mark #33 as docs-only and merge it after re-review.
4. The implementation PR must:
   - turn every case green;
   - add the B3, B6, B7, S1, S2 and S3 tests;
   - remove `as never`;
   - reconcile PR #31's entries (S7).

If Sid wants the contract executable on `main` sooner, use (c) only with both of these:
- a wrapper that asserts the thrown error is Vitest's assertion error with the expected keys;
- a KNOWN_ISSUES checklist for flipping the tests.

## Pre-existing on `main` (not introduced by this PR)

- **P1. Guest PIN failure count resets on hibernation.** It lives in instance memory (`do:651`, `:1152-1154`). "Three failures terminate" (`owner-guest` section 10) can therefore be bypassed within one call by pausing. The fix is the same as B3. [V for the code; hibernation per the Cloudflare docs]
- **P2. Throttle-clear recovery is not implemented.** The foundation promises it (`foundation:154-155`). [V]
- **P3. CI jobs do not start** because of billing, on `main` and on every open PR. [V]
- **P4. Unauthenticated `pre_auth` relays use up session slots.** They count toward the principal's two sessions in both directions (`calls:770-779`, `:864-873`). [V]

## Not verified

- **No tests were run.** There is no `node_modules` in this worktree, and the review is read-only. The "13 fail / 1 pass / 2,529 pass" figures come from the PR body.
- **The PBKDF2 iteration cap in production.** Whether production Workers accept 600,000 iterations is unknown.
  - The local `workerd.exe` contains an "iteration counts above ..." message whose limit value is formatted at runtime.
  - The Cloudflare docs search returned nothing.
  - The repo's guest verifier test performs a real derivation locally (`apps/cloud-gateway/test/security/guest-pin-verifier.test.ts:20-44`).
- **Twilio behaviour**, taken from the research documents and not re-fetched:
  - what a server-initiated WebSocket close does to the call;
  - `end` and action-URL semantics;
  - minute rounding;
  - transcript retention at Twilio or Deepgram.
- **Hibernation timing:** the actual idle interval, and whether ConversationRelay sends frames during caller silence that would prevent hibernation.
- **Deepgram behaviour:** how `nova-3` endpointing and formatting handle split phrases, digits and spellings.
- **DO input gates:** whether D1 calls hold the Durable Object input gate (the concurrent-prompt case in B7).
- **Attack figures:** throughput and cost numbers assume about 20 s per call and list prices; nothing was measured.
- **Twilio number country:** the production number's country is unknown. The fixtures' `+1416...` number is not evidence.
- **Out of scope:** PR #31 beyond `327ddda`, and the separate test-strength review.
