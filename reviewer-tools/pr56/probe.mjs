import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const SQL0025 = readFileSync(new URL("./src/0025.sql", import.meta.url), "utf8");

const STUBS = `
PRAGMA foreign_keys = ON;

CREATE TABLE principals (
  principal_id TEXT PRIMARY KEY,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('human', 'service')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  display_name TEXT NOT NULL,
  pin_verifier_version TEXT,
  pin_verifier_secret_ref TEXT CHECK (pin_verifier_secret_ref IS NULL OR pin_verifier_secret_ref = 'PIN_VERIFIER_JSON'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((principal_type = 'human' AND pin_verifier_version IS NOT NULL AND pin_verifier_secret_ref = 'PIN_VERIFIER_JSON') OR principal_type = 'service')
);

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK (sequence > 0),
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE archive_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  sealed_through INTEGER NOT NULL CHECK (sealed_through >= 0),
  circuit_state TEXT NOT NULL CHECK (circuit_state IN ('closed','open')),
  circuit_reason TEXT, circuit_opened_at TEXT, updated_at TEXT NOT NULL
);
INSERT INTO archive_state VALUES (1, 0, 'closed', NULL, NULL, '1970-01-01T00:00:00.000Z');

CREATE TABLE archive_manifests (
  manifest_id TEXT PRIMARY KEY,
  start_sequence INTEGER NOT NULL UNIQUE,
  end_sequence INTEGER NOT NULL UNIQUE,
  event_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status = 'sealed'),
  created_at TEXT NOT NULL, sealed_at TEXT NOT NULL
);

CREATE TABLE archive_segments (
  segment_id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL UNIQUE REFERENCES archive_manifests(manifest_id) ON DELETE RESTRICT,
  object_key TEXT NOT NULL UNIQUE,
  compressed_sha256 TEXT NOT NULL UNIQUE,
  compressed_byte_length INTEGER NOT NULL,
  uncompressed_byte_length INTEGER NOT NULL,
  codec TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE archive_segment_events (
  event_sequence INTEGER PRIMARY KEY CHECK (event_sequence > 0),
  event_id TEXT NOT NULL UNIQUE,
  segment_id TEXT NOT NULL REFERENCES archive_segments(segment_id) ON DELETE RESTRICT,
  envelope_sha256 TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (segment_id, event_sequence)
);

CREATE TABLE memory_event_suppressions (
  suppression_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  target_event_id TEXT,
  start_event_sequence INTEGER,
  end_event_sequence INTEGER,
  owner_authorizing_event_id TEXT NOT NULL,
  forgotten_transition_id TEXT,
  source_id TEXT,
  reason TEXT NOT NULL,
  newly_hidden_turn_count INTEGER NOT NULL,
  total_covered_turn_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (principal_id, suppression_id),
  CHECK (
    (target_event_id IS NOT NULL AND start_event_sequence IS NULL AND end_event_sequence IS NULL)
    OR (target_event_id IS NULL AND start_event_sequence IS NOT NULL AND end_event_sequence IS NOT NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE TABLE memory_event_suppression_lifts (
  lift_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  suppression_id TEXT NOT NULL,
  owner_authorizing_event_id TEXT NOT NULL,
  correction_transition_id TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (suppression_id),
  UNIQUE (principal_id, lift_id),
  FOREIGN KEY (principal_id, suppression_id)
    REFERENCES memory_event_suppressions(principal_id, suppression_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TABLE memory_history_chunks (
  chunk_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id TEXT NOT NULL UNIQUE,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  start_event_sequence INTEGER NOT NULL,
  end_event_sequence INTEGER NOT NULL,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_location TEXT NOT NULL CHECK (source_location IN ('live','archived','mixed')),
  r2_segment_id TEXT,
  source_receipt_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (principal_id, chunk_id)
) STRICT;

CREATE TABLE memory_history_coverage (
  coverage_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  source_location TEXT NOT NULL CHECK (source_location IN ('live','archived')),
  start_event_sequence INTEGER NOT NULL,
  end_event_sequence INTEGER NOT NULL,
  r2_segment_id TEXT,
  indexing_outcome TEXT NOT NULL CHECK (indexing_outcome IN ('indexed','failed')),
  content_hash TEXT NOT NULL,
  failure_code TEXT,
  indexed_at TEXT NOT NULL,
  UNIQUE (principal_id, coverage_id)
) STRICT, WITHOUT ROWID;

CREATE VIEW memory_active_event_suppressions AS
SELECT suppression.*
FROM memory_event_suppressions suppression
LEFT JOIN memory_event_suppression_lifts lift
  ON lift.principal_id = suppression.principal_id
  AND lift.suppression_id = suppression.suppression_id
WHERE lift.lift_id IS NULL;

-- 0016's version of the guard that 0025 drops and replaces.
CREATE TRIGGER memory_history_chunks_insert_guard
BEFORE INSERT ON memory_history_chunks
WHEN (NEW.chunk_rowid IS NOT NULL AND EXISTS (
    SELECT 1 FROM memory_history_chunks chunk WHERE chunk.chunk_rowid = NEW.chunk_rowid))
  OR EXISTS (SELECT 1 FROM memory_history_chunks chunk WHERE chunk.chunk_id = NEW.chunk_id)
BEGIN
  SELECT RAISE(ABORT, 'memory_history_chunk_receipt_invalid');
END;
`;

