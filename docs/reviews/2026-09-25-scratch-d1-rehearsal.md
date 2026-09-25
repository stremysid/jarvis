# Scratch D1 rehearsal — 2026-09-25

**Result: PASS.** Every pending migration applied cleanly, in number order, on a copy of
production's current state. Both sets passed: main's six, and the seven if
[#199](https://github.com/stremysid/jarvis/pull/199) lands. The scratch database is deleted.

Authority: Sid, 2026-09-25 4:20 PM EDT, answering the orchestrator's question pop-up:
"Yes, rehearse first". That authorized a throwaway D1 database in his account,
deleted afterwards. Production was only read, with `SELECT`, `PRAGMA table_info` and
`PRAGMA foreign_key_check`. Nothing was applied to production or deployed, and no
secret was touched.

Run by a Claude Code subagent (Opus 5.5) of the orchestrator session, on Sid's PC
with his logged-in Wrangler 4.127.1, between 4:19 and 4:30 PM EDT.

## Inputs

| Item | Value |
|---|---|
| Main | `f43fcf42` |
| #199 branch | `codex/five-action-gates` at `1086105b`. It later moved to `cc7903a9` (docs only), and `0051` is byte-identical at both heads |
| Production `d1_migrations` | 40 rows: `0001`–`0035`, `0038`, `0039`, `0040`, `0043`, `0045`. Newest is `0045`, applied 2026-09-25 01:40:49 UTC. `0036`, `0037`, `0041`, `0042`, `0044` and `0046` are absent |
| Scratch database | `jarvis-scratch-rehearsal-20260925`, region ENAM |

File sha256 prefixes: `0044` `461920468ea3`, `0047` `c133d4b1bf32`, `0048` `e23b87bd0a53`,
`0049` `034074674628`, `0050` `5a6b5ac9b22d`, `0051` `3f8d82b18270`, `0052` `217e83065ad5`.

## Method

1. **`wrangler d1 export` cannot copy production.** It refuses with
   `D1 Export error: cannot export databases with Virtual Tables (fts5)`, because production
   has four FTS5 tables. The export had not started, so production was not blocked.
2. **Read-only copy instead.** From production the run read `sqlite_master` (862 objects),
   `PRAGMA table_info` for each of the 138 ordinary tables, and every row as a
   `quote()`-built `INSERT` (9,215 rows).
3. **Imported into scratch with `wrangler d1 execute --file`**, in this order: tables,
   then rows in foreign-key order, then the FTS5 tables with `'rebuild'`, then indexes
   and views, then triggers.
   - The first attempt was one file with `PRAGMA defer_foreign_keys`. It failed
     (`{"D1_RESET_DO":true}`) and D1 rolled it back.
   - Split into parts, it failed again, this time with `FOREIGN KEY constraint failed`:
     the import does not honour deferral.
   - Ordering the rows by foreign-key dependency fixed it.
   - Production's five old `SELECT CASE … RAISE` triggers from `0001`/`0002`/`0006`
     were imported **verbatim** and were accepted through the import path.
4. **Copy verified against production:**
   - `sqlite_master` is identical: same 862 objects with the same type, name, table and SQL text.
   - Every table's row count is identical, and so is `sqlite_sequence`.
   - `d1_migrations` is identical: all 40 rows, including `applied_at`.
   - `PRAGMA foreign_key_check` is empty on both, and all four FTS5 `integrity-check`s pass.
   - The only difference is the FTS5 `_data`/`_idx` shadow row counts, because a rebuild
     compacts segments. The `_docsize` counts match.
   - A Time Travel bookmark of this baseline was taken.
5. **Same mechanism as tonight.** `node wrangler.js d1 migrations apply <db> --remote --config <cfg>`,
   the deploy runbook's step 3. Only the database name and config differ. The config
   is a scratch-only TOML outside the repository, because Wrangler ignores
   `migrations_dir` for a database the config doesn't declare. Its `migrations_dir`
   is a staging folder holding byte copies of main's 40 applied files. Pending files
   were added one at a time. After each apply the run checked:
   - `migrations list` says "No migrations to apply";
   - `foreign_key_check`;
   - the full `sqlite_master` diff;
   - every table's row count against the previous step.
6. **Four passes from the same baseline**, with a Time Travel restore to the baseline
   bookmark between them. Each restore was verified identical to the baseline.
   - A: main's six, one file at a time.
   - B: all seven with `0051`, one file at a time.
   - A1: main's six in **one** `apply`, the exact shape of tonight's command.
   - B1: all seven in one `apply`.

## Per-migration results (passes A and B)

Row counts of existing tables were unchanged at every step, except the rows each
migration is meant to add. Every step had no foreign-key violations and nothing left pending.

| Migration | Result | Schema change observed | Row changes |
|---|---|---|---|
| `0044_owner_channel_parity` | PASS (A, B) | 19 triggers rewritten; all 19 now carry `channel IN ('telegram', 'voice')`; nothing added or removed | none |
| `0047_call_pin_and_owner_authority` | PASS (A, B) | `call_session_authorities_require_current_lineage` rewritten, with no step-up or waiver reference left; `sensitive_action_pin_attempts` + index + 2 guards added | none |
| `0048_note_sources_without_markdown_citation` | PASS (A, B) | `memory_topic_note_sources_insert_guard` rewritten, with no Markdown or `instr(` clause left | none |
| `0049_web_tools` | PASS (A, B) | `web_tool_receipts` + index + 2 guards | `capability_tiers` +1 (`read.web`, tier 1) |
| `0050_owner_reminders` | PASS (A, B) | `owner_reminders` + index + owner-turn trigger | none |
| `0051_confirm_only_five_actions` (#199) | PASS (B) | none | `capability_tiers` +3; 5 updated as intended |
| `0052_email_inbox` | PASS (A after `0050`; B after `0051`) | `email_inbox` + index + 3 guards | `capability_tiers` +1 (`email.read`, tier 1) |

**`0051` result.** Tier 3 is exactly `contact.third_party`, `place.call`, `send.email`,
`spend.money`, `submit.school_work`.
- `school.collector.revoke` moved 3→1.
- `delete.data`, `write.production` and `vehicle.unlock` moved 3→2.
- `contact.third_party` was reworded.

`autonomy_mode` is unchanged: `live`, with the same `entered_at` and `updated_at`.
Without `0051`, tier 3 stays as production has it today:
`contact.third_party`, `delete.data`, `school.collector.revoke`, `spend.money`, `vehicle.unlock`, `write.production`.

**One-shot passes.** A1 and B1 each exited 0 and applied every file ✅ in number order.
Each final schema and set of row counts was identical to its one-file-at-a-time pass.
B1's `d1_migrations` ends `…45:0050, 46:0051, 47:0052`.

Each single-file `apply` took about 1.3–1.9 s of wall time, mostly Wrangler round trips.

## Limits

- **Point-in-time copy.** The copy is production at about 4:20 PM EDT. Rows written
  after that were not rehearsed. The pending files only replace triggers and create
  tables, and `0049`/`0051`/`0052` touch only `capability_tiers`, so row volume is not
  the risk. Recheck `migrations list` right before tonight's apply regardless.
- **FTS5 index copied by rebuild.** The index was rebuilt rather than copied byte for
  byte; no pending migration touches FTS.
- **No behaviour tested.** No trigger was exercised with good and bad writes; this
  rehearsal proves application and integrity only.
- **Scratch-only proof.** It does not authorize the production apply or the deploy.
  Those remain Sid's, per [OWNER-ACTIONS](../OWNER-ACTIONS.md).

## Cleanup

- `jarvis-scratch-rehearsal-20260925` was deleted with `wrangler d1 delete`. The
  following `wrangler d1 list` shows only `jarvis` and an unrelated staging database.
- A read-only check after the run confirmed production `d1_migrations` still has 40
  rows, newest `0045_school_collector_hosts.sql`.
- The local copy of production rows was deleted from the orchestrator's scratch directory.
