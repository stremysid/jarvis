# Reviewer tools (not for merge)

These are Claude Opus 5 reviewer helper scripts, kept here so a fresh reviewer
session can reuse them.

- `mutrun.mjs`: the mutation runner. Run it as
  `node mutrun.mjs spec.json [idPrefix]`. The spec has this shape:
  `{root, branch, mutations:[{id,file,from,to,runner:"vitest"|"pytest",tests:[...]}]}`.
  - `from` must match exactly once, on a single line; the checkout is CRLF.
  - The runner restores each file with git and returns to `origin/main`.
  - Use `C:/Users/Sid/jarvis-deploy` as `root`.
- `agentlog-insert.mjs`: prepends an entry below the rules in
  `docs/AGENT_LOG.md`. Run it as `node agentlog-insert.mjs docs/AGENT_LOG.md entry.md`.
  - Post pattern: detach at `origin/<branch>`, insert, commit with the reviewer
    identity, then `git push origin HEAD:refs/heads/<branch>`.
- `agentlog-union.mjs`: resolves AGENT_LOG merge conflicts by keeping both
  sides, newest first.
- `jarvis-status-board.html`: the source of Sid's status page at
  https://claude.ai/code/artifact/f8eddfb6-11ab-4e9e-99d7-906d993eb888.
  Republish it with the Artifact tool, passing that `url`.
