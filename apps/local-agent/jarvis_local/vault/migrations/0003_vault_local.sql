-- Vault operational state, deliberately in the SAME database as the archive.
--
-- The reason is one transaction. Appending an observation and moving the
-- document head are a single fact about the world -- "version 4 is now what
-- this note says" -- and split across two databases there is a window where
-- the head names an observation that does not exist, or an observation exists
-- that nothing points at. Neither is recoverable by re-running: the first is a
-- dangling head that fails every read, the second is a version that silently
-- never became current.
--
-- These tables carry the only relative paths in the system. They are local
-- state and are excluded from every payload, log line and diagnostic; the
-- observation record next to them holds opaque ids and a non-path label
-- instead.

-- The one root this agent owns. `root_path` is local-only. The NTFS volume
-- serial and file id are recorded when the OS reports them so a moved or
-- replaced root can be *detected*; without a retained handle they cannot
-- prevent the move, only make it visible afterwards.
CREATE TABLE vault_binding (
    vault_id      TEXT PRIMARY KEY,
    principal_id  TEXT NOT NULL,
    root_path     TEXT NOT NULL,
    volume_serial INTEGER,
    root_file_id  TEXT,
    bound_at      TEXT NOT NULL
) STRICT;

-- One binding per principal, enforced by the database rather than by the
-- repository remembering to check. A second root would give every document id
-- two possible meanings.
CREATE UNIQUE INDEX vault_binding_one_per_principal ON vault_binding (principal_id);

CREATE TRIGGER vault_binding_no_update BEFORE UPDATE ON vault_binding
BEGIN SELECT RAISE(ABORT, 'vault_immutable_violation'); END;

CREATE TRIGGER vault_binding_no_delete BEFORE DELETE ON vault_binding
BEGIN SELECT RAISE(ABORT, 'vault_immutable_violation'); END;

-- A note, identified by where it sits. `document_id` is derived from the
-- vault id and the relative path, so re-crawling recognises the same note
-- without a lookup that could disagree with the derivation.
CREATE TABLE vault_document (
    document_id   TEXT PRIMARY KEY,
    vault_id      TEXT NOT NULL REFERENCES vault_binding(vault_id),
    relative_path TEXT NOT NULL,
    display_label TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    UNIQUE (vault_id, relative_path)
) STRICT;

-- Selective: a note's title legitimately changes when the owner edits its
-- heading, but the location that gave it its identity never may. A blanket
-- update block would make a retitled note unrepresentable; allowing the path
-- to move would make the derived id a lie.
CREATE TRIGGER vault_document_location_is_immutable BEFORE UPDATE ON vault_document
WHEN OLD.relative_path IS NOT NEW.relative_path
  OR OLD.vault_id IS NOT NEW.vault_id
  OR OLD.created_at IS NOT NEW.created_at
BEGIN SELECT RAISE(ABORT, 'vault_immutable_violation'); END;

CREATE TRIGGER vault_document_no_delete BEFORE DELETE ON vault_document
BEGIN SELECT RAISE(ABORT, 'vault_immutable_violation'); END;

-- Append-only. Every version of every note the agent has ever seen, including
-- the ones it saw disappear. A deletion here would be the archive forgetting,
-- which is the property the whole design exists to prevent.
CREATE TABLE vault_observation (
    observation_id              TEXT PRIMARY KEY,
    vault_id                    TEXT NOT NULL,
    document_id                 TEXT NOT NULL REFERENCES vault_document(document_id),
    document_version            INTEGER NOT NULL CHECK (document_version > 0),
    operation                   TEXT NOT NULL CHECK (operation IN ('observed', 'tombstoned')),
    previous_observation_id     TEXT,
    previous_content_hash       TEXT,
    derived_from_observation_id TEXT,
    canonical_text              TEXT NOT NULL,
    canonical_content_hash      TEXT NOT NULL CHECK (length(canonical_content_hash) = 64),
    observed_at                 TEXT NOT NULL,
    sensitivity                 TEXT NOT NULL CHECK (sensitivity IN ('personal', 'restricted')),
    redaction_status            TEXT NOT NULL CHECK (redaction_status IN ('none', 'redacted')),
    redaction_markers           TEXT NOT NULL,
    origin                      TEXT NOT NULL
        CHECK (origin IN ('user_authored', 'jarvis_projection', 'user_edited_projection')),
    projection_operation_id     TEXT,
    projection_receipt_id       TEXT,
    display_label               TEXT NOT NULL,
    -- A tombstone that carried text would be a copy of the note outliving the
    -- note. Enforced here as well as in the model because this is the row that
    -- survives every future version of the code that writes it.
    CHECK (operation <> 'tombstoned' OR canonical_text = ''),
    UNIQUE (document_id, document_version)
) STRICT;

CREATE INDEX vault_observation_by_document ON vault_observation (document_id, document_version);

CREATE TRIGGER vault_observation_no_update BEFORE UPDATE ON vault_observation
BEGIN SELECT RAISE(ABORT, 'vault_immutable_violation'); END;

CREATE TRIGGER vault_observation_no_delete BEFORE DELETE ON vault_observation
BEGIN SELECT RAISE(ABORT, 'vault_immutable_violation'); END;

