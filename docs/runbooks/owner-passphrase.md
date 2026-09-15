# Generate or rotate the owner call passphrase

This runbook describes R1 implementation PR 1. It does not authorize a
migration, secret change, deployment, or live call. Owner-call step-up is not
complete until the later call-session PR passes review and an attended spoken
verification succeeds.

## What is stored

The Worker selects three independent words with replacement from the fixed
2,048-word `eff-long-cmudict-2026-09-v2` list. D1 stores only the versioned
HMAC-plus-PBKDF2 verifier, its 16-byte salt, the creating device-key binding,
and an immutable rotation receipt. It never stores the words. A signed status
request returns only the current verifier version and whether it is active or
disabled. A successful generation response returns the words once.

Migration `0017` also reserves PR 3's guarded recovery path. An immutable
disable receipt must cite the exact accepted, confirmed owner Telegram event;
its trigger revokes the active verifier and disables the head atomically. The
same verifier cannot be restored. Re-enable requires this signed Windows CLI
to publish a new verifier version, which supersedes the revoked record and
moves the head back to active. This PR does not expose the Telegram disable
command.

The source list is derived from EFF's 2016 large Diceware list, then filtered
with CMUdict commit `74790861f652b15e4ac49015a90074ad62a27690`. The checked-in
list's newline-delimited SHA-256 is
`52cfd230e93567f01b90c059f7e400d915f23b558ce1a28f0bfc4dc0c9ba1cc4`.
The selection removes number words; the reviewed speech variants `okay`,
`alright`, `awhile`, `online`, `hangup`, `maybe`, and `twice`; non-US spelling
variants; reviewed manual exclusions; compounds detectable as two CMUdict
entries of at least two letters; punctuation; and words outside four to eight
ASCII letters. Hash-ranked greedy selection ensures that no two retained words
share a CMUdict pronunciation.

## Reviewed rollout sequence

1. Confirm the implementation commit has passed Claude max review. List remote
   migrations and apply exactly the reviewed pending files. Wrangler tracks
   migration names rather than enforcing numeric continuity, so this PR's
   `0017_owner_passphrase.sql` can be applied before R2's reserved `0016`; if
   `0016` lands later, it remains unapplied and is applied then.
   Before `0018_owner_call_step_up.sql` is ever applied, Sid must also run its
   attended syntax proof against a pre-created non-production scratch D1. The
   proof must create a `STRICT, WITHOUT ROWID` table and a `BEFORE INSERT`
   trigger whose `WHEN` combines two `EXISTS` clauses with `OR`, confirm the
   duplicate insert raises, and then remove the probe objects. This tests the
   two remote-D1 forms newly relied on by `0018`; a local SQLite pass is not a
   substitute. Record the scratch command, failure text, and cleanup result in
   the rollout evidence before applying any production migration.

   In **PowerShell 7**, from the repository root, use the scratch D1 database
   name Sid has already created:

   ```powershell
   Set-Location C:\path\to\jarvis
   $ScratchDatabase = Read-Host "Non-production scratch D1 database name"
   $SetupSql = "DROP TRIGGER IF EXISTS pr40_guard_probe_insert; DROP TABLE IF EXISTS pr40_guard_probe; CREATE TABLE pr40_guard_probe (id TEXT PRIMARY KEY, alternate TEXT NOT NULL UNIQUE) STRICT, WITHOUT ROWID; CREATE TRIGGER pr40_guard_probe_insert BEFORE INSERT ON pr40_guard_probe WHEN EXISTS (SELECT 1 FROM pr40_guard_probe WHERE id = NEW.id) OR EXISTS (SELECT 1 FROM pr40_guard_probe WHERE alternate = NEW.alternate) BEGIN SELECT RAISE(ABORT, 'pr40_guard_probe_rejected'); END; INSERT INTO pr40_guard_probe (id, alternate) VALUES ('first', 'one');"
   pnpm.cmd exec wrangler d1 execute $ScratchDatabase --remote --command $SetupSql
   if ($LASTEXITCODE -ne 0) { throw "Scratch D1 setup failed." }

   $FirstGuard = & pnpm.cmd exec wrangler d1 execute $ScratchDatabase --remote --command "INSERT INTO pr40_guard_probe (id, alternate) VALUES ('first', 'two');" 2>&1
   if ($LASTEXITCODE -eq 0 -or ($FirstGuard -join "`n") -notmatch "pr40_guard_probe_rejected") { throw "Scratch D1 existing-key guard was not proven." }
   $SecondGuard = & pnpm.cmd exec wrangler d1 execute $ScratchDatabase --remote --command "INSERT INTO pr40_guard_probe (id, alternate) VALUES ('second', 'one');" 2>&1
   if ($LASTEXITCODE -eq 0 -or ($SecondGuard -join "`n") -notmatch "pr40_guard_probe_rejected") { throw "Scratch D1 alternate-key guard was not proven." }

   pnpm.cmd exec wrangler d1 execute $ScratchDatabase --remote --command "DROP TRIGGER pr40_guard_probe_insert; DROP TABLE pr40_guard_probe;"
   if ($LASTEXITCODE -ne 0) { throw "Scratch D1 cleanup failed." }
   ```
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

`jarvis owner-passphrase status` prints only a version and state, or “not
configured.” A disabled status names its current version so `generate` can
compare-and-swap to a new one. A device mismatch, configured-owner mismatch,
clock problem, unavailable gateway, and CAS conflict use fixed messages that
contain no phrase or verifier material.