const OWNER = "principal:owner";
const OTHER = "principal:service";
const T0 = "2026-09-15T22:00:00.000Z";
const T1 = "2026-09-15T22:01:00.000Z";
const T2 = "2026-09-15T22:02:00.000Z";
const H = (c) => String(c).repeat(64);
const ulid = (tail) => `01k5fsvag0000000000000${String(tail).padStart(4, "0")}`.slice(0, 26);

function fresh() {
  const d = new DatabaseSync(":memory:");
  d.exec(STUBS);
  d.exec(SQL0025);
  d.exec(`INSERT INTO principals VALUES ('${OWNER}','human','active','Owner','v1','PIN_VERIFIER_JSON','${T0}','${T0}')`);
  d.exec(`INSERT INTO principals VALUES ('${OTHER}','service','active','Svc',NULL,NULL,'${T0}','${T0}')`);
  return d;
}

function addEvent(d, seq, eventId, subject = OWNER) {
  d.prepare(`INSERT INTO events (sequence, event_id, event_type, source, subject_id,
    occurred_at, received_at, content_hash, envelope_json, created_at)
    VALUES (?,?,'conversation.user_committed','conversation',?,?,?,?, '{}', ?)`)
    .run(seq, eventId, subject, T0, T0, H(2), T0);
}

function archiveEvent(d, seq, eventId, segTail) {
  const manifestId = H(segTail);
  const segmentId = H(segTail);
  d.prepare(`INSERT INTO archive_manifests VALUES (?,?,?,1,'sealed',?,?)`).run(manifestId, seq, seq, T0, T0);
  d.prepare(`INSERT INTO archive_segments VALUES (?,?,?,?,1,1,'jarvis-gzip-ndjson-v1',?)`)
    .run(segmentId, manifestId, `k/${segmentId}`, segmentId, T0);
  d.prepare(`INSERT INTO archive_segment_events VALUES (?,?,?,?,?,?)`)
    .run(seq, eventId, segmentId, H(3), H(2), T0);
}

function insertJob(d, { jobId, jobKey, snapshot = 1, principal = OWNER }) {
  d.prepare(`INSERT INTO memory_literal_search_jobs (job_id, principal_id, job_key, query_text,
    query_hash, snapshot_event_sequence, checkpoint_event_sequence, scanned_event_count,
    matched_event_count, status, failure_code, created_at, updated_at, completed_at)
    VALUES (?,?,?,'needle',?,?,0,0,0,'pending',NULL,?,?,NULL)`)
    .run(jobId, principal, jobKey, H(1), snapshot, T0, T0);
}

const results = [];
function probe(name, fn) {
  try {
    const outcome = fn();
    results.push(`PASS-RUN  ${name} :: ${outcome}`);
  } catch (error) {
    results.push(`THREW     ${name} :: ${error.message}`);
  }
}
function expectThrow(fn) {
  try { fn(); return "NO ERROR (accepted)"; } catch (e) { return `rejected: ${e.message}`; }
}

// 1. schema installs
probe("1 schema installs", () => {
  const d = fresh();
  const rows = d.prepare(`SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'memory_literal%' ORDER BY name`).all();
  return rows.map((r) => r.name).join(",");
});

// 2. snapshot ceiling
probe("2a snapshot above live max + sealed_through", () => {
  const d = fresh(); addEvent(d, 1, ulid(1));
  return expectThrow(() => insertJob(d, { jobId: ulid(10), jobKey: "k", snapshot: 2 }));
});
probe("2b snapshot equal to live max", () => {
  const d = fresh(); addEvent(d, 1, ulid(1));
  return expectThrow(() => insertJob(d, { jobId: ulid(10), jobKey: "k", snapshot: 1 }));
});
probe("2c snapshot from sealed_through only (all events purged)", () => {
  const d = fresh();
  d.exec("UPDATE archive_state SET sealed_through = 9 WHERE singleton = 1");
  return expectThrow(() => insertJob(d, { jobId: ulid(10), jobKey: "k", snapshot: 9 }));
});

