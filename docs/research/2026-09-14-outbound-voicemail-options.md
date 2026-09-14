# Jarvis outbound calls: voicemail and call-screener privacy

Research only, 2026-09-14. Code read at local `origin/main` `f2424f5`. No repository edits, no calls placed.

## For Sid

1. Right now, if voicemail picks up a Jarvis call, Jarvis may say private things into the recording.
2. Fix: Twilio checks whether a person or a machine answered. Under 1 cent a call, about 23 cents a month.
3. Machine: Jarvis says one plain line and hangs up. Person: Jarvis talks. Not sure: you say a short phrase first.
4. After you answer, you may hear 3 or 4 seconds of quiet. Say "Hello" and wait.
5. On your iPhone, save Jarvis's number as a contact.
6. Keep Jarvis calls switched off until this is built and tested.

## The gap, confirmed in code

- `apps/cloud-gateway/src/voice/call-session-do.ts:819` sends `OUTBOUND_VOICEMAIL_MESSAGE` when an outbound session enters `pre_auth`. At `:830`, in the same step, it calls `mintOwner` for `accessKind === "owner"` and moves to `active`. It waits for no input.
- `apps/cloud-gateway/src/providers/twilio-provider.ts:73-89` (`requestBody`) sends `To`, `From`, `Url`, `Method`, `StatusCallback*`, `TimeLimit=1800` and `Timeout`. There is no `MachineDetection` and no `AsyncAmd`. `voice/production-routes.ts:92` sets `ringTimeoutSeconds: 30`.
- `apps/cloud-gateway/src/voice/outbound.ts` (`claimOutboundTwiML`) reads only `CallSid` and `To` from the signed form. It returns `<Connect><ConversationRelay>` for every answered call. `voice/twiml.ts` sets `dtmfDetection="true"`, `interruptible="any"` and `reportInputDuringAgentSpeech="any"`.
- `apps/cloud-gateway/src/http/voice-callbacks.ts` status parsing reads `CallSid`, `CallbackSource`, `SequenceNumber` and `CallStatus`. Nothing anywhere reads `AnsweredBy`. The relay-ended (`<Connect action>`) handler returns `204`.
- `apps/cloud-gateway/src/persistence/voice-access-repository.ts:1391` (`mintOwnerAuthority`) requires only `phase = 'pre_auth'` and a matching binding. It needs no evidence that a person is on the line.
- The Durable Object has no alarm or timer.
- `providers/twilio-cleanup-url.ts:5` adds `#rc=2&rp=ct,rt,5xx` to the status and `<Connect action>` URLs.

**How it happened.**
- The foundation spec (`docs/superpowers/specs/2026-08-29-jarvis-foundation-design.md:139`) had outbound calls ask for a DTMF PIN after the neutral line.
- The owner/guest plan (`docs/superpowers/plans/2026-08-30-jarvis-owner-guest-voice-access.md:15`) made the owner PIN-free. The pause before disclosure went with the PIN.
- The evidence contract now requires `owner_identity_pin_free` with zero PIN prompts.

**Effect.** When voicemail (Live Voicemail or carrier) or iOS Call Screening answers:
1. The greeting is transcribed as a final prompt.
2. Jarvis runs an owner turn with memory.
3. The reply is spoken into the recording. With Live Voicemail and screening, the iPhone also shows it as live text.

The runbook says calling is still disabled (`outbound_runtime_controls.enabled = 0`), so this should not have happened live yet.

**R1 smoke risk.** `outbound-no-answer` requires Twilio status `no-answer`. The ring timeout is 30 s, and Twilio may add 5 s. If Sid's voicemail answers sooner than that:
- the call ends as `completed`, so the scenario cannot pass;
- with today's code, Jarvis talks into his voicemail during the release gate.

## What the research found

### Twilio answering machine detection (AMD)

**Modes and results**
- `MachineDetection=Enable` returns as soon as it decides: `human`, `machine_start`, `fax` or `unknown`.
- `MachineDetection=DetectMessageEnd` returns `human`, `fax` or `unknown` just as fast. For a machine it waits for the greeting to end (`machine_end_beep`, `machine_end_silence`, `machine_end_other`), so a message lands after the beep.

