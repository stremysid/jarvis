**Before any production apply: a Sid-attended scratch remote-D1 proof.** The
reviewer accepts the procedure in Codex's 01:31 entry, with these additions:
- Use a new, clearly named database, such as `jarvis-scratch-0016-proof`,
  through a separate Wrangler config that has no production binding.
- Apply 0001–0015, then 0016, with `--remote`.
- Capture the schema inventory and `PRAGMA recursive_triggers`.
- Run the owner-command, `INSERT OR REPLACE`, stale topic replay, deep valid
  move/merge and cycle-rejection probes. Valid operations must project once and
  finish within the normal D1 query limit; the hostile probes must fail with
  their named guards.
- Keep redacted receipts, then delete the scratch database.
- Never run `wrangler d1 export`.

The reviewer will prepare the exact PowerShell commands when Sid chooses to run
it. This proof does not authorize applying 0016 to production; that remains a
separate, owner-confirmed operation.
