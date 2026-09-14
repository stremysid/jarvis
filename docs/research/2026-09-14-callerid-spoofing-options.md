# R1 call safety research (2026-09-14)

This is reviewer-commissioned research, done read-only by Claude Opus 5. Nothing
here authorizes a migration, deploy, secret change or live call.

## Read this first: Sid's decisions supersede the reports' open questions

**Owner call passphrase: DECIDED.** Sid was asked in plain terms whether
Jarvis should ask for a short secret phrase at the start of every call. He
replied "okay add a phrase". Build it for BOTH inbound and outbound owner calls:
a spoken passphrase before owner authority is minted, with 3 tries and then the
call ends, and no lockout. Build the `TN-Validation-Passed-A` waiver, but ship it
switched off.

This reverses the 2026-08-30 owner/guest design line: "The owner accepts
Caller ID possession risk for the PIN-free owner experience". That line was
recorded as the owner's decision and was never confirmed as Sid's. Record the
correction in DECISIONS.md.

**Voicemail privacy is covered by the passphrase.** Nothing is disclosed until
the phrase is given, so answering-machine detection is optional. Build AMD only
as a cost optimization, not for privacy.

**First-call setup: Sid's request.** The first official call, once calling
and memory are live, is a guided onboarding call:
1. Set the owner passphrase, guest PINs and basic security settings, inside a
   session already trusted through phone enrollment.
2. Jarvis then asks Sid questions to get to know him and saves the answers to
   memory, which depends on R2.

Guardrails:
- Secrets spoken during setup never reach transcripts, model context, events
  or logs; reuse the guest-PIN secrecy machinery.
- Store only a verifier.
- Keep a CLI fallback to set or rotate the phrase.
- Sid was told to make that call parked, not driving.

**Reviewer-verified facts behind the decision:**
- Inbound owner admission resolves only by the webhook `From` number
  (`voice-access-repository.ts` `resolveInboundCandidate`), and nothing reads
  `StirVerstat`.
- An owner voice session can administer guest access (`call-session-do.ts`
  wires `OwnerAccessService`). A number spoofer could therefore grant
  themselves persistent guest access.

The two reports follow unchanged.

---

# Caller-ID spoofing on owner calls: defence options

Prepared 2026-09-14. Research only: no repository edits, no production
commands, no calls. Code read from `origin/main` at `8150e36`. Every web
source was fetched on 2026-09-14; §9 marks each one verified or unverified.

## Summary for Sid

1. Right now, anyone who fakes your number when calling Jarvis is treated as you, with your memories and your guest controls.
2. Carriers can stamp calls as "verified" (STIR/SHAKEN). Twilio only checks those stamps in the US and France, and Canadian stamps aren't broadly trusted in the US, so expect your calls not to carry one.
3. Recommendation: say a short secret phrase of three words when a Jarvis call starts, whether you call Jarvis or Jarvis calls you. It's spoken, so it works in the Tesla.
4. It costs a few seconds and about 1 cent per call. A wrong phrase gets 3 tries and then the call ends. You are never locked out.
5. If tests later show your calls do arrive stamped, you can choose to skip the phrase on those calls, accepting a small SIM-swap risk.
6. This reverses the recorded "no PIN for the owner" decision, so it needs your yes before R1 calls go live.

## 1. The gap, confirmed in code

- `apps/cloud-gateway/src/voice/inbound.ts`: the Worker checks the Twilio signature itself, or accepts the router's already-verified form. It then requires exactly one `From`, `To` and `CallSid`, checks that `To` is the Jarvis number, and passes `From` on as `callerE164`. It reads no other webhook field.
- `persistence/voice-access-repository.ts:847-860` (`resolveInboundCandidate`): if the number's identity row is the configured owner and is active and verified, it returns `kind: "owner"` with `activationChallengeId: null`. Nothing else is required.
- `voice/call-session-do.ts:829-841` (`#resumeBoundPreAuthentication`): on the first valid relay setup, an owner binding goes straight through `mintOwner` to `authenticated` and then `active`. A guest is asked for a four-digit PIN (`:842-845`). An activation-only session gets the device-bound six-digit challenge (`:822-828`).
- None of the owner checks asks for a second factor. `voice-access-authority.ts:323-347` (`mintOwner`), `voice-access-repository.ts:1391-1425` (`mintOwnerAuthority`) and the D1 trigger `call_session_authorities_require_current_lineage` (`migrations/0006_voice_access.sql:608`) check only the session phase, the binding and the owner identity's state.
- `git grep -i "stir|verstat|shaken"` over `apps`, `packages` and `docs` finds nothing in the gateway.
- Twilio's signature covers every POSTed field: `twilio-verifier.ts` `signedPayload` hashes all pairs. A `StirVerstat` value therefore cannot be forged without the auth token, although it only tells Jarvis what Twilio saw.
- The designs took this risk knowingly, but the wording is ambiguous:
  - Owner/guest design §2: "Voiceprints and speaker verification are deferred. The owner accepts Caller ID possession risk for the PIN-free owner experience." "Possession" reads like someone holding Sid's phone, not someone faking his number without it.
  - `docs/plan/2026-09-14-owner-phone-enrollment-options.md`, property 2, says Caller ID by itself is not verification. That is inconsistent with how owner calls are admitted.
  - Foundation §5.1 only requires tests proving that a spoofer cannot cause a persistent lockout.
