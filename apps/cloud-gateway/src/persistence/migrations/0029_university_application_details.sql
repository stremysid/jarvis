-- Append-only preparation and owner-reported execution records for university applications.

CREATE TABLE university_workflow_items (
  principal_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  application_item_id TEXT,
  workflow_id TEXT NOT NULL CHECK (
    length(workflow_id) = 26
    AND substr(workflow_id, 1, 1) GLOB '[0-7]'
    AND workflow_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  workflow_key TEXT NOT NULL CHECK (length(workflow_key) BETWEEN 1 AND 384),
  workflow_kind TEXT NOT NULL CHECK (workflow_kind IN (
    'submission_step', 'upload_step', 'contact_step', 'signup_step', 'payment_step',
    'transcript_order_step', 'offer', 'offer_condition', 'offer_response'
  )),
  workflow_label TEXT NOT NULL CHECK (
    length(workflow_label) BETWEEN 1 AND 160
    AND instr(workflow_label, char(0)) = 0
    AND instr(workflow_label, char(10)) = 0
    AND instr(workflow_label, char(13)) = 0
  ),
  owner_role TEXT NOT NULL CHECK (owner_role IN (
    'sid', 'referee', 'guidance', 'school', 'university'
  )),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  PRIMARY KEY (principal_id, workflow_id),
  UNIQUE (principal_id, program_id, workflow_key),
  FOREIGN KEY (principal_id, program_id)
    REFERENCES university_programs(principal_id, program_id) ON DELETE RESTRICT,
  FOREIGN KEY (principal_id, application_item_id)
    REFERENCES university_application_items(principal_id, item_id) ON DELETE RESTRICT,
  CHECK (
    (workflow_kind IN ('offer', 'offer_condition', 'offer_response') AND application_item_id IS NULL)
    OR (workflow_kind NOT IN ('offer', 'offer_condition', 'offer_response') AND application_item_id IS NOT NULL)
  )
) WITHOUT ROWID;

CREATE INDEX university_workflow_items_program_idx
ON university_workflow_items(principal_id, program_id, workflow_key, workflow_id);

CREATE TRIGGER university_workflow_items_insert_guard
BEFORE INSERT ON university_workflow_items
BEGIN
  SELECT RAISE(ABORT, 'university_workflow_item_insert_conflict') WHERE EXISTS (
    SELECT 1 FROM university_workflow_items
    WHERE principal_id = NEW.principal_id
      AND (workflow_id = NEW.workflow_id
        OR (program_id = NEW.program_id AND workflow_key = NEW.workflow_key))
  );
END;

CREATE TRIGGER university_workflow_items_application_guard
BEFORE INSERT ON university_workflow_items
WHEN NEW.application_item_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'university_workflow_application_item_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM university_application_items
    WHERE principal_id = NEW.principal_id
      AND program_id = NEW.program_id
      AND item_id = NEW.application_item_id
  );
END;

CREATE TRIGGER university_workflow_items_cap_insert
BEFORE INSERT ON university_workflow_items
BEGIN
  SELECT RAISE(ABORT, 'university_workflow_item_limit_exceeded') WHERE (
    SELECT COUNT(*) FROM university_workflow_items
    WHERE principal_id = NEW.principal_id
  ) >= 128 OR (
    SELECT COUNT(*) FROM university_workflow_items
    WHERE principal_id = NEW.principal_id AND program_id = NEW.program_id
  ) >= 64;
END;

CREATE TRIGGER university_workflow_items_reject_update
BEFORE UPDATE ON university_workflow_items
BEGIN
  SELECT RAISE(ABORT, 'university_workflow_item_update_forbidden');
END;

CREATE TRIGGER university_workflow_items_reject_delete
BEFORE DELETE ON university_workflow_items
BEGIN
  SELECT RAISE(ABORT, 'university_workflow_item_delete_forbidden');
END;

