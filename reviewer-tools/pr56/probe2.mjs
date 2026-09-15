import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const SQL0025 = readFileSync(new URL("./src/0025.sql", import.meta.url), "utf8");

const BASE = `
PRAGMA foreign_keys = ON;
CREATE TABLE principals (principal_id TEXT PRIMARY KEY, principal_type TEXT NOT NULL,
  status TEXT NOT NULL, display_name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL, source TEXT NOT NULL, subject_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL, content_hash TEXT NOT NULL, envelope_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE archive_state (singleton INTEGER PRIMARY KEY, sealed_through INTEGER NOT NULL,
  circuit_state TEXT NOT NULL, circuit_reason TEXT, circuit_opened_at TEXT, updated_at TEXT NOT NULL);
INSERT INTO archive_state VALUES (1,0,'closed',NULL,NULL,'1970-01-01T00:00:00.000Z');
CREATE TABLE archive_manifests (manifest_id TEXT PRIMARY KEY, start_sequence INTEGER NOT NULL UNIQUE,
  end_sequence INTEGER NOT NULL UNIQUE, event_count INTEGER NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, sealed_at TEXT NOT NULL);
CREATE TABLE archive_segments (segment_id TEXT PRIMARY KEY, manifest_id TEXT NOT NULL UNIQUE
  REFERENCES archive_manifests(manifest_id), object_key TEXT NOT NULL UNIQUE,
  compressed_sha256 TEXT NOT NULL UNIQUE, compressed_byte_length INTEGER NOT NULL,
  uncompressed_byte_length INTEGER NOT NULL, codec TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE archive_segment_events (event_sequence INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE,
  segment_id TEXT NOT NULL REFERENCES archive_segments(segment_id), envelope_sha256 TEXT NOT NULL,
  content_hash TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (segment_id, event_sequence));
CREATE TABLE memory_event_suppressions (suppression_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id), target_event_id TEXT,
  start_event_sequence INTEGER, end_event_sequence INTEGER, owner_authorizing_event_id TEXT NOT NULL,
  forgotten_transition_id TEXT, source_id TEXT, reason TEXT NOT NULL,
  newly_hidden_turn_count INTEGER NOT NULL, total_covered_turn_count INTEGER NOT NULL,
  created_at TEXT NOT NULL, UNIQUE (principal_id, suppression_id)) STRICT, WITHOUT ROWID;
CREATE TABLE memory_event_suppression_lifts (lift_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id), suppression_id TEXT NOT NULL,
  owner_authorizing_event_id TEXT NOT NULL, correction_transition_id TEXT, reason TEXT NOT NULL,
  created_at TEXT NOT NULL, UNIQUE (suppression_id), UNIQUE (principal_id, lift_id),
  FOREIGN KEY (principal_id, suppression_id)
    REFERENCES memory_event_suppressions(principal_id, suppression_id)) STRICT, WITHOUT ROWID;
CREATE TABLE memory_history_chunks (chunk_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id TEXT NOT NULL UNIQUE, principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  start_event_sequence INTEGER NOT NULL, end_event_sequence INTEGER NOT NULL, text TEXT NOT NULL,
  content_hash TEXT NOT NULL, source_location TEXT NOT NULL, r2_segment_id TEXT,
  source_receipt_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (principal_id, chunk_id)) STRICT;
CREATE TABLE memory_history_coverage (coverage_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id), source_location TEXT NOT NULL,
  start_event_sequence INTEGER NOT NULL, end_event_sequence INTEGER NOT NULL, r2_segment_id TEXT,
  indexing_outcome TEXT NOT NULL, content_hash TEXT NOT NULL, failure_code TEXT,
  indexed_at TEXT NOT NULL, UNIQUE (principal_id, coverage_id)) STRICT, WITHOUT ROWID;
CREATE TABLE memory_cursors (principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  cursor_name TEXT NOT NULL, current_event_sequence INTEGER NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, cursor_name)) WITHOUT ROWID;
CREATE VIEW memory_active_event_suppressions AS SELECT suppression.* FROM memory_event_suppressions suppression
LEFT JOIN memory_event_suppression_lifts lift ON lift.principal_id = suppression.principal_id
  AND lift.suppression_id = suppression.suppression_id WHERE lift.lift_id IS NULL;
CREATE TRIGGER memory_history_chunks_insert_guard BEFORE INSERT ON memory_history_chunks
WHEN EXISTS (SELECT 1 FROM memory_history_chunks c WHERE c.chunk_id = NEW.chunk_id)
BEGIN SELECT RAISE(ABORT, 'memory_history_chunk_receipt_invalid'); END;
CREATE TRIGGER memory_cursors_monotonic_update BEFORE UPDATE ON memory_cursors
WHEN NEW.principal_id <> OLD.principal_id OR NEW.cursor_name <> OLD.cursor_name
  OR NEW.current_event_sequence < OLD.current_event_sequence OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'memory_cursor_transition_invalid'); END;
CREATE TRIGGER memory_history_coverage_insert_guard BEFORE INSERT ON memory_history_coverage
WHEN EXISTS (SELECT 1 FROM memory_history_coverage c WHERE c.coverage_id = NEW.coverage_id)
  OR (NEW.source_location = 'live' AND (
    NOT EXISTS (SELECT 1 FROM events e WHERE e.subject_id = NEW.principal_id
      AND e.sequence BETWEEN NEW.start_event_sequence AND NEW.end_event_sequence)
    OR NEW.end_event_sequence > COALESCE((SELECT max(e.sequence) FROM events e), 0)
    OR EXISTS (SELECT 1 FROM archive_segment_events a
      WHERE a.event_sequence BETWEEN NEW.start_event_sequence AND NEW.end_event_sequence)))
  OR (NEW.source_location = 'archived' AND NOT EXISTS (
    SELECT 1 FROM archive_segments s JOIN archive_manifests m ON m.manifest_id = s.manifest_id
    WHERE s.segment_id = NEW.r2_segment_id AND m.start_sequence <= NEW.start_event_sequence
      AND m.end_sequence >= NEW.end_event_sequence AND m.status = 'sealed'))
BEGIN SELECT RAISE(ABORT, 'memory_history_coverage_receipt_invalid'); END;
`;

