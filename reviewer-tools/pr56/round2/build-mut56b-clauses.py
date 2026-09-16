import io, json, os

base = r"C:\Users\Sid\AppData\Local\Temp\claude\C--javis--claude-worktrees-jarvis-code-review-0b1695\491bafd5-6943-47ba-ac70-7a2ebe575839\scratchpad"
out = os.path.join(base, "pr56", "round2", "mut56b-clauses.json")
SQL = "apps/cloud-gateway/src/persistence/migrations/0025_archive_literal_history.sql"
SRC = "apps/cloud-gateway/src/memory/memory-owner-controls.ts"
CONTRACT = "packages/contracts/src/calls.ts"
T = ["apps/cloud-gateway/test/persistence/archive-literal-history-migration.test.ts",
     "apps/cloud-gateway/test/memory/literal-history.test.ts",
     "apps/cloud-gateway/test/memory/memory-repository.test.ts",
     "apps/cloud-gateway/test/memory/memory-owner-controls.test.ts"]
TC = ["packages/contracts/test/envelope.test.ts"]

PRINCIPAL = ("  OR NOT EXISTS (\n"
             "    SELECT 1 FROM principals principal\n"
             "    WHERE principal.principal_id = NEW.principal_id\n"
             "      AND principal.principal_type = 'human'\n"
             "      AND principal.status = 'active'\n"
             "  )\n")

spec = {
 "root": "C:/Users/Sid/jarvis-pr39",
 "branch": "0279396",
 "mutations": [
  {"id": "BASE", "file": SQL,
   "from": "  OR NEW.checkpoint_event_sequence - OLD.checkpoint_event_sequence > 8\n",
   "to": "  OR NEW.checkpoint_event_sequence - OLD.checkpoint_event_sequence > 8\n", "tests": T},
  # M1 — the per-step ceiling that makes a forged one-statement completion impossible.
  {"id": "M1-step-ceiling", "file": SQL,
   "from": "  -- The service can examine at most eight maximum-sized events in one step.\n  OR NEW.checkpoint_event_sequence - OLD.checkpoint_event_sequence > 8\n",
   "to": "", "tests": T},
  # M2 — matched_event_count reconciled against the stored receipts.
  {"id": "M2-matched-count-reconciled", "file": SQL,
   "from": "  OR NEW.matched_event_count <> (\n    SELECT count(*) FROM memory_literal_search_hits hit\n    WHERE hit.principal_id = NEW.principal_id AND hit.job_id = NEW.job_id\n  )\n",
   "to": "", "tests": T},
  # M5 — the archive branch's principal binding through memory_history_coverage.
  {"id": "M5-archived-principal-binding", "file": SQL,
   "from": "    JOIN memory_history_coverage coverage\n      ON coverage.principal_id = NEW.principal_id\n      AND coverage.start_event_sequence = archived.event_sequence\n      AND coverage.end_event_sequence = archived.event_sequence\n      AND coverage.source_location = 'archived'\n      AND coverage.r2_segment_id = archived.segment_id\n      AND coverage.indexing_outcome = 'indexed'\n      AND coverage.content_hash = archived.envelope_sha256\n",
   "to": "", "tests": T},
  # M4 — the attempt column is what lets a terminal job's key be reused.
  {"id": "M4-attempt-unique-key", "file": SQL,
   "from": "        AND job.job_key = NEW.job_key AND job.attempt = NEW.attempt\n",
   "to": "        AND job.job_key = NEW.job_key\n", "tests": T},
  # L9 — the principal re-check on the job update guard (disambiguated by its RAISE).
  {"id": "L9-principal-on-job-update", "file": SQL,
   "from": PRINCIPAL + "BEGIN\n  SELECT RAISE(ABORT, 'memory_literal_search_job_transition_invalid');\n",
   "to": "BEGIN\n  SELECT RAISE(ABORT, 'memory_literal_search_job_transition_invalid');\n", "tests": T},
  # L9 — the principal re-check on the hit insert guard (disambiguated by the suppression clause after it).
  {"id": "L9-principal-on-hit-insert", "file": SQL,
   "from": PRINCIPAL + "  OR EXISTS (\n    SELECT 1 FROM memory_active_event_suppressions suppression\n",
   "to": "  OR EXISTS (\n    SELECT 1 FROM memory_active_event_suppressions suppression\n", "tests": T},
  # H1 — the default repository's archived-event reader.
  {"id": "H1-default-archive-reader", "file": SRC,
   "from": "    this.memory = memory ?? new MemoryRepository(database, {\n      archivedEventReader: new ArchivalService({ database, bucket: archive }),\n    });\n",
   "to": "    this.memory = memory ?? new MemoryRepository(database);\n", "tests": T},
  # M3 — the ULID passthrough is opt-in.
  {"id": "M3-ulid-passthrough-optin", "file": CONTRACT,
   "from": "    if (structuralUlid && LOWERCASE_ULID.test(text)) return issueSanitizedRedaction(text, []);\n",
   "to": "    if (LOWERCASE_ULID.test(text)) return issueSanitizedRedaction(text, []);\n", "tests": TC},
 ]}
io.open(out, "w", encoding="utf-8", newline="").write(json.dumps(spec, indent=1))
print("wrote", out, "mutations:", len(spec["mutations"]) - 1)