- Impact: owner authority reaches every installed capability (owner/guest §3.1), memory, and owner-only access administration. A spoofer could add a guest grant for their own number and keep access after hanging up. Every confirmation step is spoken by the same caller.

## 2. Carrier attestation (Q1)

### 2.1 What Twilio sends

- **Where it appears.** Programmable Voice puts `StirVerstat` in the incoming-call webhook. Elastic SIP Trunking uses the `X-Twilio-VerStat` header instead. Twilio may also send `StirPassportToken`, and `CallToken` carries the PASSporTs for forwarding.
- **When it is absent.** The field appears only when the incoming INVITE carried a SHAKEN PASSporT Identity header. Twilio's own 2023 blog warns that it can be missing.
- **Values:**
  - `TN-Validation-Passed-A`, `-B`, `-C`
  - `TN-Validation-Failed-A`, `-B`, `-C`: tampering, or Twilio could not fetch the signer's certificate.
  - `TN-Validation-Failed` or `NULL`: no level determined.
  - `No-TN-Validation`: malformed number, invalid PASSporT, `orig` not matching the caller ID, `dest` not matching, or `iat` older than about a minute.
  - Any of the above with a `-Diverted` or `-Passthrough` suffix.
- **What `Passed-A` is tied to.** Twilio compares `orig` with the caller ID, so `Passed-A` is bound to the `From` number.
- **When verification fails.** Twilio error 32021: the call still connects, without a status.
- **Cost.** Neither Twilio's US nor its Canada voice price page lists a charge for verification.

### 2.2 US and Canadian Twilio numbers

- **Where Twilio verifies.** Twilio's SHAKEN/STIR page says support is deployed only in the United States and France. The 2020 and 2021 changelogs said US only.
- **Canadian Twilio number.** Expect no `StirVerstat` at all. This is an inference, unverified until measured.
- **US Twilio number.** It is verified, but a call from a Canadian mobile crosses the border (§2.3).
- **Which one Jarvis has.** The repository doesn't say; `TWILIO_FROM_E164` is configuration. Sid knows.

### 2.3 How reliable A is for Sid's iPhone calling Twilio

- **Signing at the source.** Canadian carriers must sign IP calls (§2.4). iPhone VoLTE, 5G and Wi-Fi calling are all IP, so Sid's carrier very likely signs, probably with A for his own number. Unverified: his carrier is unknown and no carrier documentation was found.
- **Crossing into the US.** A US verifier must trust the Canadian certificate authorities. The evidence says that trust isn't in place broadly:
  - The Canadian industry guideline (CISC NTWG STIR/SHAKEN Guidelines v2.0) notes the July 2022 STI-GA/CST-GA memorandum. It says there is still no CST-GA policy enabling broad cross-border authentication, only bilateral arrangements.
  - TELUS's US affiliate told the FCC there is no formal Canada–US key-exchange agreement.
  - TransNexus (2021) merges both certificate lists in its own verifiers, which shows trust is decided provider by provider. Whether Twilio does the same is unverified.
- **Likely outcomes on a US Twilio number:** the signature is stripped on the way (absent), `TN-Validation-Failed-A` because the certificate isn't trusted, or `Passed-A` if Twilio trusts Canadian authorities.
- **Canadian Twilio number:** absent (§2.2).
- **Calls from the Tesla.** The Tesla is only a Bluetooth audio device; the iPhone places the call on the carrier network. Attestation should match a handset call. Reasoned, unverified.
- **Forwarded calls.** Canadian guidance currently marks diverted calls `No-TN-Validation`.
- **Bottom line:** treat A as unavailable for Sid until it is measured on his real phone against the real Jarvis number.

### 2.4 CRTC status in 2026, and who signs

- **The mandate.** CRTC Decision 2021-123 made STIR/SHAKEN on IP voice calls a condition of service from 30 November 2021.
- **The 2025 change.** CRTC Decision 2025-343 (16 December 2025) ended the semi-annual reports for providers that had filed four, and replaced them with targeted information requests. Newer implementers file two simplified annual reports, due 31 May. The obligation itself is unchanged.
- **What the CRTC says about coverage.** On average, providers authenticate the vast majority of their IP calls. Some are only now moving from TDM to IP.
- **Who signs.**
  - CST-GA tokens are open to incumbent and competitive local carriers and to facilities-based wireless carriers.
  - The public CST-GA participants page lists only non-shareholder participants such as Google Voice Canada, RingCentral and Ooma, not Bell, Rogers or TELUS.
  - TELUS's US filing says TELUS Canada traffic meets the CRTC requirements.
  - Press reports say Bell, Rogers and TELUS implemented by the 2021 deadline (unverified).
  - No official per-carrier list was found.

### 2.5 How often legitimate calls arrive unattested