const OWNER = "principal:owner";
const T0 = "2026-09-15T22:00:00.000Z";
const T1 = "2026-09-15T22:01:00.000Z";
const EARLIER = "2026-09-15T21:59:00.000Z";
const H = (c) => String(c).repeat(64);
const ulid = (t) => `01k5fsvag0000000000000${String(t).padStart(4, "0")}`.slice(0, 26);

function fresh() {
  const d = new DatabaseSync(":memory:");
  d.exec(BASE);
  d.exec(SQL0025);
  d.exec(`INSERT INTO principals VALUES ('${OWNER}','human','active','Owner','${T0}','${T0}')`);
  return d;
}

function ev(d, seq, id) {
  d.prepare(`INSERT INTO events (sequence, event_id, event_type, source, subject_id,
    occurred_at, received_at, content_hash, envelope_json, created_at)
    VALUES (?,?,'conversation.user_committed','conversation',?,?,?,?,'{}',?)`)
    .run(seq, id, OWNER, T0, T0, H(2), T0);
}

function arch(d, seq, id, tail) {
  d.prepare("INSERT INTO archive_manifests VALUES (?,?,?,1,'sealed',?,?)").run(H(tail), seq, seq, T0, T0);
  d.prepare("INSERT INTO archive_segments VALUES (?,?,?,?,1,1,'jarvis-gzip-ndjson-v1',?)")
    .run(H(tail), H(tail), "key/" + tail, H(tail), T0);
  d.prepare("INSERT INTO archive_segment_events VALUES (?,?,?,?,?,?)").run(seq, id, H(tail), H(3), H(2), T0);
}

function job(d, snapshot) {
  d.prepare(`INSERT INTO memory_literal_search_jobs VALUES (?,?,'k','needle',?,?,0,0,0,'pending',NULL,?,?,NULL)`)
    .run(ulid(10), OWNER, H(1), snapshot, T0, T0);
  d.exec(`UPDATE memory_literal_search_jobs SET status='running', updated_at='${T1}'`);
}

const out = [];
function attempt(label, fn) {
  try { fn(); out.push(label + " :: ACCEPTED"); }
  catch (error) { out.push(label + " :: rejected: " + error.message); }
}

attempt("A cursor update carrying an earlier updated_at (backwards clock)", () => {
  const d = fresh();
  d.prepare("INSERT INTO memory_cursors VALUES (?,'fts_history',2,?)").run(OWNER, T1);
  d.prepare(`UPDATE memory_cursors SET current_event_sequence = 3, updated_at = ?
    WHERE principal_id = ? AND cursor_name = 'fts_history'`).run(EARLIER, OWNER);
});

attempt("B 'live' coverage insert once that sequence is archived", () => {
  const d = fresh(); ev(d, 1, ulid(1)); arch(d, 1, ulid(1), 5);
  d.prepare("INSERT INTO memory_history_coverage VALUES (?,?,'live',1,1,NULL,'indexed',?,NULL,?)")
    .run(ulid(40), OWNER, H(3), T0);
});

attempt("B2 'archived' coverage insert for the same sequence", () => {
  const d = fresh(); ev(d, 1, ulid(1)); arch(d, 1, ulid(1), 5);
  d.prepare("INSERT INTO memory_history_coverage VALUES (?,?,'archived',1,1,?,'indexed',?,NULL,?)")
    .run(ulid(41), OWNER, H(5), H(3), T0);
});

attempt("C hit receipt inside an active range suppression", () => {
  const d = fresh(); ev(d, 1, ulid(1)); ev(d, 2, ulid(2)); job(d, 2);
  d.prepare("INSERT INTO memory_event_suppressions VALUES (?,?,NULL,1,2,?,NULL,NULL,'r',2,2,?)")
    .run(ulid(20), OWNER, ulid(30), T0);
  d.prepare("INSERT INTO memory_literal_search_hits VALUES (?,?,1,?,?,?)")
    .run(OWNER, ulid(10), ulid(1), H(2), T1);
});

attempt("D hit receipt whose content_hash matches no tier", () => {
  const d = fresh(); ev(d, 1, ulid(1)); job(d, 1);
  d.prepare("INSERT INTO memory_literal_search_hits VALUES (?,?,1,?,?,?)")
    .run(OWNER, ulid(10), ulid(1), H(9), T1);
});

attempt("E delete a history chunk row (no delete guard)", () => {
  const d = fresh(); ev(d, 1, ulid(1));
  d.prepare("INSERT INTO memory_history_coverage VALUES (?,?,'live',1,1,NULL,'indexed',?,NULL,?)")
    .run(ulid(40), OWNER, H(3), T0);
  d.prepare(`INSERT INTO memory_history_chunks (chunk_id, principal_id, start_event_sequence,
    end_event_sequence, text, content_hash, source_location, r2_segment_id,
    source_receipt_hash, created_at, updated_at)
    VALUES (?,?,1,1,'needle',?,'live',NULL,?,?,?)`).run(ulid(50), OWNER, H(2), H(3), T0, T0);
  d.exec("DELETE FROM memory_history_chunks");
  if (d.prepare("SELECT count(*) AS c FROM memory_history_chunks").get().c !== 0) throw new Error("not deleted");
});

console.log(out.join("\n"));
