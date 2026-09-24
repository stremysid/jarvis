-- Only LDSB was accepted before this migration, so the historical default is provenance.
ALTER TABLE school_collector_reads ADD COLUMN host TEXT NOT NULL DEFAULT 'ldsb.elearningontario.ca'
  CHECK (host IN ('ldsb.elearningontario.ca', 'durham.elearningontario.ca'));
ALTER TABLE school_collector_batches ADD COLUMN unmapped_json TEXT NOT NULL DEFAULT '[]';
CREATE INDEX school_collector_host_reads ON school_collector_reads(principal_id, host, started_at DESC, received_at DESC);

-- Retry a proved pairing using one durable decision, even after notification or process failure.
CREATE UNIQUE INDEX school_collector_pair_decision ON decision_items(principal_id, origin_reference)
  WHERE origin = 'school-collector-pair';

-- Keep deadline IDs, revisions, status and reminders while moving legacy LDSB projections.
INSERT INTO deadline_sources (source_id, kind, label, active, last_success_at, last_failure, last_failure_at, created_at)
SELECT 'd2l-api:ldsb.elearningontario.ca:' || substr(source_id, 9), kind,
  'Brightspace session API (ldsb.elearningontario.ca)', active, last_success_at, last_failure, last_failure_at, created_at
FROM deadline_sources WHERE source_id LIKE 'd2l-api:%' AND substr(source_id, 9) NOT LIKE '%:%';
UPDATE deadlines SET source_id = 'd2l-api:ldsb.elearningontario.ca:' || substr(source_id, 9)
  WHERE source_id LIKE 'd2l-api:%' AND substr(source_id, 9) NOT LIKE '%:%';
-- Retain the old source row as history without duplicating its health warning.
UPDATE deadline_sources SET active = 0
  WHERE source_id LIKE 'd2l-api:%' AND substr(source_id, 9) NOT LIKE '%:%';