- No public figure exists for legitimate mobile calls specifically (unverified).
- **US proxy.** TransNexus, June 2026: 48.8% of calls reaching its customers' terminating networks carried a signature, and 30.8% of all calls carried A. Roughly half arrive unsigned. This covers all call types, including robocalls.
- **FCC.** The triennial report (19 December 2025) finds the framework effective when correctly applied, but notes that non-IP segments defeat it. US gateway providers must sign unsigned calls only when the caller ID is a U.S. NANP number, which a Canadian number is not.
- **Canada.** The industry guideline expects legitimate numbers to fail verification for various reasons during deployment. The CRTC collected per-level statistics but published none.

### 2.6 Can an attacker get A for Sid's number?

A compliant carrier won't give A for a number that was simply typed in. A requires the signer to have a verified association between its customer and the number (ATIS-1000074, as set out by the FCC). The realistic routes are:

1. **Take over the number** by SIM swap, port-out or carrier account takeover. The CRTC pressed Canadian carriers on unauthorized ports and SIM swaps in 2020–2022 and reported a significant decline, not elimination. The attacker's calls then carry a genuine A.
2. **A carrier that misattests.** In August 2024 the FCC settled with Lingo Telecom for $1M: Lingo had signed 3,978 spoofed election robocalls with A, relying on a customer's self-certification.
3. **Someone holding Sid's unlocked phone.** The A is honest; the caller isn't Sid.

TransNexus also found 1.9% of A-attested calls were robocalls in June 2026. **A stops casual spoofing; it does not prove the caller is Sid.**

## 3. Options (Q2)

Costs use Twilio list prices fetched 2026-09-14: inbound $0.0085/min, outbound $0.014/min, ConversationRelay $0.07/min, answering-machine detection $0.0075/call, Media Streams $0.0044/min. Build effort is a rough estimate.

| Option | Security value | Friction, including the Tesla (no keypad) | Cost | Build effort here | Failure modes |
|---|---|---|---|---|---|
| **(a)** Require `TN-Validation-Passed-A` for PIN-free access; refuse otherwise | Stops casual spoofing. Doesn't stop a SIM swap, a misattesting carrier, or someone holding Sid's phone. | None when A arrives. When it doesn't, Sid is refused outright, which is likely on his path (§2.3). | $0 | Small, ~1–2 days: parse the field in `inbound.ts`, refuse the owner in `resolveInboundCandidate`, add tests. No migration. | Lock-out on a Canadian Twilio number, cross-border trust gaps, forwarding (`-Diverted`, `No-TN-Validation`), Twilio verification errors (32021), carrier routing changes. |
| **(b)** Hybrid: `Passed-A` skips the phrase; anything else must speak it | Unattested calls are as strong as (c). Attested calls keep (a)'s gaps: a SIM swap or misattestation skips the phrase. | Nothing on A calls, one phrase otherwise. Works in the car. | ~1¢ per unattested call | Medium: (c) plus attestation parsing, a policy switch, and evidence fields. | Prompts come and go if attestation is intermittent. Same speech-to-text and echo issues as (c). |
| **(c)** Always require a spoken passphrase (or PIN) | Defeats spoofing, SIM swap, misattestation and another person holding the phone, unless the phrase has leaked. A recording of Sid saying it can be replayed. | One phrase per call, about 3–5 s. Works in the car. | ~1¢ per call (10 s × $0.0785/min) | Medium, ~1.5–2 builder-weeks including review: owner verifier, CLI to set and rotate, DO state, authority proof, trigger, migration, evidence. Reuses the guest-PIN machinery. | Road noise or Bluetooth audio misrecognized; echo transcribed as an attempt; phrase visible as text at Twilio and Deepgram; overheard by passengers. |
| **(d)** Voice biometrics / speaker verification | Weak against AI voice clones; not fit as the only factor. | Could be passive, but falsely rejects when the voice or background noise changes. | No public vendor pricing. Azure Speaker Recognition was retired 30 Sep 2025. Needs Media Streams on top of ConversationRelay. | Large: ConversationRelay passes only text, so a raw-audio fork, a new vendor and template storage are needed. | Voice clones; false rejects. Canada's privacy commissioner expects express consent and proof no less intrusive option exists, and a passphrase does. |
| **(e)** Twilio Verify Silent Network Auth, or other carrier checks | SNA proves SIM possession, but only through a cellular-data request from an app or browser on the phone, not through a voice call. A SIM-swap lookup is only a risk signal. | Requires tapping the phone, which is illegal while driving in Ontario. | Per-verification fees (amount not captured); 2–4 weeks of carrier approval; SNA is in beta. | Large: an iOS app or SMS-link flow; still not a factor inside the call. | The browser method needs Wi-Fi off; Canadian carrier coverage for the SIM-swap lookup is limited. |
| **(f)** Accept the risk and monitor | Nothing stops disclosure; any alert arrives after memory has been read and a guest may have been added. | None | $0 | ~0 | Contradicts the enrollment document's own rule. Spoofing is cheap, and the expansion plan has Jarvis calling and texting other people, so its number won't stay private. |
| **(g)** *Extra:* Jarvis hangs up and calls the enrolled number back | Defeats pure spoofing. Doesn't stop a SIM swap or call forwarding; whoever answers is trusted. | 10–20 s plus one tap to answer, which Ontario allows. | ~2–3¢ per call | Medium. Breaks foundation §5.2, under which only Telegram or the CLI may create calls. Needs anti-harassment limits. | The same voicemail and other-person problems as outbound (§7). Spoofers could trigger calls to Sid. |