// 3. non-owner principal
probe("3 service principal job", () => {
  const d = fresh(); addEvent(d, 1, ulid(1));
  return expectThrow(() => insertJob(d, { jobId: ulid(10), jobKey: "k", snapshot: 1, principal: OTHER }));
});

// 4. forged completion WITH scanned_event_count set to match checkpoint
probe("4 forged 'succeeded' skipping the whole walk (scanned set to match)", () => {
  const d = fresh();
  for (let i = 1; i <= 5; i += 1) addEvent(d, i, ulid(i));
  insertJob(d, { jobId: ulid(10), jobKey: "k", snapshot: 5 });
  d.exec(`UPDATE memory_literal_search_jobs SET status='running', updated_at='${T1}'`);
  const out = expectThrow(() => d.exec(`UPDATE memory_literal_search_jobs
    SET status='succeeded', checkpoint_event_sequence=5, scanned_event_count=5,
        matched_event_count=0, updated_at='${T2}', completed_at='${T2}'`));
  const row = d.prepare("SELECT status, checkpoint_event_sequence, scanned_event_count FROM memory_literal_search_jobs").get();
  return `${out} | row=${JSON.stringify(row)}`;
});

// 5. terminal states
probe("5a failed -> running", () => {
  const d = fresh(); addEvent(d, 1, ulid(1));
  insertJob(d, { jobId: ulid(10), jobKey: "k", snapshot: 1 });
  d.exec(`UPDATE memory_literal_search_jobs SET status='running', updated_at='${T1}'`);
  d.exec(`UPDATE memory_literal_search_jobs SET status='failed', failure_code='x', updated_at='${T2}', completed_at='${T2}'`);
  return expectThrow(() => d.exec(`UPDATE memory_literal_search_jobs SET status='running', failure_code=NULL, completed_at=NULL, updated_at='2026-09-15T22:03:00.000Z'`));
});
probe("5b succeeded -> anything", () => {
  const d = fresh(); addEvent(d, 1, ulid(1));
  insertJob(d, { jobId: ulid(10), jobKey: "k", snapshot: 1 });
  d.exec(`UPDATE memory_literal_search_jobs SET status='running', updated_at='${T1}'`);
  d.exec(`UPDATE memory_literal_search_jobs SET status='succeeded', checkpoint_event_sequence=1, scanned_event_count=1, updated_at='${T2}', completed_at='${T2}'`);
  return expectThrow(() => d.exec(`UPDATE memory_literal_search_jobs SET status='running', completed_at=NULL, updated_at='2026-09-15T22:03:00.000Z'`));
});
probe("5c delete a wedged pending job (job_key reuse)", () => {
  const d = fresh(); addEvent(d, 1, ulid(1));
  insertJob(d, { jobId: ulid(10), jobKey: "k", snapshot: 1 });
  const del = expectThrow(() => d.exec("DELETE FROM memory_literal_search_jobs"));
  const reuse = expectThrow(() => insertJob(d, { jobId: ulid(11), jobKey: "k", snapshot: 1 }));
  return `delete=${del} | reuse-same-key=${reuse}`;
});

// 6. cross-principal archived hit
probe("6 hit receipt for an ARCHIVED event owned by another principal", () => {
  const d = fresh();
  addEvent(d, 1, ulid(1), OTHER);          // event belongs to the service principal
  archiveEvent(d, 1, ulid(1), 5);
  d.exec("DELETE FROM events");             // simulate purge
  d.exec("UPDATE archive_state SET sealed_through = 1 WHERE singleton = 1");
  insertJob(d, { jobId: ulid(10), jobKey: "k", snapshot: 1, principal: OWNER });
  d.exec(`UPDATE memory_literal_search_jobs SET status='running', updated_at='${T1}'`);
  return expectThrow(() => d.prepare(`INSERT INTO memory_literal_search_hits
    (principal_id, job_id, event_sequence, event_id, content_hash, found_at) VALUES (?,?,?,?,?,?)`)
    .run(OWNER, ulid(10), 1, ulid(1), H(2), T1));
});

// 6b. same for a LIVE event owned by another principal (control)
probe("6b hit receipt for a LIVE event owned by another principal", () => {
  const d = fresh();
  addEvent(d, 1, ulid(1), OTHER);
  insertJob(d, { jobId: ulid(10), jobKey: "k", snapshot: 1, principal: OWNER });
  d.exec(`UPDATE memory_literal_search_jobs SET status='running', updated_at='${T1}'`);
  return expectThrow(() => d.prepare(`INSERT INTO memory_literal_search_hits
    (principal_id, job_id, event_sequence, event_id, content_hash, found_at) VALUES (?,?,?,?,?,?)`)
    .run(OWNER, ulid(10), 1, ulid(1), H(2), T1));
});