CREATE TABLE university_workflow_revisions (
  principal_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  event_id TEXT NOT NULL CHECK (
    length(event_id) = 26
    AND substr(event_id, 1, 1) GLOB '[0-7]'
    AND event_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  revision_number INTEGER NOT NULL CHECK (revision_number BETWEEN 1 AND 64),
  workflow_status TEXT NOT NULL CHECK (workflow_status IN (
    'prepared', 'owner_reported_done', 'owner_reported_not_done',
    'owner_reported_offered', 'owner_reported_waitlisted', 'owner_reported_rejected',
    'owner_reported_withdrawn', 'owner_reported_pending', 'owner_reported_satisfied',
    'owner_reported_unsatisfied', 'owner_reported_accepted', 'owner_reported_declined',
    'not_needed_by_sid'
  )),
  prepared_details TEXT CHECK (
    prepared_details IS NULL OR (
      length(prepared_details) BETWEEN 1 AND 2048
      AND instr(prepared_details, char(0)) = 0
    )
  ),
  execution_boundary TEXT NOT NULL CHECK (execution_boundary = 'owner_only'),
  due_date TEXT CHECK (
    due_date IS NULL OR (
      length(due_date) = 10
      AND due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND strftime('%Y-%m-%d', due_date) IS due_date
    )
  ),
  due_at TEXT CHECK (
    due_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', due_at) IS due_at
  ),
  due_timezone TEXT CHECK (
    due_timezone IS NULL OR (
      length(due_timezone) BETWEEN 3 AND 64
      AND instr(due_timezone, char(0)) = 0
      AND instr(due_timezone, char(10)) = 0
      AND instr(due_timezone, char(13)) = 0
    )
  ),
  verification_state TEXT NOT NULL CHECK (verification_state IN ('verified', 'unverified')),
  source_url TEXT CHECK (
    source_url IS NULL OR (length(source_url) BETWEEN 9 AND 512 AND source_url LIKE 'https://%')
  ),
  admission_cycle TEXT CHECK (admission_cycle IS NULL OR length(admission_cycle) BETWEEN 1 AND 64),
  verified_at TEXT CHECK (
    verified_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', verified_at) IS verified_at
  ),
  source_turn_id TEXT NOT NULL REFERENCES conversation_turns(turn_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  PRIMARY KEY (principal_id, event_id),
  UNIQUE (principal_id, workflow_id, revision_number),
  FOREIGN KEY (principal_id, workflow_id)
    REFERENCES university_workflow_items(principal_id, workflow_id) ON DELETE RESTRICT,
  CHECK (
    (due_date IS NULL AND due_at IS NULL AND due_timezone IS NULL)
    OR (due_date IS NOT NULL AND due_at IS NULL AND due_timezone IS NULL)
    OR (due_date IS NULL AND due_at IS NOT NULL AND due_timezone IS NOT NULL)
  ),
  CHECK (
    (verification_state = 'verified'
      AND (due_date IS NOT NULL OR due_at IS NOT NULL)
      AND source_url IS NOT NULL AND admission_cycle IS NOT NULL AND verified_at IS NOT NULL)
    OR (verification_state = 'unverified'
      AND source_url IS NULL AND admission_cycle IS NULL AND verified_at IS NULL)
  )
) WITHOUT ROWID;

CREATE INDEX university_workflow_revisions_latest_idx
ON university_workflow_revisions(principal_id, workflow_id, revision_number DESC);

CREATE TRIGGER university_workflow_revisions_insert_guard
BEFORE INSERT ON university_workflow_revisions
BEGIN
  SELECT RAISE(ABORT, 'university_workflow_revision_insert_conflict') WHERE EXISTS (
    SELECT 1 FROM university_workflow_revisions
    WHERE principal_id = NEW.principal_id
      AND (event_id = NEW.event_id
        OR (workflow_id = NEW.workflow_id AND revision_number = NEW.revision_number))
  );
END;

CREATE TRIGGER university_workflow_revisions_sequence_guard
BEFORE INSERT ON university_workflow_revisions
WHEN NOT EXISTS (
  SELECT 1 FROM university_workflow_revisions
  WHERE principal_id = NEW.principal_id
    AND workflow_id = NEW.workflow_id
    AND revision_number = NEW.revision_number
)
BEGIN
  SELECT RAISE(ABORT, 'university_workflow_revision_sequence_invalid') WHERE
    NEW.revision_number != COALESCE((
      SELECT MAX(revision_number) FROM university_workflow_revisions
      WHERE principal_id = NEW.principal_id AND workflow_id = NEW.workflow_id
    ), 0) + 1
    OR NOT EXISTS (
      SELECT 1 FROM university_workflow_items
      WHERE principal_id = NEW.principal_id
        AND workflow_id = NEW.workflow_id
        AND created_at <= NEW.created_at
    );
END;

CREATE TRIGGER university_workflow_revisions_status_guard
BEFORE INSERT ON university_workflow_revisions
BEGIN
  SELECT RAISE(ABORT, 'university_workflow_revision_status_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM university_workflow_items
    WHERE principal_id = NEW.principal_id
      AND workflow_id = NEW.workflow_id
      AND (
        (workflow_kind IN (
          'submission_step', 'upload_step', 'contact_step', 'signup_step',
          'payment_step', 'transcript_order_step'
        ) AND NEW.workflow_status IN (
          'prepared', 'owner_reported_done', 'owner_reported_not_done', 'not_needed_by_sid'
        ))
        OR (workflow_kind = 'offer' AND NEW.workflow_status IN (
          'owner_reported_offered', 'owner_reported_waitlisted', 'owner_reported_rejected',
          'owner_reported_withdrawn', 'not_needed_by_sid'
        ))
        OR (workflow_kind = 'offer_condition' AND NEW.workflow_status IN (
          'owner_reported_pending', 'owner_reported_satisfied',
          'owner_reported_unsatisfied', 'not_needed_by_sid'
        ))
        OR (workflow_kind = 'offer_response' AND NEW.workflow_status IN (
          'prepared', 'owner_reported_accepted', 'owner_reported_declined', 'not_needed_by_sid'
        ))
      )
  );
END;

CREATE TRIGGER university_workflow_revisions_require_owner_turn
BEFORE INSERT ON university_workflow_revisions
BEGIN
  SELECT RAISE(ABORT, 'university_workflow_revision_owner_turn_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM conversation_turns
    WHERE turn_id = NEW.source_turn_id
      AND principal_id = NEW.principal_id
      AND channel = 'telegram'
  );
END;

CREATE TRIGGER university_workflow_revisions_reject_update
BEFORE UPDATE ON university_workflow_revisions
BEGIN
  SELECT RAISE(ABORT, 'university_workflow_revision_update_forbidden');
END;

CREATE TRIGGER university_workflow_revisions_reject_delete
BEFORE DELETE ON university_workflow_revisions
BEGIN
  SELECT RAISE(ABORT, 'university_workflow_revision_delete_forbidden');
END;