## 4. A spoken secret, the keypad, and the Tesla (Q3)

A spoken owner passphrase is viable, within these limits:

- **Where the phrase becomes text.** ConversationRelay transcribes speech at Twilio's provider (Jarvis uses Deepgram `nova-3-general`) and sends only text to the Worker, as `prompt` messages with `voicePrompt` and `last`. No raw audio reaches the Worker. So the phrase always exists as text at Twilio and Deepgram.
- **What Jarvis can keep it out of.** Its own transcripts, events, logs, model context and memory, exactly as the guest PIN path already does: `call-session-do.ts:995-1009` handles pre-auth prompts before the conversation path.
- **Third parties.** Whether Twilio or Deepgram retain relay transcripts is not stated in the documents reviewed (unverified). Treat the phrase as a secret shared with a processor, and rotate it on suspicion.
- **No `hints`.** Don't put the phrase's words in the TwiML `hints` attribute to improve recognition; that would put the secret in TwiML, which the design already forbids for PINs.
- **Why words rather than digits:**
  - 4 digits give 10,000 values. With 3 tries per call and budgets that expire after 5 minutes (deliberately no persistent lockout), a spoofer can grind through them over many calls.
  - Three random words from a 7,776-word list give about 4.7×10¹¹.
  - Spoken digits also collide with homophones (four/for, two/to, eight/ate), and `normalizeSpokenPin` accepts only the exact words.
- **Replay.** Anyone who records Sid saying the phrase can replay it. That is acceptable at this threat level; rotate if a passenger overhears it.
- **Failure modes in the car:**
  - Road noise and Bluetooth hands-free audio cause false rejects.
  - Jarvis's own prompt echoing back can be transcribed and burn a try.
  - The mitigations are in §6.4.

DTMF from the car:

- **Ontario law.** While driving, including when stopped at a light, it is illegal to dial on a hand-held phone. A mounted phone may be touched only to make, answer or end a call. Keypad entry on the iPhone is out while driving.
- **Tesla touchscreen keypad during a call: unverified.**
  - Tesla's manual page returned 403.
  - An unofficial copy of the manual mentions the on-screen dialer only for placing calls.
  - An owner-forum thread reports that the Tesla dialer won't send post-dial digits.
  - Even if an in-call keypad exists, it means typing on a screen while driving.
- **iPhone keypad during a call.** Apple's current iOS 26 page doesn't mention it; an older Apple iPhone guide and the Apple Watch guide do (partly verified). It is usable when parked, and Jarvis already sets `dtmfDetection="true"`.
- **Conclusion:** the owner factor must be spoken. Don't add a short numeric DTMF fallback; it would become the weakest way in.

## 5. Recommendation (Q4)

Adopt **(c) now, built in the shape of (b)**:

1. **Every owner call needs the phrase.** Inbound and outbound, the caller must speak a three-word owner passphrase before owner authority is minted.
2. **Build the attestation waiver, but ship it off.** An exact `StirVerstat=TN-Validation-Passed-A` on an inbound call skips the phrase only when the policy switch is set to waive. It ships as `passphrase_always`.
3. **Measure from day one.** Record the attestation category on every owner call. Turn the waiver on only if Sid's real calls consistently arrive `Passed-A`, and only if Sid accepts that a SIM swap or a misattesting carrier would then skip the phrase.
4. **Don't ship** (a) on its own (likely lock-out), (d), (e) or (f).

Reasons:

- Only a spoken factor is both legal and hands-free in the Tesla.
- A is probably absent on Sid's path, so (a) would lock him out and (b) behaves like (c) anyway.
- A is not identity: a SIM swap or Lingo-style misattestation produces a genuine A.
- It reuses the existing guest-PIN machinery (verifier construction, attempt budgets, secrecy tests, the pre-auth state) and adds no vendor.
- The same phrase closes the outbound voicemail and other-person gap in `KNOWN_ISSUES.md` #1 (§7).

**Friction:** one phrase at the start of a call, about 3–5 s, up to 3 tries, no persistent lockout.
**Cost:** about 1 cent per call.
**Build:** medium, roughly 1.5–2 builder-weeks including the migration, CLI and review.

**Sid must decide.** This reverses the 2026-08-30 PIN-free owner decision, and the recorded acceptance of "Caller ID possession risk" may never have covered spoofing. Under `CLAUDE.md`, a recorded attribution is evidence, not proof.

## 6. Design notes for the builder

### 6.1 Records first

- Get Sid's decision recorded.
- In the same PR, amend the owner/guest design (§2, §8, §10, §11) and the foundation design (§5.1, §5.2, §5.3). The design requires a single current contract.
- Update `KNOWN_ISSUES.md` #1 once outbound uses the phrase.

### 6.2 Where the checks go