// 7. suppression blocks hits, lift restores
probe("7 suppression then lift on a hit receipt", () => {
  const d = fresh();
  addEvent(d, 1, ulid(1));
  insertJob(d, { jobId: ulid(10), jobKey: "k", snapshot: 1 });
  d.exec(`UPDATE memory_literal_search_jobs SET status='running', updated_at='${T1}'`);
  d.prepare(`INSERT INTO memory_event_suppressions VALUES (?,?,?,NULL,NULL,?,NULL,NULL,'r',1,1,?)`)
    .run(ulid(20), OWNER, ulid(1), ulid(30), T0);
  const blocked = expectThrow(() => d.prepare(`INSERT INTO memory_literal_search_hits
    (principal_id, job_id, event_sequence, event_id, content_hash, found_at) VALUES (?,?,?,?,?,?)`)
    .run(OWNER, ulid(10), 1, ulid(1), H(2), T1));
  d.prepare(`INSERT INTO memory_event_suppression_lifts VALUES (?,?,?,?,NULL,'r',?)`)
    .run(ulid(21), OWNER, ulid(20), ulid(31), T1);
  const allowed = expectThrow(() => d.prepare(`INSERT INTO memory_literal_search_hits
    (principal_id, job_id, event_sequence, event_id, content_hash, found_at) VALUES (?,?,?,?,?,?)`)
    .run(OWNER, ulid(10), 1, ulid(1), H(2), T1));
  return `suppressed=${blocked} | lifted=${allowed}`;
});

// 7b. a forget landing AFTER the receipt cannot remove it
probe("7b forget after the receipt exists", () => {
  const d = fresh();
  addEvent(d, 1, ulid(1));
  insertJob(d, { jobId: ulid(10), jobKey: "k", snapshot: 1 });
  d.exec(`UPDATE memory_literal_search_jobs SET status='running', updated_at='${T1}'`);
  d.prepare(`INSERT INTO memory_literal_search_hits
    (principal_id, job_id, event_sequence, event_id, content_hash, found_at) VALUES (?,?,?,?,?,?)`)
    .run(OWNER, ulid(10), 1, ulid(1), H(2), T1);
  d.prepare(`INSERT INTO memory_event_suppressions VALUES (?,?,?,NULL,NULL,?,NULL,NULL,'r',1,1,?)`)
    .run(ulid(20), OWNER, ulid(1), ulid(30), T1);
  const del = expectThrow(() => d.exec("DELETE FROM memory_literal_search_hits"));
  const still = d.prepare("SELECT count(*) AS c FROM memory_literal_search_hits").get();
  return `delete=${del} | rows_remaining=${still.c}`;
});

// 8. matched_event_count vs real hit rows
probe("8 matched_event_count can exceed stored hit rows", () => {
  const d = fresh();
  for (let i = 1; i <= 3; i += 1) addEvent(d, i, ulid(i));
  insertJob(d, { jobId: ulid(10), jobKey: "k", snapshot: 3 });
  d.exec(`UPDATE memory_literal_search_jobs SET status='running', updated_at='${T1}'`);
  const out = expectThrow(() => d.exec(`UPDATE memory_literal_search_jobs
    SET checkpoint_event_sequence=3, scanned_event_count=3, matched_event_count=3,
        status='succeeded', updated_at='${T2}', completed_at='${T2}'`));
  const c = d.prepare("SELECT count(*) AS c FROM memory_literal_search_hits").get();
  return `${out} | matched=3 rows=${c.c}`;
});

// 9. chunk guard: suppression that targets an ARCHIVED event inside the range
probe("9 chunk insert with a suppression targeting an archived event in range", () => {
  const d = fresh();
  addEvent(d, 1, ulid(1));
  archiveEvent(d, 1, ulid(1), 5);
  d.exec("DELETE FROM events");
  d.exec("UPDATE archive_state SET sealed_through = 1 WHERE singleton = 1");
  d.prepare(`INSERT INTO memory_history_coverage VALUES (?,?,'archived',1,1,?,'indexed',?,NULL,?)`)
    .run(ulid(40), OWNER, H(5), H(3), T0);
  d.prepare(`INSERT INTO memory_event_suppressions VALUES (?,?,?,NULL,NULL,?,NULL,NULL,'r',1,1,?)`)
    .run(ulid(20), OWNER, ulid(1), ulid(30), T0);
  return expectThrow(() => d.prepare(`INSERT INTO memory_history_chunks
    (chunk_id, principal_id, start_event_sequence, end_event_sequence, text, content_hash,
     source_location, r2_segment_id, source_receipt_hash, created_at, updated_at)
    VALUES (?,?,1,1,'needle',?,'archived',?,?,?,?)`)
    .run(ulid(50), OWNER, H(2), H(5), H(3), T0, T0));
});