**Sync versus async**
- **Sync (the default).** Twilio holds the call until AMD decides, then requests the `Url` with `AnsweredBy` in the POST. The person hears silence meanwhile, and Twilio warns that this silence makes people hang up.
- **Async (`AsyncAmd=true`).** The TwiML runs at once. The verdict is POSTed separately to `AsyncAmdStatusCallback` with `CallSid`, `AccountSid`, `AnsweredBy` and `MachineDetectionDuration`.
  - While it listens, async AMD uses one of the call's four forked audio streams.
  - It is available only on Calls API calls.

**Accuracy (Twilio's own claims)**
- `DetectMessageEnd` is close to 100% accurate for US numbers at default settings. `Enable` varies more.
- A very short greeting (about 2 s) can be read as a person.
- People answering mobiles usually speak for under 1.8 s. Machine greetings run over 3 s.
- Long initial silence gives `unknown`. Twilio advises shortening `MachineDetectionSilenceTimeout` for this, not `MachineDetectionTimeout`.

**Speed.** About 4 s on average after answer, at defaults.

**Tuning ranges**

| Parameter | Range | Default |
|---|---|---|
| `MachineDetectionTimeout` | 3–59 s | 30 s |
| `MachineDetectionSpeechThreshold` | 1000–6000 ms | 2400 ms |
| `MachineDetectionSpeechEndThreshold` | 500–5000 ms | 1200 ms |
| `MachineDetectionSilenceTimeout` | 2000–10000 ms | 5000 ms |

**Price.** $0.0075 per call.

**Use with ConversationRelay**
- AMD is set on the Calls API request, not in TwiML, so it works whatever the TwiML is.
- In sync mode, Twilio fetches the ConversationRelay TwiML after the verdict, with `AnsweredBy` in the request.
- In async mode the relay starts at answer. The relay `setup` frame will almost always reach the DO several seconds before the verdict. This is inferred from the 4 s average.
- Twilio's ConversationRelay pages do not mention AMD and document no conflict. The fork-limit warning names Media Streams, SIPREC and Real-Time Transcription, not ConversationRelay.

**Twilio's documented patterns**
- The AMD FAQ recommends async AMD for outbound AI agents.
- Twilio's iOS 26 screening guide combines async AMD with transcript phrase matching.

**Ring timeout (`Timeout`).** The default is 60 s, and Twilio may add 5 s. Twilio suggests about 15 s to hang up before voicemail answers.

### Human-presence gate

**Where the gate can run**
- **`<Gather>` before `<Connect>`.** Twilio collects the key press or speech before any relay exists, then posts it to an `action` URL. That URL must return the `<Connect>` TwiML, so this needs a new signed route and a second TwiML response.
- **Inside ConversationRelay.** `dtmfDetection="true"` is already on, so digits and speech already reach the DO. The DO already does this job for guest PINs.

**Cost**
- DTMF in `<Gather>` has no fee. Speech in `<Gather>` costs $0.02–$0.025 per use.
- Inside the relay there is no fee beyond relay minutes.

**Driving**
- Tesla's Model Y manual lists the in-call controls: volume, mute and end call on the left scroll wheel.
- It mentions no in-call keypad, and it warns about hands-free laws.

**False DTMF**
- Voicemail systems and screeners do not press keys.
- Speech or music can imitate a DTMF digit ("talk-off"). ITU-T Q.24 treats resisting it as a design requirement.
- Accepting a single `1` leaves a small risk.

### iPhone

**Unknown callers**
- **iOS 26 "Screen Unknown Callers"** has three settings (Never, Ask Reason for Calling, Silence) for numbers not saved in Contacts.
  - Ask Reason for Calling answers the call, asks for a name and reason, then rings with the transcript.
  - Silence sends the call to voicemail.
  - Roaming calls are not screened. Calling emergency services turns screening off for 24 h.
- **iOS 18 "Silence Unknown Callers"** still let contacts, recent outgoing calls and Siri Suggestions ring. The iOS 26 pages only mention saved contacts.
- **An unsaved Twilio number counts as unknown.**
- **Mark as Known** (under Call Filtering, Unknown Callers) keeps a number out of the Unknown Callers list. Apple does not say it skips screening.

**Voicemail**
- **Live Voicemail** shows the caller's message as live text and lets you pick up.
  - If the phone is off or has no signal, carrier voicemail answers instead.
  - With Silence on, unknown numbers go straight to Live Voicemail.
  - Calls the carrier flags as spam are declined outright.

**Other features**
- **Hold Assist** is for when you are on hold. It does not affect Jarvis calling Sid.
- **Driving Focus** allows calls while the phone is on car Bluetooth. Other Focus modes can limit calls to chosen people.

**Call Screening meets today's Jarvis**
- The screener's question becomes an owner prompt.
- Jarvis's private answer would appear as text on Sid's screen.
- Apple does not publish the screener's script.

**iOS 27** is reported to ship today (press only). The Apple pages above describe iOS 26.

## Options

The costs below are on top of today's call ($0.0140/min outbound, $0.07/min ConversationRelay). Delays are estimates, except Twilio's ~4 s AMD average.

| | Option | Extra per call | Extra per month (30 calls) | Added delay | Reliability against machines | Friction while driving | Build effort |
|---|---|---|---|---|---|---|---|
| A | Sync AMD only (`DetectMessageEnd`); `unknown` gets the neutral line and a hang-up | $0.0075 | $0.23 | About 3–4 s of silence after answering | High for normal greetings. A very short greeting can pass as a person. Silent answers are dropped. | None, but some real answers are dropped | Small–medium |
| B | Async AMD only; private talk waits for the verdict; `unknown` hangs up | $0.0075 | $0.23 | No silence; private talk starts about 4 s after answer | Same engine as A, plus late or lost callbacks. More `unknown` when the person just listens. | None, but more dropped calls | Medium–large: new callback route, DO waiting state, timer |
| C | Keypad on every call ("press 1") | $0 | $0 | About 5–8 s on every call | Very high: machines do not press keys | High: no documented in-car keypad | Small–medium: DO state like the guest PIN, plus a timer |
| D | Spoken phrase on every call | $0 inside the relay; $0.02–$0.025 with `<Gather>` | $0; $0.60–$0.75 with `<Gather>` | About 4–6 s on every call | High if the phrase never appears in greetings. Road noise can cause re-asks. | Low | Small–medium |
| **E** | **Hybrid: sync AMD, then a phrase or key only on `unknown`** | **$0.0075** | **$0.23** | **About 3–4 s for a person; about 8–12 s when unsure** | **Machines stopped before the relay starts. Unsure calls stopped by the gate. Leftover risk: a very short greeting passing as a person.** | **Low: a phrase only when unsure** | **Medium** |
| F | Hybrid: async AMD, then confirm on `unknown` | $0.0075 | $0.23 | No silence; about 4 s to the verdict; confirmation likely needed more often | Like E, plus a callback race | Low | Large |

Cost notes:
- **Voicemail calls get cheaper with AMD** (A, B, E, F): no relay minutes and no model tokens.
- **Minute rounding (unverified).** Twilio reportedly bills partial minutes as whole minutes. If a few extra seconds push a call into another minute, the worst case is:
  - $0.014 per call when the wait happens before the relay (A, E), or $0.42 a month;
  - $0.084 per call when it happens inside the relay (C, D, F), or $2.52 a month.
- **Machine path voice.** Using a premium voice for the `<Say>` costs under $0.01 per call.

## Recommendation: Option E

Use sync AMD with `MachineDetection=DetectMessageEnd`, decided when Jarvis serves the TwiML. Ask for a short spoken phrase, or keypad `1`, only when the result is neither `human` nor machine/fax.

Reasons:
1. **The decision comes before the conversation exists.** Twilio puts `AnsweredBy` on the signed TwiML request that Jarvis already verifies. A machine never gets `<ConversationRelay>`, so:
   - its greeting is never transcribed;
   - no model runs and no memory is read;
   - there is no second callback to race.
2. **It fits the code.** It needs one field read at an existing verified entry point, and one new pre-auth mode in the DO shaped like the guest PIN state. It adds no public route.
3. **It is cheap.** $0.0075 a call, and voicemail calls get cheaper.
4. **Sid never needs a keypad in the Tesla.** A normal answer needs nothing.
5. **Voicemail gets the neutral sentence intact.** `DetectMessageEnd` waits for the beep, which matches what the foundation spec promised. Twilio rates this mode close to 100% for US numbers.
6. **Silence helps detection.** People say "Hello?" into silence, and that is what AMD needs to return `human`. If Jarvis speaks first (async), a person who just listens more often gets `unknown`. One Stack Overflow report says so; unverified.
7. **E contains D.** If live tests ever show Sid's voicemail passing as a person, one policy flag switches to "always confirm".

Costs of E:
- About 3–4 s of silence when Sid answers. If that bothers him after R1, move to F.
- A long spoken answer from Sid ("Hey Jarvis, I'm driving, what's up") can be read as a machine, and Jarvis hangs up. A short "Hello" avoids this.
- With Call Screening on and Jarvis not saved as a contact, AMD will probably treat the screener as a machine (inference). Jarvis leaves the neutral line and hangs up, and Sid misses the call. Saving the contact prevents this.

**Not fixed by any option here.** If another person answers Sid's phone, Jarvis treats them as Sid. AMD sees a person, and a phrase is not proof of identity. Only a PIN or voice check stops that, and the 2026-08-30 plan removed the owner PIN. Confirm with Sid that he still wants PIN-free outbound calls, knowing this.

**Why not F.** Twilio favours async AMD for AI agents, but for Jarvis it adds:
- a second signed route;
- a DO waiting state and a timer (the DO has none today);
- handling for a late or lost verdict;
- a relay that is already transcribing the greeting while it waits.

The gain is about 3 s less silence.

**Why not C.** There is no documented in-car keypad, and pressing keys on the phone while driving conflicts with hands-free rules.

## iPhone settings for Sid

1. Save Jarvis's Twilio number as a contact named "Jarvis". Your iPhone treats any number not in Contacts as unknown, so screening or silencing would catch Jarvis.
2. Make "Jarvis" a Favorite. If you use Do Not Disturb or Sleep, allow calls from Jarvis there. Apple says Driving Focus allows calls while the phone is on the Tesla's Bluetooth.
3. Keep your normal voicemail greeting. A very short one can fool the machine check.
4. Live Voicemail can stay on. After the fix, voicemail only gets one plain line.
5. When Jarvis calls, answer, say "Hello", and wait a few seconds.
6. Keep Jarvis calling switched off until the fix is built and tested. It is off now.
7. Hold Assist needs no change.
8. iOS 27 is due today. After you update, check these settings are still there.
9. If Jarvis's calls ever stop arriving, tell the builder. Calls a carrier marks as spam are declined.

## Design notes for the builder

### Place the call (`providers/twilio-provider.ts`)
- Add `MachineDetection=DetectMessageEnd` and `MachineDetectionSilenceTimeout=3000`. Keep the other thresholds at their defaults until they are tested on Sid's phone. Twilio's mobile tuning advice (speech 1800–2000 ms, end 1400–1500 ms) is written for predictive dialers.
- Do not send `AsyncAmd`.
- Pin the exact form fields in the `requestBody` tests and in `FakeTwilioProvider.validateInput`.

### Classify at the claim (`voice/outbound.ts`, `claimOutboundTwiML`)
- After the signature check, read `AnsweredBy` as a singleton, the same way as `CallSid`.
- **Exactly `human`:** return today's relay TwiML, initialised with `presence: "amd_human"`.
- **`machine_end_beep`, `machine_end_silence`, `machine_end_other`, `fax`:** return `<Response><Say>` + `OUTBOUND_VOICEMAIL_MESSAGE` + `</Say><Hangup/></Response>`.
  - Do not call `getOrCreateOutboundSession` or `initializeSession`, and issue no relay nonce.
  - Still bind the CallSid, so that the `completed` callback releases the admission slot.
  - Store only the result class, never audio or text.
- **Everything else** (`unknown`, missing, repeated, empty, different case, padded, `machine_start`): return relay TwiML with `presence: "confirmation_required"`. Nothing ever defaults to `human`.
- Twilio's hard 15 s limit on call webhooks still applies.

### Durable Object (`voice/call-session-do.ts`)

**Contract**
- Add `presence` to `OutboundPreAuthenticationContract` and to `PRE_AUTHENTICATION_FIELDS`.
- `snapshotPreAuthentication` must accept exactly two fields, with `presence` limited to its two values.
- `sameInitialization` must compare `presence`.

**Minting** (`#resumeBoundPreAuthentication`, around `:819`–`:839`)
- For an outbound owner, call `mintOwner` only when `presence === "amd_human"`.
- For `confirmation_required`:
  - set the interaction to `owner_presence`;
  - send the neutral line and one fixed prompt;
  - stay in `pre_auth`.
- Inbound owner calls (`preAuthentication === null`) keep minting at once.

**Speech gate** (`#handlePrompt`, `owner_presence`)
- Ignore prompts that are not final.
- Normalise the final text: lower case, strip punctuation, collapse spaces.
- Compare it exactly against a short allow-list, for example "jarvis i'm here" and "jarvis i am here". A match mints; anything else counts as one failure.
- Gate text must never reach `ConversationService`, capacity checks, logs, events or storage.

**Keypad gate** (`#handleDtmf`, `owner_presence`)
- `1` mints. Any other key counts as one failure.

**Budget**
- Two failures, or about 20 s with no match, ends the call.
- This needs a Durable Object alarm that survives hibernation. The alarm must check the phase and the lifecycle generation before acting.

**Phrase choice**
- The phrase must not occur in voicemail or screener scripts. Avoid "hello", "yes", "go ahead", "continue", "available" and "message".
- Consider `hints="Jarvis"` on `<ConversationRelay>`.

**Neutral line for a confirmed person**
- It still plays when AMD returns `human`.
- Its wording is odd for a live listener, but it is a tested constant tied to `neutralGreetingBeforeAuthentication`. Change it only as a separate decision.

### Durable fence (`persistence/voice-access-repository.ts`, `mintOwnerAuthority`)
- Store presence evidence for outbound owner sessions:
  - `amd_human` is written when the claim is served;
  - `speech` or `dtmf` is written in the same batch as the mint.
- Require that evidence in the mint's SQL predicate, the same way guest minting requires activation evidence. A DO bug then cannot mint without it.

### Ending the call
- Send the ConversationRelay `end` message with `handoffData` such as `{"reason":"presence_not_confirmed"}`. Twilio posts it to the `<Connect action>` URL.
- Today that handler returns `204`. Twilio does not document what a 204 from an action URL does. Either return `<Response><Hangup/></Response>` for this case, or prove the 204 behaviour in a live test.
- Do not close the socket to hang up. Twilio marks a call `failed` on an unexpected WebSocket disconnect, which muddies the terminal evidence.

### What a machine hears
- **Machine or fax:** exactly `OUTBOUND_VOICEMAIL_MESSAGE`, once, after the beep, then a hang-up.
- **Unknown:** the same sentence plus the fixed prompt. Both are safe to record.
- **Never:** the `/call` reason, model output, memory, or anything beyond that fixed text.

### R1 evidence

**Current contract**
- `outbound-no-answer` requires `terminalState: "no-answer"`, `callAttempts: 1`, `recipientAuthenticated: false`, `purposeDisclosed: false`, `privateMessageLeft: false` and `statusCallbackSchema: "verified"`.
- These are defined at `tests/acceptance/live/voice-smoke.ts:153` and `:379`.

**Producing a true no-answer**
1. Call Sid's iPhone from an ordinary phone, let it ring unanswered, and time how long before voicemail answers.
2. Set the ring timeout below that time. Allow for Twilio's buffer of up to 5 s, but leave Sid enough time to answer from the Tesla.
3. Run the scenario and let the call ring out.

**New scenario for the real gap**, for example `outbound-voicemail` (schema 1.3, manifest key `outbound_voicemail`)
- Produce it by having Sid decline the call so it goes to voicemail.
- Suggested keys: `answeredByClass: "machine"`, `conversationRelaySessions: 0`, `ownerAuthorityMinted: false`, `modelRequests: 0`, `personalContextReads: 0`, `neutralMessageOnly: true` (the operator plays the voicemail back), `privateMessageLeft: false`, `callAttempts: 1`, `terminalState: "completed"`.

**The `unknown` path**
- Sid answers silently, then confirms with the phrase.
- Either extend `outbound-answer` with a `presenceMode` key, or add a scenario for it.

**Contract rules**
- Both additions change the fixed five-scenario contract and the release manifest's required-evidence list (`docs/superpowers/plans/2026-08-29-jarvis-telegram-memory-release.md`). They need review and Sid's sign-off.
- `pinPromptCount: 0` stays true. Name the new counters `presencePrompt*` so a presence prompt is never mistaken for a PIN prompt.
- Deploy the fix before any live outbound scenario runs.
- Also test live in the Tesla: road noise, cabin echo, and answering from the touchscreen.

### Guards to mutation-test

Each row is a guard, and each mutation listed must make a test fail.

| # | Guard | Mutations that must fail a test |
|---|---|---|
| 1 | `requestBody` AMD fields | Drop `MachineDetection`; change it to `Enable`; add `AsyncAmd` |
| 2 | `claimOutboundTwiML` `AnsweredBy` check | Loosen `=== "human"` (includes, case-insensitive, trim); remove the singleton check; treat missing as `human`; flip the default branch |
| 3 | Machine TwiML | Add `<Connect>`, `ConversationRelay` or a nonce; change the sentence; drop `<Hangup/>` |
| 4 | Machine branch side effects | Call `getOrCreateOutboundSession` or `initializeSession`; skip the CallSid bind so the slot never frees |
| 5 | `snapshotPreAuthentication` and `sameInitialization` | Accept a missing or extra `presence`; drop the `presence` comparison |
| 6 | `#resumeBoundPreAuthentication` | Remove the `amd_human` condition; mint on `confirmation_required` |
| 7 | `#handlePrompt` gate | Accept a non-final prompt; use substring matching; pass gate text to the conversation or capacity check; log it |
| 8 | `#handleDtmf` gate | Accept any digit; stop counting failures |
| 9 | Budget and alarm | Off-by-one on failures; alarm acts after a terminal phase or on a newer generation; a mint after timeout |
| 10 | `mintOwnerAuthority` | Remove the presence predicate from the SQL |
| 11 | Inbound owner regression | Inbound owner stops minting with zero prompts |
| 12 | Evidence validator | Accept unknown keys; accept `ownerAuthorityMinted !== false`; accept `modelRequests !== 0` |

Fakes cannot show whether AMD is accurate. Only live calls to Sid's phone can.

## Sources

**Verified** means read in this session, with the claim matching the page. **Unverified** means press or third-party material, a search summary only, a page that would not load, or my own inference.

### Twilio
- **[verified]** Answering Machine Detection guide: https://www.twilio.com/docs/voice/answering-machine-detection
  - Parameters and ranges, `AnsweredBy` values.
  - Sync mode delivers `AnsweredBy` to the `Url` webhook; async uses a forked stream.
- **[verified]** AMD FAQ and best practices: https://www.twilio.com/docs/voice/answering-machine-detection-faq-best-practices
  - ~4 s average; sync silence; `DetectMessageEnd` near 100% in the US.
  - Short greetings can read as a person; async is Calls API only; async pattern for AI agents; tuning advice.
- **[verified]** Call resource: https://www.twilio.com/docs/voice/api/call-resource
  - `Timeout` default 60 s, 5 s buffer, 15 s advice to avoid voicemail; `MachineDetection`; `AsyncAmd`.
  - Read through a summarising fetch that quoted the text.
- **[verified]** US Voice pricing, read 2026-09-14: https://www.twilio.com/en-us/voice/pricing/us
  - $0.0140/min outbound, $0.0075/call AMD, $0.07/min ConversationRelay.
  - $0.02–$0.025 per Gather speech use; premium TTS rates.
- **[verified]** `<ConversationRelay>` TwiML: https://www.twilio.com/docs/voice/twiml/connect/conversationrelay
  - `dtmfDetection`, `interruptible`, `reportInputDuringAgentSpeech`, `hints`, action callback with `HandoffData`; no AMD attribute.
- **[verified]** ConversationRelay WebSocket messages: https://www.twilio.com/docs/voice/conversationrelay/websocket-messages
  - The `end` message with `handoffData`; an unexpected disconnect fails the call.
- **[verified]** `<Gather>`: https://www.twilio.com/docs/voice/twiml/gather
  - `input` can be `dtmf`, `speech` or both; default `timeout` is 5; `action` behaviour.
- **[verified]** `<Connect>`: https://www.twilio.com/docs/voice/twiml/connect
  - Action URL requested when `<Connect>` ends; with no action and no further verb, the call ends.
  - What a 204 from the action URL does is not documented (unverified).
- **[verified]** Webhook connection overrides: https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides
  - Apply to product webhooks; 15 s hard cap on call-related requests.
- **[verified]** Twilio blog, detecting iOS 26 Call Screening, 2025-11-03: https://www.twilio.com/en-us/blog/developers/tutorials/product/detect-ios-call-screening-amd-transcriptions
  - Async AMD plus transcript phrase matching; describes the screener preamble only approximately.
- **[verified]** Twilio blog, async AMD tutorial, 2021: https://www.twilio.com/en-us/blog/async-answering-machine-detection-tutorial
  - The async result arrives separately; the call must be updated by API.
- **[unverified]** Twilio Help Center, minute rounding: https://help.twilio.com/articles/223132307
  - The page did not render. "Partial minutes round up" comes from a search summary only.

### Apple
- **[verified]** Manage unknown callers on iPhone, 2025-12-19: https://support.apple.com/en-us/111106
- **[verified]** iPhone User Guide, Screen and block calls (iOS 26, includes Mark as Known): https://support.apple.com/guide/iphone/screen-and-block-calls-iphe4b3f7823/ios
- **[verified]** iPhone User Guide, iOS 18 version of the same page (Silence Unknown Callers exceptions): https://support.apple.com/guide/iphone/iphe4b3f7823/18.0/ios/18.0
- **[verified]** Live Voicemail (live text, carrier voicemail when the phone is off, spam declined): https://support.apple.com/guide/iphone/set-up-voicemail-iph3c99490e/ios
  - Read from search highlights of the Apple page.
- **[verified]** Hold Assist: https://support.apple.com/guide/iphone/while-on-a-call-iph3c9951d7/ios
- **[verified]** Driving Focus (calls allowed on car Bluetooth): https://support.apple.com/en-us/108384
- **[verified]** Focus people and call options: https://support.apple.com/guide/iphone/allow-or-silence-notifications-for-a-focus-iph21d43af5b/ios
  - Read from search highlights.
- **[unverified]** Screener wording (asks the caller to record their name and reason for calling):
  - How-To Geek, 2025-06-17: https://www.howtogeek.com/how-ios-26-will-kill-spam-calls-and-messages/
  - Regal developer docs: https://developer.regal.ai/docs/navigate-ios-call-screening
  - Apple does not publish the script.
- **[unverified]** iOS 27 release on 2026-09-14:
  - MacRumors, 2026-09-13: https://www.macrumors.com/2026/09/13/ios-27-release-date-new-features/
  - 9to5Mac, 2026-09-09: https://9to5mac.com/2026/09/09/ios-27-here-are-apples-full-release-notes/

### Other
- **[verified]** Tesla Model Y Owner's Manual, Phone (tesla.cn mirror): https://www.tesla.cn/ownersmanual/modely/en_in/GUID-68582EA9-CBE5-4474-880E-3EF4992002DF.html
  - In-call controls are volume, mute and end call only; no keypad mentioned.
  - The tesla.com US page blocked automated fetching. Whether the touchscreen shows a keypad during a call is unverified.
- **[verified]** ITU-T Q.24 (speech can imitate DTMF digits): https://www.itu.int/rec/dologin_pub.asp?id=T-REC-Q.24-198811-I%21%21PDF-E&lang=e&type=items
- **[unverified]** Stack Overflow 69922540 (async AMD returned `unknown` when the callee listened silently): https://stackoverflow.com/questions/69922540
- **[unverified, inference]** Claims to prove in the live smoke:
  - AMD classifies iPhone Live Voicemail and Apple's screener as a machine.
  - A voicemail beep is not detected as DTMF `1`.
  - Cabin echo in the Tesla does not trigger a false confirmation.
  - Sid's voicemail answers in under 35 s.