1. **`voice/inbound.ts`, after `snapshotVerifiedTwilioFormPairs`:** read `values("StirVerstat")` and classify it.
   - 0 values → `absent`.
   - Exactly 1, equal to `TN-Validation-Passed-A` → `passed_a`.
   - Exactly 1 other value → `other`.
   - More than 1 → 403, the same rule as for `From`, `To` and `CallSid`.
   - Never lowercase, trim or prefix-match.
   - Pass the result into `getOrCreateInboundSession`, and update the exact input sets on both sides (`call-repository.ts:715`).
2. **Policy binding.** Add a Worker binding such as `OWNER_CALLER_ID_POLICY`, with values `passphrase_always` or `waive_on_passed_a`. A missing or unknown value means `passphrase_always`. Read it in `production-runtime.ts` alongside the existing peppers (`:38-40`).
3. **`call-repository.ts` `getOrCreateInboundSession` (`:706`).** Forward the attestation and the policy to `resolveInboundCandidate`. Persist `owner_step_up` on the `call_sessions` insert. Compare it in `inboundCandidateMatchesRow`, so a replayed webhook with a different attestation conflicts.
4. **`voice-access-repository.ts` `resolveInboundCandidate`, owner branch (`:853-860`).** Return `stepUp: "required"` unless the policy is `waive_on_passed_a` and the attestation is `passed_a`. Leave the activation-only branch (`:861-883`) alone; its device challenge is already a factor.
5. **Binding contract.** Add `ownerStepUp: "required" | "waived_passed_a" | "not_applicable"` to `RelayBinding` (`packages/contracts/src/calls.ts:47`) and to every exact binding field set:
   - `inbound.ts` `BINDING_FIELDS`
   - `call-session-do.ts:57`
   - `call-repository.ts:49`
   - `voice-access-authority.ts:91`
   - `inbound-auth.ts` `snapshotBinding`
   - the `outbound.ts` binding snapshot

   Guests and activation-only sessions get `not_applicable`; an outbound owner is always `required`.
6. **Migration `0016`.**
   - Add `call_sessions.owner_step_up` with CHECKs: guest or activation-only → `not_applicable`; outbound owner → `required`; `waived_passed_a` only on inbound.
   - Make the column immutable by extending `call_sessions_voice_access_immutable`.
   - Add `call_session_owner_step_ups` (session_id primary key, verifier_version, verified_at), insert-once, with no update or delete.
   - Extend the owner branch of `call_session_authorities_require_current_lineage` to require `owner_step_up = 'waived_passed_a'` or a matching step-up row.
7. **`voice/call-session-do.ts`.**
   - `#resumeBoundPreAuthentication` (`:829`): an owner binding marked `required` enters a new `owner_step_up` interaction, sends a neutral "Say your passphrase.", and does not mint.
   - Constructor mapping (`:699-707`): today a pre-auth owner maps to `conversation`. Map a `required` owner to `owner_step_up`, so a Durable Object evicted mid-step-up resumes it.
   - `#handlePrompt` (`:995`): add an `owner_step_up` + `pre_auth` branch ahead of the conversation path. Act only on final prompts: canonicalize, reserve budget, verify, then mint with a proof. Never forward the text, and always `return`.
   - `#handleDtmf` (`:1096`): in `owner_step_up`, ignore or clear. There is no DTMF owner path.
   - Outbound: after the neutral voicemail line (`:818-820`), enter the same state.
8. **`voice-access-authority.ts` `mintOwner` (`:323`).** When the binding says `required`, demand a nominal `OwnerStepUpProof`, single use, bound to the session ID, CallSid, direction and verifier version. `mintOwnerAuthority` (`:1391`) should insert the step-up row and the authority in one batch.
9. **Budgets.** Add an owner reservation to `AuthenticationAttemptBudget` (`inbound-auth.ts`) and reuse `evaluatePinAttempt`: 3 failures → `rejected`. Keep the 5-minute expiry; foundation §5.1 forbids a spoofer-caused persistent lockout.
10. **Alerts.** Send an owner Telegram alert on a failed or terminated step-up, containing the attestation category and time only, never the number.

### 6.3 Verifier and enrollment

- **Secret and construction.** Add a new secret `OWNER_PASSPHRASE_PEPPER_V1` (32 random bytes, never in D1). Use the guest-PIN v2 construction:
  - HMAC-SHA-256 with the pepper, feeding PBKDF2-HMAC-SHA-256
  - 600,000 iterations, 16-byte salt, 32-byte digest
  - constant-time comparison
  - its own domain label, for example `jarvis.owner-passphrase/v1`
- **Canonical form before hashing.** NFC, lowercase, strip punctuation, collapse whitespace, reject anything that isn't letters. The word count is fixed at three.
- **Setting and rotating.** Only through the device-signed Windows CLI (the Option 1 enrollment trust path), never by call, Telegram or model.
  - The CLI generates the three words locally from a wordlist with homophones removed and shows them once.
  - It sends only the verifier, over a signed request.
  - Sid tries the phrase once in the car at speed before go-live.
- **Storage.** One versioned verifier row per owner identity. Rotation replaces it atomically and writes an audit event that contains no secret.

### 6.4 Relay behaviour in noise and echo