// 10. INSERT OR REPLACE / IGNORE on hits
probe("10 OR REPLACE / OR IGNORE on hits", () => {
  const d = fresh();
  addEvent(d, 1, ulid(1));
  insertJob(d, { jobId: ulid(10), jobKey: "k", snapshot: 1 });
  d.exec(`UPDATE memory_literal_search_jobs SET status='running', updated_at='${T1}'`);
  d.prepare(`INSERT INTO memory_literal_search_hits
    (principal_id, job_id, event_sequence, event_id, content_hash, found_at) VALUES (?,?,?,?,?,?)`)
    .run(OWNER, ulid(10), 1, ulid(1), H(2), T1);
  const r = expectThrow(() => d.exec(`INSERT OR REPLACE INTO memory_literal_search_hits
    SELECT * FROM memory_literal_search_hits`));
  const c = d.prepare("SELECT count(*) AS c FROM memory_literal_search_hits").get();
  return `${r} | rows=${c.c}`;
});

// 11. hits accepted only while the job is running
probe("11 hit insert against a pending / succeeded job", () => {
  const d = fresh();
  addEvent(d, 1, ulid(1));
  insertJob(d, { jobId: ulid(10), jobKey: "k", snapshot: 1 });
  const pending = expectThrow(() => d.prepare(`INSERT INTO memory_literal_search_hits
    (principal_id, job_id, event_sequence, event_id, content_hash, found_at) VALUES (?,?,?,?,?,?)`)
    .run(OWNER, ulid(10), 1, ulid(1), H(2), T1));
  d.exec(`UPDATE memory_literal_search_jobs SET status='running', updated_at='${T1}'`);
  d.exec(`UPDATE memory_literal_search_jobs SET status='succeeded', checkpoint_event_sequence=1,
    scanned_event_count=1, updated_at='${T2}', completed_at='${T2}'`);
  const done = expectThrow(() => d.prepare(`INSERT INTO memory_literal_search_hits
    (principal_id, job_id, event_sequence, event_id, content_hash, found_at) VALUES (?,?,?,?,?,?)`)
    .run(OWNER, ulid(10), 1, ulid(1), H(2), T2));
  return `pending=${pending} | succeeded=${done}`;
});

// 12. a job survives its principal being disabled
probe("12 disabled principal can still drive the job forward", () => {
  const d = fresh();
  addEvent(d, 1, ulid(1));
  insertJob(d, { jobId: ulid(10), jobKey: "k", snapshot: 1 });
  d.exec(`UPDATE principals SET status='disabled' WHERE principal_id='${OWNER}'`);
  d.exec(`UPDATE memory_literal_search_jobs SET status='running', updated_at='${T1}'`);
  const hit = expectThrow(() => d.prepare(`INSERT INTO memory_literal_search_hits
    (principal_id, job_id, event_sequence, event_id, content_hash, found_at) VALUES (?,?,?,?,?,?)`)
    .run(OWNER, ulid(10), 1, ulid(1), H(2), T1));
  return `running-transition=ok | hit=${hit}`;
});

// 13. jobs update guard: updated_at may equal OLD, completed_at may equal updated_at
probe("13 zero-progress running->running churn", () => {
  const d = fresh();
  addEvent(d, 1, ulid(1));
  insertJob(d, { jobId: ulid(10), jobKey: "k", snapshot: 1 });
  d.exec(`UPDATE memory_literal_search_jobs SET status='running', updated_at='${T1}'`);
  let n = 0;
  for (let i = 0; i < 100; i += 1) {
    try { d.exec(`UPDATE memory_literal_search_jobs SET updated_at='${T1}'`); n += 1; } catch { break; }
  }
  return `no-op updates accepted: ${n}`;
});

// 14. foreign key integrity
probe("14 foreign_key_check", () => {
  const d = fresh();
  addEvent(d, 1, ulid(1));
  insertJob(d, { jobId: ulid(10), jobKey: "k", snapshot: 1 });
  return JSON.stringify(d.prepare("PRAGMA foreign_key_check").all());
});

console.log(results.join("\n"));
