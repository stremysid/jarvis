PRAGMA foreign_keys = ON;

CREATE TABLE memory_fact_projection_heads (
  principal_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  published_version INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(published_version) = 'integer' AND published_version >= 0),
  manifest_hash TEXT
    CHECK (manifest_hash IS NULL OR (length(manifest_hash) = 64 AND manifest_hash NOT GLOB '*[^0-9a-f]*')),
  published_at TEXT
    CHECK (published_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', published_at) IS published_at),
  PRIMARY KEY (principal_id, device_id),
  FOREIGN KEY (device_id, principal_id)
    REFERENCES device_keys(device_id, principal_id) ON DELETE RESTRICT,
  CHECK (
    (published_version = 0 AND manifest_hash IS NULL AND published_at IS NULL)
    OR (published_version > 0 AND manifest_hash IS NOT NULL AND published_at IS NOT NULL)
  )
);

CREATE TABLE memory_fact_projection_versions (
  principal_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  projection_version INTEGER NOT NULL
    CHECK (typeof(projection_version) = 'integer' AND projection_version BETWEEN 1 AND 2147483647),
  manifest_hash TEXT NOT NULL
    CHECK (length(manifest_hash) = 64 AND manifest_hash NOT GLOB '*[^0-9a-f]*'),
  page_count INTEGER NOT NULL
    CHECK (typeof(page_count) = 'integer' AND page_count BETWEEN 1 AND 32),
  total_fact_count INTEGER NOT NULL
    CHECK (typeof(total_fact_count) = 'integer' AND total_fact_count BETWEEN 0 AND 1024),
  key_id TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL
    CHECK (length(key_fingerprint) = 64 AND key_fingerprint NOT GLOB '*[^0-9a-f]*'),
  key_generation INTEGER NOT NULL CHECK (key_generation > 0),
  status TEXT NOT NULL CHECK (status IN ('staged', 'published')),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  expires_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at AND expires_at > created_at),
  published_at TEXT
    CHECK (published_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', published_at) IS published_at),
  PRIMARY KEY (principal_id, device_id, projection_version),
  FOREIGN KEY (device_id, principal_id)
    REFERENCES device_keys(device_id, principal_id) ON DELETE RESTRICT,
  CHECK (
    (status = 'staged' AND published_at IS NULL)
    OR (status = 'published' AND published_at IS NOT NULL)
  )
);

CREATE TABLE memory_fact_projection_pages (
  principal_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  projection_version INTEGER NOT NULL,
  page_index INTEGER NOT NULL
    CHECK (typeof(page_index) = 'integer' AND page_index BETWEEN 0 AND 31),
  page_hash TEXT NOT NULL
    CHECK (length(page_hash) = 64 AND page_hash NOT GLOB '*[^0-9a-f]*'),
  fact_count INTEGER NOT NULL
    CHECK (typeof(fact_count) = 'integer' AND fact_count BETWEEN 0 AND 32),
  page_json TEXT NOT NULL
    CHECK (json_valid(page_json) AND length(CAST(page_json AS BLOB)) <= 65536),
  created_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  PRIMARY KEY (principal_id, device_id, projection_version, page_index),
  FOREIGN KEY (principal_id, device_id, projection_version)
    REFERENCES memory_fact_projection_versions(principal_id, device_id, projection_version)
    ON DELETE CASCADE
);

CREATE TABLE memory_fact_projection_facts (
  projection_fact_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  projection_version INTEGER NOT NULL,
  page_index INTEGER NOT NULL,
  fact_position INTEGER NOT NULL
    CHECK (typeof(fact_position) = 'integer' AND fact_position BETWEEN 0 AND 31),
  fact_id TEXT NOT NULL
    CHECK (length(fact_id) = 37 AND fact_id GLOB 'fact_*'
      AND substr(fact_id, 6) NOT GLOB '*[^0-9a-f]*'),
  text TEXT NOT NULL CHECK (length(CAST(text AS BLOB)) BETWEEN 1 AND 4096),
  origin TEXT NOT NULL CHECK (origin IN (
    'authenticated_first_person', 'deterministic_observation', 'model', 'third_party'
  )),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'sensitive')),
  confidence REAL NOT NULL CHECK (typeof(confidence) IN ('real', 'integer') AND confidence BETWEEN 0 AND 1),
  distiller_version TEXT NOT NULL CHECK (length(CAST(distiller_version AS BLOB)) BETWEEN 1 AND 128),
  distilled_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', distilled_at) IS distilled_at),
  content_hash TEXT NOT NULL
    CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  primary_event_id TEXT NOT NULL
    CHECK (length(primary_event_id) = 26 AND substr(primary_event_id, 1, 1) BETWEEN '0' AND '7'
      AND primary_event_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'),
  primary_event_sequence INTEGER NOT NULL
    CHECK (typeof(primary_event_sequence) = 'integer' AND primary_event_sequence > 0),
  sources_json TEXT NOT NULL
    CHECK (json_valid(sources_json) AND json_type(sources_json) = 'array'
      AND json_array_length(sources_json) BETWEEN 1 AND 8
      AND length(CAST(sources_json AS BLOB)) <= 32768),
  fact_json TEXT NOT NULL
    CHECK (json_valid(fact_json) AND length(CAST(fact_json AS BLOB)) <= 49152),
  UNIQUE (principal_id, device_id, projection_version, fact_id),
  UNIQUE (principal_id, device_id, projection_version, page_index, fact_position),
  FOREIGN KEY (principal_id, device_id, projection_version, page_index)
    REFERENCES memory_fact_projection_pages(principal_id, device_id, projection_version, page_index)
    ON DELETE CASCADE
);

