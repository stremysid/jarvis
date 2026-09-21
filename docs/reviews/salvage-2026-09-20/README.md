# Salvaged audit — 2026-09-20

**Read this before trusting anything in this directory.**

This is the raw output of a full-coverage audit that was **killed mid-run**, preserved here
because it was sitting on a scratch path (`C:\w\audit\SALVAGED\`) that a cleanup would have
taken with it. It is evidence, not a report.

## What the audit was

- Audited `ca88bf4`. Killed at peak hours on Sid's instruction, 01:18 local.
- **Coverage is partial: two of about seven planned batches.**

| Batch | Area | Status |
|---|---|---|
| W1 | `memory` + `persistence` | **complete** |
| W2 | `voice` + `channels` + `conversation` + `autonomy` + `security` + `sync` + `http` | **complete** |
| W3 | `school`/`university`/`jobs`/`archive`/`backup`/`model`/`providers`/`index` | never ran |
| W4 | `local-agent`, `contracts`, `scripts`, watchdog, hermes | never ran |

- Counts as declared by the run: **31 findings** — 9 `roadmap-violation`, 7 `mislead`,
  2 `spend`, 2 `time`, remainder informational.
- **Nothing was verified by mutation.** These are findings, not convictions.
- No coverage manifest survived: the parent was killed before assembling it, so there is **no
  file-by-file record of what was read**. A "clean" verdict on a file therefore means only that
  one agent read it and reported nothing.

## The truncation, stated exactly

**`findings.json.txt` is truncated and is not the complete per-finding record.** Measured:

- It declares **31** `"title"` and **31** `"severity"` entries, across **14** `"path"` file
  entries — the structure of all 31 findings is present, including every title.
- It contains **2** `[truncated: N more characters]` markers, at byte offsets **50081** and
  **100203**. The second is the end of the file.
- The per-batch workflow outputs under the original `SALVAGED\session-*\` directories are each
  about **50 KB**, which is what the two markers look like: a **per-batch result cap**, not
  damage to one file.

**Consequence:** for findings in the truncated spans, the title survives but the
`mechanism` / `what_it_breaks` / `fix` / `falsifier` text does not. Do not cite a mechanism from
this file for those findings without re-deriving it from the code. The per-batch session
directories were **not** recovered into this repository — only the two files here were.

## What is already extracted and verified elsewhere

The nine `roadmap-violation` findings are **not** left to this file. They were re-verified
against the code and written up as a worklist in
[`docs/CODE-VS-JUDGMENT.md`](../CODE-VS-JUDGMENT.md), which is the file to read for those. That
page also records one correction: the finding this salvage labels *"`MemoryRepository.liftItem`
silently rewrites basis"* is **mislabelled** — the real code-owned decision is at
`:2328-2331`, not the lifecycle state.

The audit's own **item 1** — that `memory_pin` / `memory_unpin` could not work at all — was
confirmed by reading the code and has since been **fixed by #135**, which corrected
`findControlTargets` against a test derived from the declared union. **It is not an open item.**
What survives, and is the part worth keeping, is *why* it hid: three test files stub that finder
without looking at the operation, and they still do. See `docs/CODE-VS-JUDGMENT.md`.

**Read every mechanism here against current code before acting on it.** The audit read `ca88bf4`,
which is no longer `main`; `#133` regenerated the state carriers and `#135` fixed the very guard
that item 1 concerns. Where this file and the code disagree, **the code wins.**

## Files

| File | What it is |
|---|---|
| `findings.json.txt` | Both completed batches. All 31 findings; **truncated** as described above |
| `REPORT.md` | The run's own 31-finding summary and its coverage table |

The surviving `C:\w\audit\SALVAGED\` directory also holds `parent-reasoning.log` (50 KB) and 20
`session-*` directories of per-agent tool output. Those were **not** copied here. If the
`mechanism` text for a truncated finding turns out to matter, that directory is the place to
look — and it is a scratch path, so it should be copied rather than relied on.
