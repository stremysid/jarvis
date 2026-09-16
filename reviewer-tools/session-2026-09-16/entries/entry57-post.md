## 2026-09-16 01:38 UTC — Claude Opus 5, PR #57 max review at a9f2532: cleared

The seventh scenario is right, both of my PR #54 follow-ups are closed, and every rule it adds is proven load-bearing. Merging this.

**Local checks at a9f2532** (Windows 11, `jarvis-pr39`): lint, typecheck and `typecheck:voice-access` pass. `pnpm test` **3,448/3,448**, `test:voice-smoke` **92/92**, `test:voice-access` **903/903** plus the 6 release-gate tests, all with 0 timeouts. No migration in this PR. Branch is on current main `282f066`.

**My mutation pass (`reviewer-tools/pr57/mut57.json` + `mut57b.json`, `run57.txt` + `run57b.txt`): 11 of 11 killed**, BASE clean, 0 timeouts.

**Follow-up 1 from PR #54 is properly closed.** The two survivors that were mutually redundant are now each pinned, and so is the pair:
- `W2-audit-inbound-verified`: **KILLED** by "requires the release audit's inbound record to have a verified outcome" and "rejects the mixed-policy set…".
- `W15a-not-started-direction-only`: **KILLED** by "refuses an inbound record whose owner step-up outcome is not_started".
- **`W2+W15a-together`: KILLED** — deleting both at once now fails three named tests, where at `67b99dd` it left all 68 passing. That was the actual hole and it is shut.
- The refactor that made this possible is sound. `validateInbound` now passes `ownerStepUpOutcome !== "not_started"` instead of a hard `true`, so an inbound `not_started` record reaches the branch that refuses it by direction rather than dying earlier on the authority mismatch; an inbound record claiming authority with `not_started` still fails the mismatch. The audit's `passphrase_always` check now skips inbound, and the requirement moved into the verified branch as `direction === "inbound" && policy !== "passphrase_always"` — **`N1` and `N2` are both KILLED**, so neither half rests on the other. The waiver stays unreachable for inbound because the audit still requires a verified inbound outcome.

**The scenario proves what Sid asked for.** Every privacy rule in `validateOutboundStepUpRefused` dies to its own named test:
- `S1-recipient-answered`: **KILLED** — the record must show the call was actually answered, which is what separates this from `outbound-no-answer`.
- `S2-recipient-not-authenticated`: **KILLED**.
- `S3-neutral-greeting`: **KILLED** — only the neutral line before authentication.
- `S4-purpose-not-disclosed`: **KILLED** — Jarvis never says why it called.
- `S5-no-private-message-left`: **KILLED** — nothing private is left on the recording.
- `S6-outbound-direction`: **KILLED** by four tests, so the shared `validateRefusedOwnerStepUp` cannot be pointed at the wrong direction.
The outcome choice is right and the reasoning is recorded: `refused` because step-up started and failed, with `not_started` kept exclusive to an outbound call nobody answered — which is exactly the distinction PR #54's S1 guard depends on.

**Follow-up 2 is done.** `reviewer-tools/` no longer exists anywhere in the product tree; the mutation spec and runner now live at `tests/acceptance/live/evidence-mutations/`, which is where test tooling belongs, and the path inside the runner was updated with them.

**The decision is recorded accurately.** `DECISIONS.md` names Sid's 2026-09-16 approval, the roughly one-cent cost, what the scenario must prove, and states plainly that it authorizes no call, no inbound opening, no deploy and no secret change. `KNOWN_ISSUES.md` drops from three deferred limits to two and no longer says the scenario waits on him. `NEXT_STEPS.md`, `docs/HANDOFF.md` and `docs/runbooks/voice-smoke.md` all move from a six-record to a seven-record contract.

**Merging** at `a9f2532` plus my entry, per Sid's delegation, and verifying main afterwards. Merging turns nothing on: Twilio is still unconfigured, outbound dispatch disabled, inbound closed, no call placed. **The live smoke now costs seven paid scenarios instead of six, and it is still entirely Sid-attended.**

**Where R1 stands after this:** there is no calling code work left for v1.0. What remains is the owner sequence — Twilio configuration, the device-key replacement, phone enrollment, then the seven live scenarios.

— Claude Opus 5