- Keep `partialPrompts="false"` (`twiml.ts:93`) and act only on `last=true`.
- If a candidate doesn't have exactly three words, re-prompt without using up an attempt. This absorbs Jarvis's own prompt echoing back and stray noise transcripts, and reveals only the fixed word count.
- The prompt text never contains any passphrase word, and there are no `hints`.
- Clear the candidate on interruption, socket close and hibernation, as the guest PIN does.

### 6.5 Tests and evidence

- **`apps/cloud-gateway/test/http/inbound-voice.test.ts`.**
  - Every `StirVerstat` input, under both policies, maps to the right `ownerStepUp` or to 403: absent, each `Passed` and `Failed` level, `TN-Validation-Failed`, `No-TN-Validation`, `-Diverted`, `-Passthrough`, lowercase, padded, duplicated.
  - A request with `StirVerstat` added after signing gets 403.
- **`test/persistence/voice-access-repository.test.ts`.** The owner step-up matrix; a stale or unknown policy yields `required`; guests are unaffected; a replay with a different attestation conflicts.
- **`test/voice/call-session-do.test.ts`.** No mint before a proof; three wrong phrases → `rejected`; the right phrase → `active`; eviction mid-step-up resumes the step-up; interruption clears the candidate; outbound behaves the same; the word-count rule holds.
- **Verifier unit tests.** Known-answer vectors, separation from the guest-PIN domain, the constant-time path, and an unknown pepper version failing closed.
- **Migration tests.** Reject a NULL or invalid `owner_step_up`, an update after insert, an owner authority without a step-up row, and a waiver on an outbound session.
- **Secrecy.** Extend the PIN-secrecy gate so the phrase is absent from replies, frames, model context, events, provider events, call sessions, DO storage, turns, logs, errors and TwiML.
- **Fake acceptance (`tests/acceptance/fake/voice-call-path.test.ts`).**
  - Replace "admits the owner without a PIN…" and "answers an owner outbound call without a PIN…" with step-up versions.
  - Add "owner number without the passphrase gets no authority, no model request and no memory read" for every attestation value.

### 6.6 Guards to mutation-test

The repository's practice is manual mutants that the tests must kill.

1. Exact equality on `TN-Validation-Passed-A`. Mutants: `startsWith`, `includes`, case-folding, negation.
2. Rejection of a duplicated `StirVerstat`. Mutant: take the first value.
3. The policy default, and the fallback to `passphrase_always` on an unknown value.
4. The step-up computation in `resolveInboundCandidate`. Mutant: always waive.
5. The `owner_step_up` comparison on replay.
6. The DO's owner pre-auth branch and its constructor mapping. Mutants: mint without a proof; map to `conversation`.
7. The proof check in `mintOwner`, the proof's binding to session and CallSid, and single use.
8. The step-up condition in the D1 authority trigger, and the immutability trigger.
9. Reserving budget before verifying, and ending the call after 3 failures.
10. The early `return` in the step-up prompt branch. Mutant: fall through to the model.
11. Outbound owner bindings forced to `required`.
12. The live evidence validator. Mutant: accept a waiver without `passed_a` and the waiver policy.

The DO, authority and trigger guards are deliberately redundant. Record which mutants survive on their own, as `KNOWN_ISSUES.md` already does for the evidence-store guards.

### 6.7 How R1's live acceptance scenarios change

- **`tests/acceptance/live/voice-smoke.ts`.** Replace `OWNER_AUTHENTICATION_MODE = "owner_identity_pin_free"` (`:185`) and `validatePinFreeOwner` (`:280`) with step-up evidence:
  - `authenticationMode`: `owner_passphrase` or `owner_attested_waiver`
  - `ownerStepUpPromptCount`, `ownerStepUpAttemptCount`
  - `callerIdAttestation`: `passed_a`, `other` or `absent`
  - `ownerCallerIdPolicy`

  A waiver is valid only with `passed_a` and the `waive_on_passed_a` policy. The guest `pinPromptCount` stays 0.
- **`inbound` and `outbound-answer`.** Prove the passphrase passed before the first model turn.
- **`outbound-no-answer`.** Voicemail hears only the neutral line and the step-up prompt, with zero model requests and zero personal-context reads.
- **New `owner-step-up-refused`.** This is the "inbound owner unattested" scenario. Sid calls from his own phone and says a wrong phrase three times. Expect `rejected`, 0 authenticated turns, 0 model requests and 0 personal-context reads, mirroring `unauthorized-caller`. It takes the same path a spoofer would, without spoofing anything.
- **Optional `owner-attested-waiver`.** Only if Sid enables the waiver. If his calls are attested and an unattested one is still needed, running the scenario under `passphrase_always` is enough. Twilio's verified-caller-ID method (B attestation) would add Sid's number as an outgoing caller ID, a persistent Twilio change that needs his approval.
- **Also update:** `VOICE_SMOKE_SCENARIOS` (`:7`), `scripts/voice-release-gate.mjs`, the "All five scenarios" wording in `docs/runbooks/voice-smoke.md`, and the release-gate list in foundation §5.3.

### 6.8 Measure before enabling the waiver

