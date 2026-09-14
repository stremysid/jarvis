# Generate or rotate the owner call passphrase

This runbook describes R1 implementation PR 1. It does not authorize a
migration, secret change, deployment, or live call. Owner-call step-up is not
complete until the later call-session PR passes review and an attended spoken
verification succeeds.

## What is stored

The Worker selects three independent words with replacement from the fixed
2,048-word `eff-long-cmudict-2026-09-v1` list. D1 stores only the versioned
HMAC-plus-PBKDF2 verifier, its 16-byte salt, the creating device-key binding,
and an immutable rotation receipt. It never stores the words. A signed status
request returns only the active verifier version. A successful generation
response returns the words once.

The source list is derived from EFF's 2016 large Diceware list, then filtered
with CMUdict commit `74790861f652b15e4ac49015a90074ad62a27690`. The checked-in
list's newline-delimited SHA-256 is
`9cf5c60c950729d2a8e8b17031f0e57e0db0e604184a87ab6fa2c0c37884ceed`.
The selection removes number words, internal homophones and alternate
pronunciations, Canadian/American spelling pairs, reviewed manual exclusions,
compounds detectable as two CMUdict words, punctuation, and words outside four
to eight ASCII letters.

## Reviewed rollout sequence

1. Confirm the implementation commit has passed Claude max review. Confirm R2's
   reserved migration `0016` and this PR's `0017_owner_passphrase.sql` are both
   present in the intended deployment revision. List remote migrations before
   applying any of them.
2. From a protected PowerShell session with transcription off, create a random
   32-byte value, base64-encode it, and enter it through Wrangler's interactive
   `secret put OWNER_PASSPHRASE_PEPPER_V1` prompt. Never put the value in a
   command argument, file, test, log, or chat.
3. Apply reviewed pending migrations only after the owner confirms the remote
   inventory and recovery point. Deploy the reviewed Worker revision. These are
   separate owner-confirmed operations under `deploy.md`.
4. On the enrolled Windows 11 home PC, in an attended terminal, run:

   ```powershell
   jarvis owner-passphrase status
   jarvis owner-passphrase generate
   ```

   The generate command reads the current version, asks for confirmation, and
   sends the expected version in its signed request. D1 rejects a concurrent or
   stale rotation. Save the one displayed phrase in the owner's password
   manager, then close the terminal.
5. If the response is lost or the phrase was not retained, run `generate`
   again. The status request recovers the committed version and the next signed
   request creates a newer verifier. There is no endpoint that reads old words.
6. Keep inbound calling closed. The later call-step-up PR must ship and the new
   phrase must pass one attended ordinary voice verification before inbound is
   reopened.

`jarvis owner-passphrase status` prints only a version or “not configured.” A
device mismatch, clock problem, unavailable gateway, and CAS conflict use fixed
messages that contain no phrase or verifier material.