-- What each note currently says. The one mutable projection, and the reason
-- an observation citing a stale predecessor can be refused: a head that could
-- be overwritten by any arriving observation would not be a head, it would be
-- a most-recent-write.
CREATE TABLE vault_document_head (
    document_id      TEXT PRIMARY KEY REFERENCES vault_document(document_id),
    observation_id   TEXT NOT NULL REFERENCES vault_observation(observation_id),
    document_version INTEGER NOT NULL,
    content_hash     TEXT NOT NULL,
    operation        TEXT NOT NULL CHECK (operation IN ('observed', 'tombstoned')),
    updated_at       TEXT NOT NULL
) STRICT;

CREATE TRIGGER vault_document_head_no_delete BEFORE DELETE ON vault_document_head
BEGIN SELECT RAISE(ABORT, 'vault_immutable_violation'); END;

-- A head only ever moves forward. A version going backwards is either a
-- replayed observation or a lost update, and both would silently resurrect
-- text the owner has already replaced.
CREATE TRIGGER vault_document_head_no_rewind BEFORE UPDATE ON vault_document_head
WHEN NEW.document_version <= OLD.document_version
BEGIN SELECT RAISE(ABORT, 'vault_head_rewind'); END;

-- The write-once projection journal.
--
-- The row is durable BEFORE the file is created, so a crash in between leaves
-- an operation with no receipt -- which is recognisable. The alternative
-- ordering leaves a file nothing knows about, and the next run publishes a
-- second copy.
CREATE TABLE vault_projection_operation (
    operation_id       TEXT PRIMARY KEY,
    vault_id           TEXT NOT NULL,
    intended_directory TEXT NOT NULL,
    intended_name      TEXT NOT NULL,
    content_hash       TEXT NOT NULL CHECK (length(content_hash) = 64),
    content_bytes      INTEGER NOT NULL,
    prepared_at        TEXT NOT NULL
) STRICT;

CREATE TRIGGER vault_projection_operation_no_update BEFORE UPDATE ON vault_projection_operation
BEGIN SELECT RAISE(ABORT, 'vault_immutable_violation'); END;

CREATE TRIGGER vault_projection_operation_no_delete BEFORE DELETE ON vault_projection_operation
BEGIN SELECT RAISE(ABORT, 'vault_immutable_violation'); END;

CREATE TABLE vault_projection_receipt (
    receipt_id   TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL UNIQUE REFERENCES vault_projection_operation(operation_id),
    final_name   TEXT NOT NULL,
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    disposition  TEXT NOT NULL CHECK (disposition IN ('published', 'recovered')),
    committed_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER vault_projection_receipt_no_update BEFORE UPDATE ON vault_projection_receipt
BEGIN SELECT RAISE(ABORT, 'vault_immutable_violation'); END;

CREATE TRIGGER vault_projection_receipt_no_delete BEFORE DELETE ON vault_projection_receipt
BEGIN SELECT RAISE(ABORT, 'vault_immutable_violation'); END;

-- A prepared operation whose file was never found. Recorded rather than
-- retried: republishing would risk a second copy of something the owner may
-- already have, and deleting the journal row would erase the evidence that
-- anything was attempted.
CREATE TABLE vault_projection_abandonment (
    operation_id TEXT PRIMARY KEY REFERENCES vault_projection_operation(operation_id),
    code         TEXT NOT NULL,
    recorded_at  TEXT NOT NULL
) STRICT;

CREATE TRIGGER vault_projection_abandonment_no_update BEFORE UPDATE ON vault_projection_abandonment
BEGIN SELECT RAISE(ABORT, 'vault_immutable_violation'); END;

CREATE TRIGGER vault_projection_abandonment_no_delete BEFORE DELETE ON vault_projection_abandonment
BEGIN SELECT RAISE(ABORT, 'vault_immutable_violation'); END;

-- Derived, rebuildable full-text over current heads only. Not part of the
-- record: deleting this table and rebuilding it from vault_observation must
-- produce the same results, which is why nothing else reads from it.
CREATE VIRTUAL TABLE vault_head_search USING fts5(
    document_id UNINDEXED,
    observation_id UNINDEXED,
    text,
    tokenize = 'unicode61 remove_diacritics 2'
);

-- Maintained by trigger rather than by the indexer, so no write path can move
-- a head to text that search cannot see. The `operation = 'observed'` filter
-- in the SELECT is what keeps a tombstoned note out of results: its head row
-- exists, and it contributes no searchable row.
CREATE TRIGGER vault_head_search_insert AFTER INSERT ON vault_document_head
BEGIN
    DELETE FROM vault_head_search WHERE document_id = new.document_id;
    INSERT INTO vault_head_search (document_id, observation_id, text)
    SELECT new.document_id, new.observation_id, observation.canonical_text
    FROM vault_observation AS observation
    WHERE observation.observation_id = new.observation_id
      AND new.operation = 'observed';
END;

CREATE TRIGGER vault_head_search_update AFTER UPDATE ON vault_document_head
BEGIN
    DELETE FROM vault_head_search WHERE document_id = new.document_id;
    INSERT INTO vault_head_search (document_id, observation_id, text)
    SELECT new.document_id, new.observation_id, observation.canonical_text
    FROM vault_observation AS observation
    WHERE observation.observation_id = new.observation_id
      AND new.operation = 'observed';
END;