- During the attended enrollment call and the R1 calls, record only the attestation category, never the number.
- Cover at least three setups, on different days: the handset on LTE or 5G, Wi-Fi calling at home, and the Tesla over Bluetooth while driving.
- Enable the waiver only if every call reads `passed_a`. Re-check after any carrier change or Twilio number change.

## 7. Outbound calls (Q5)

- **Spoofing doesn't apply.** Jarvis dials the enrolled number, and Twilio signs its own leg, so attestation adds nothing.
- **The real risks:**
  - voicemail answering; `KNOWN_ISSUES.md` #1 shows a greeting can become owner input and draw a memory-backed reply
  - someone else answering Sid's phone
  - call forwarding set on Sid's line
  - a SIM swap
- **The same passphrase fixes all four for memory disclosure.** Asked right after the neutral line, it can't be said by a voicemail system or another person.
- **Answering-machine detection** ($0.0075/call) spots machines but not other people. It's optional, for example to avoid leaving even the neutral line on voicemail.
- **Friction:** Sid started the call himself with `/call`, so the phrase is expected.

## 8. Unverified or open

- Which country Jarvis's Twilio number is in.
- Sid's carrier, and whether it signs his calls with A.
- Whether Twilio verifies Canadian-signed PASSporTs on US numbers.
- A mobile-specific rate of unattested legitimate calls.
- Whether the Tesla touchscreen has an in-call keypad that sends DTMF.
- The iPhone in-call keypad wording on Apple's current page.
- Whether Twilio or Deepgram retain ConversationRelay transcripts.
- How well speech-to-text catches a spoken phrase in the Tesla at highway speed.
- SIM-swap lookup coverage for Canadian carriers, and SNA pricing.
- Build-effort figures, which are rough estimates.

## 9. Sources

### Repository (verified by reading `origin/main` at `8150e36`)

- `apps/cloud-gateway/src/voice/inbound.ts`; `voice/call-session-do.ts:699-707, 818-847, 995-1009, 1096-1130`; `voice/voice-access-authority.ts:323-347`; `voice/pin-capture.ts`; `voice/twiml.ts:93`; `voice/outbound.ts`; `providers/twilio-verifier.ts` (`signedPayload`)
- `persistence/voice-access-repository.ts:819-905, 1391-1425`; `persistence/call-repository.ts:706-827` and `requireInboundSessionReplay`/`inboundCandidateMatchesRow`; `persistence/migrations/0006_voice_access.sql:551-670`
- `packages/contracts/src/calls.ts:47`; `voice/production-runtime.ts:34-40`
- `tests/acceptance/live/voice-smoke.ts:7-13, 95-130, 185, 280-286, 334-347`; `tests/acceptance/fake/voice-call-path.test.ts:36, 90`
- `docs/superpowers/specs/2026-08-29-jarvis-foundation-design.md` §5; `docs/superpowers/specs/2026-08-30-jarvis-owner-guest-call-access-design.md` §2, §3.1, §5, §8; `docs/plan/2026-09-14-owner-phone-enrollment-options.md`; `KNOWN_ISSUES.md` #1; `docs/runbooks/voice-smoke.md`; `docs/plan/2026-08-jarvis-expansion-plan.md:34`

### Twilio

- [verified] Trusted calling with SHAKEN/STIR: `StirVerstat` and `X-Twilio-VerStat` values, presence only with an Identity header, deployment in the US and France only, `StirPassportToken`, `CallToken`. https://www.twilio.com/docs/voice/trusted-calling-with-shakenstir
- [verified] Changelog, 21 Sep 2020, inbound verification in the US only. https://www.twilio.com/en-us/changelog/twilio-performs-shaken-stir-verification-on-incoming-calls-to-yo
- [verified] Blog, Fun Call Flows Using STIR/SHAKEN (26 Apr 2023): `StirVerstat` may be missing; verified caller IDs are signed B. https://www.twilio.com/en-us/blog/developers/tutorials/building-blocks/shaken-stir-call-flows
- [verified] SHAKEN/STIR Onboarding: numbers not bought from Twilio get at most B. https://www.twilio.com/docs/voice/trusted-calling-with-shakenstir/shakenstir-onboarding
- [verified, search excerpt] Error 32021: a call whose PASSporT can't be verified still connects. https://www.twilio.com/docs/api/errors/32021
- [verified] ConversationRelay WebSocket messages: setup, prompt and dtmf fields; no STIR field. https://www.twilio.com/docs/voice/conversationrelay/websocket-messages
- [verified] ConversationRelay TwiML attributes: `dtmfDetection`, `interruptible`, `hints`, transcription providers. https://www.twilio.com/docs/voice/twiml/connect/conversationrelay
- [verified] Voice pricing for Canada and the US; no line item for SHAKEN/STIR verification. https://www.twilio.com/en-us/voice/pricing/ca and https://www.twilio.com/en-us/voice/pricing/us
- [verified] Verify Silent Network Auth overview and technical overview: beta, SIM device must call the SNA URL over carrier data, Canada listed, 2–4 week carrier approval. https://www.twilio.com/docs/verify/sna and https://www.twilio.com/docs/verify/sna/tech-overview
- [unverified; search summary only] Lookup SIM Swap: Canadian carrier data needs NPAC approval. https://www.twilio.com/docs/lookup/v2-api/sim-swap
- [verified, search excerpt] Media Streams gives raw audio and lists voice authentication as a use. https://www.twilio.com/docs/voice/media-streams
- [verified] Voice biometrics through a third party (VoiceIt), Twilio blog 2022. https://www.twilio.com/en-us/blog/voice-biometrics-voiceit

