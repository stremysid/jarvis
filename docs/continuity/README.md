# Session ledgers

A running record of what each working session did, decided, tried and
rejected — the reasoning behind the code, kept next to it.

These normally live outside the repository, at
`~/.claude/continuity/tasks/`. Sid explicitly asked for them here instead.
The repository is private.

## The rule these follow

**No credential values, ever.** Not a token, not a PIN, not a pepper, not a
key fingerprint, not raw sensitive command output. A ledger records only
*which* secrets exist and *which* need rotating. That rule holds whether the
file is in the repository or not.

## How to read one

A ledger is a checkpoint, not scripture. When resuming, verify its claims
against the current files, Git state, specs and tests. **Current evidence
wins.** These describe what was true when written; paths, constants and
counts inside them move.

The durable records are elsewhere and are what a ledger defers to:

| For | Read |
|---|---|
| Decisions and why | [DECISIONS.md](../../DECISIONS.md) |
| What is weaker than it looks | [KNOWN_ISSUES.md](../../KNOWN_ISSUES.md) |
| What to do next | [QUEUE.md](../QUEUE.md) |
| Current state | [STATE.md](../STATE.md) |

## Ledgers

| Date | Session |
|---|---|
| 2026-09-02 / 03 | [Finish the Jarvis project](2026-09-03-jarvis-finish-the-project.md) |