CREATE VIRTUAL TABLE memory_fact_projection_fts USING fts5(
  text,
  content='memory_fact_projection_facts',
  content_rowid='projection_fact_rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER memory_fact_projection_facts_fts_insert
AFTER INSERT ON memory_fact_projection_facts
BEGIN
  INSERT INTO memory_fact_projection_fts(rowid, text) VALUES (NEW.projection_fact_rowid, NEW.text);
END;

CREATE TRIGGER memory_fact_projection_facts_fts_delete
AFTER DELETE ON memory_fact_projection_facts
BEGIN
  INSERT INTO memory_fact_projection_fts(memory_fact_projection_fts, rowid, text)
  VALUES ('delete', OLD.projection_fact_rowid, OLD.text);
END;

CREATE TRIGGER memory_fact_projection_pages_immutable
BEFORE UPDATE ON memory_fact_projection_pages
BEGIN
  SELECT RAISE(ABORT, 'memory_projection_page_immutable');
END;

CREATE TRIGGER memory_fact_projection_facts_immutable
BEFORE UPDATE ON memory_fact_projection_facts
BEGIN
  SELECT RAISE(ABORT, 'memory_projection_fact_immutable');
END;

CREATE TRIGGER memory_fact_projection_versions_transition
BEFORE UPDATE ON memory_fact_projection_versions
WHEN OLD.principal_id IS NOT NEW.principal_id
  OR OLD.device_id IS NOT NEW.device_id
  OR OLD.projection_version IS NOT NEW.projection_version
  OR OLD.manifest_hash IS NOT NEW.manifest_hash
  OR OLD.page_count IS NOT NEW.page_count
  OR OLD.total_fact_count IS NOT NEW.total_fact_count
  OR OLD.key_id IS NOT NEW.key_id
  OR OLD.key_fingerprint IS NOT NEW.key_fingerprint
  OR OLD.key_generation IS NOT NEW.key_generation
  OR OLD.created_at IS NOT NEW.created_at
  OR OLD.expires_at IS NOT NEW.expires_at
  OR OLD.status <> 'staged'
  OR NEW.status <> 'published'
  OR OLD.published_at IS NOT NULL
  OR NEW.published_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'memory_projection_version_immutable');
END;

CREATE TABLE memory_fact_projection_commits (
  principal_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  projection_version INTEGER NOT NULL,
  manifest_hash TEXT NOT NULL
    CHECK (length(manifest_hash) = 64 AND manifest_hash NOT GLOB '*[^0-9a-f]*'),
  key_id TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL
    CHECK (length(key_fingerprint) = 64 AND key_fingerprint NOT GLOB '*[^0-9a-f]*'),
  key_generation INTEGER NOT NULL CHECK (key_generation > 0),
  committed_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', committed_at) IS committed_at),
  PRIMARY KEY (principal_id, device_id, projection_version)
);

CREATE TRIGGER memory_fact_projection_commit_publish
BEFORE INSERT ON memory_fact_projection_commits
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM device_keys d JOIN principals p ON p.principal_id = d.principal_id
    WHERE d.device_id = NEW.device_id AND d.principal_id = NEW.principal_id
      AND d.key_id = NEW.key_id AND d.key_fingerprint = NEW.key_fingerprint
      AND d.key_generation = NEW.key_generation AND d.status = 'active' AND p.status = 'active'
  ) THEN RAISE(ABORT, 'memory_projection_device_state_changed') END;
  UPDATE memory_fact_projection_versions
  SET status = 'published', published_at = NEW.committed_at
  WHERE principal_id = NEW.principal_id
    AND device_id = NEW.device_id
    AND projection_version = NEW.projection_version
    AND manifest_hash = NEW.manifest_hash
    AND key_id = NEW.key_id
    AND key_fingerprint = NEW.key_fingerprint
    AND key_generation = NEW.key_generation
    AND status = 'staged'
    AND expires_at > NEW.committed_at
    AND (SELECT COUNT(*) FROM memory_fact_projection_pages p
      WHERE p.principal_id = NEW.principal_id AND p.device_id = NEW.device_id
        AND p.projection_version = NEW.projection_version) = page_count
    AND (SELECT COALESCE(SUM(p.fact_count), 0) FROM memory_fact_projection_pages p
      WHERE p.principal_id = NEW.principal_id AND p.device_id = NEW.device_id
        AND p.projection_version = NEW.projection_version) = total_fact_count
    AND EXISTS (
      SELECT 1 FROM memory_fact_projection_heads h
      WHERE h.principal_id = NEW.principal_id AND h.device_id = NEW.device_id
        AND h.published_version = NEW.projection_version - 1
    );
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'memory_projection_state_changed') END;
  UPDATE memory_fact_projection_heads
  SET published_version = NEW.projection_version,
      manifest_hash = NEW.manifest_hash,
      published_at = NEW.committed_at
  WHERE principal_id = NEW.principal_id
    AND device_id = NEW.device_id
    AND published_version = NEW.projection_version - 1;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'memory_projection_head_changed') END;
  DELETE FROM memory_fact_projection_versions
  WHERE principal_id = NEW.principal_id
    AND device_id = NEW.device_id
    AND projection_version < NEW.projection_version;
END;

CREATE TRIGGER memory_fact_projection_commits_immutable_update
BEFORE UPDATE ON memory_fact_projection_commits
BEGIN
  SELECT RAISE(ABORT, 'memory_projection_commit_immutable');
END;

CREATE TRIGGER memory_fact_projection_commits_immutable_delete
BEFORE DELETE ON memory_fact_projection_commits
BEGIN
  SELECT RAISE(ABORT, 'memory_projection_commit_immutable');
END;