### Regulators and standards

- [verified] CRTC Compliance and Enforcement and Telecom Decision 2025-343, 16 Dec 2025. https://crtc.gc.ca/eng/archive/2025/2025-343.htm
- [verified as cited by 2025-343 and the CISC guideline; not fetched directly] CRTC Decision 2021-123, 6 Apr 2021, effective 30 Nov 2021. https://crtc.gc.ca/eng/archive/2021/2021-123.htm
- [verified] CISC Network Working Group STIR/SHAKEN Guidelines v2.0 (CST-GA): attestation levels, intra-carrier tagging, diversion treated as `No-TN-Validation`, §1.7 on cross-border traffic. https://cstga.ca/wp-content/uploads/2024/06/STIR-SHAKEN-Guidelines-Version-2.0.pdf
- [verified] CST-GA participants page. https://cstga.ca/participants/
- [verified] CST-GA Policy Guide v3.0: token eligibility. https://cstga.ca/wp-content/uploads/2022/06/GA_Policy-Guide_V3.0.pdf
- [verified; copy of an FCC filing] TELUS Communications (U.S.) Robocall Mitigation Plan: no formal Canada–US key-exchange agreement. https://documents.dps.ny.gov/public/Common/ViewDoc.aspx?DocRefId=%7BB00AAC89-0000-CF1D-8372-5836533191A9%7D
- [verified] FCC Enforcement Bureau, Lingo Telecom Order and Consent Decree, DA 24-790, 21 Aug 2024: 3,978 spoofed calls signed A, ATIS-1000074 definitions. https://docs.fcc.gov/public/attachments/DA-24-790A1.pdf
- [verified; first sections read] FCC Wireline Competition Bureau, Triennial Report on STIR/SHAKEN efficacy, 19 Dec 2025. https://docs.fcc.gov/public/attachments/DOC-416732A1.pdf
- [verified, search excerpts] CRTC staff letters on unauthorized ports and SIM swaps, 17 Jul 2020 and 10 Feb 2022. https://crtc.gc.ca/eng/archive/2020/lt200717.htm and https://web.crtc.gc.ca/eng/archive/2022/lt220210.htm
- [verified] Office of the Privacy Commissioner of Canada, Guidance for processing biometrics – for businesses, 11 Aug 2025. https://www.priv.gc.ca/en/privacy-topics/health-information-genetics-biometrics/biometrics/gd_bio_org-final/
- [verified] Government of Ontario, Distracted driving (updated 16 Jul 2025). https://www.ontario.ca/page/distracted-driving

### Industry, vendors and other

- [verified; industry data, US terminating traffic] TransNexus, STIR/SHAKEN statistics from June 2026. https://transnexus.com/blog/2026/shaken-statistics-june/
- [verified; dated 2021] TransNexus, U.S.–Canada cross-border SHAKEN. https://transnexus.com/blog/2021/us-canada-cross-border-shaken/
- [verified] Microsoft Docs change recording Azure Speaker Recognition retired 30 Sep 2025. https://github.com/MicrosoftDocs/azure-ai-docs/commit/7aeb5d07fb8c2446e0b7bf1778b7d385c3743726
- [verified that AP reported the statement; the claim itself is unverified] AP via SecurityWeek, 23 Jul 2025: OpenAI's CEO says AI has defeated voiceprint authentication. https://www.securityweek.com/openais-sam-altman-warns-of-ai-voice-fraud-crisis-in-banking/
- [verified] Apple, While on a call on iPhone (iOS 26; no keypad wording). https://support.apple.com/guide/iphone/while-on-a-call-iph3c9951d7/ios
- [verified] Apple, While on a call on Apple Watch (in-call Keypad). https://support.apple.com/guide/watch/while-on-a-call-apd444b1e721/watchos
- [unverified; page returned 403] Tesla Model Y Owner's Manual, phone page. https://www.tesla.com/ownersmanual/modely/en_us/GUID-68582EA9-CBE5-4474-880E-3EF4992002DF.html
- [unverified; unofficial manual copy] https://www.temoy.org/using_the_phone_app-1154.html
- [unverified; owner forum] Tesla Motors Club, phone call controls (2023) and dialer pause for extensions (2024). https://teslamotorsclub.com/tmc/threads/phone-call-controls.302821/ and https://teslamotorsclub.com/tmc/threads/phone-dialer-with-pause-for-extensions.334156/
- [unverified; press, search summary] MobileSyrup, Nov 2021: Bell, Rogers and TELUS implementing by the deadline. https://mobilesyrup.com/2021/11/17/spam-calls-no-more-stir-shaken-implemented-by-end-of-month-crtc-chair/
