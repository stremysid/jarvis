-- Lifetime and the core profile.
--
-- Two abilities Phase 2 needs and the ledger does not have: a fact that stops
-- being true on its own, and a fact that is part of who Sid is and is therefore
-- given to Jarvis on every turn rather than retrieved by relevance.
--
-- Both are additive. The existing store, its immutability guards and its
-- suppression enforcement are deliberately untouched: forgetting is the
-- highest-consequence behaviour here, it demonstrably works, and rebuilding it
-- to gain a column would trade a working guarantee for a tidier schema.
--
-- The roadmap calls the first column `kind`. `memory_items.kind` already exists
-- and means something else -- the subject taxonomy, fact/preference/plan/... --
-- so this is `lifetime` and the subject axis keeps its name.
--
-- A note on `expires_at`, which the roadmap also names: the expiry column
-- already exists as `memory_item_versions.valid_to`, every recall path filters
-- on it and the nightly job already transitions elapsed facts to `expired`.
-- What is missing is a writer, not a column. Adding a second expiry column
-- would give the system two ways to say a fact has lapsed, which drift apart.
-- `expires_at` is therefore the tool's word for `valid_to`.

PRAGMA foreign_keys = ON;

-- An item's lifetime is fixed when it is created, which is why it belongs on
-- the insert-only table: nothing ever needs to update it, so the existing
-- `memory_items_immutable_update` guard stays exactly as it is.
-- Existing rows are durably true, which is also the literal truth -- no row
-- written before this migration has an end.
ALTER TABLE memory_items ADD COLUMN lifetime TEXT NOT NULL DEFAULT 'durable'
  CHECK (lifetime IN ('durable', 'temporary'));

-- One expiry mechanism, enforced where a version is written rather than argued
-- about in three call sites. Without this the two halves drift: an item Marked
-- temporary whose version carries no end, or a durable item with one, and the
-- recall filter then trusts whichever it read.
CREATE TRIGGER memory_item_versions_durable_has_no_end
BEFORE INSERT ON memory_item_versions
WHEN NEW.valid_to IS NOT NULL
  AND (SELECT item.lifetime FROM memory_items item
       WHERE item.principal_id = NEW.principal_id AND item.item_id = NEW.item_id) = 'durable'
BEGIN
  SELECT RAISE(ABORT, 'memory_item_lifetime_invalid');
END;

-- The other half. A temporary fact with no end is not temporary -- it would
-- never lapse, and the model would have been told it would.
CREATE TRIGGER memory_item_versions_temporary_has_end
BEFORE INSERT ON memory_item_versions
WHEN NEW.valid_to IS NULL
  AND (SELECT item.lifetime FROM memory_items item
       WHERE item.principal_id = NEW.principal_id AND item.item_id = NEW.item_id) = 'temporary'
BEGIN
  SELECT RAISE(ABORT, 'memory_item_lifetime_invalid');
END;

-- Pinning is append-only like everything else here: unpinning appends a row
-- rather than deleting one, so "was this ever pinned" stays answerable and the
-- delete guard below has nothing to protect against.
--
-- It is a separate table rather than a column on `memory_item_state` because
-- that table's update guard requires every update to advance a transition, and
-- a pin is not a lifecycle change. Adding a column there would mean relaxing the
-- invariant that makes the state machine trustworthy, to store a preference.
CREATE TABLE memory_item_pins (
  pin_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  pin_id TEXT NOT NULL UNIQUE CHECK (
    length(pin_id) = 26 AND substr(pin_id, 1, 1) BETWEEN '0' AND '7'
    AND pin_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  item_id TEXT NOT NULL,
  pin_number INTEGER NOT NULL CHECK (typeof(pin_number) = 'integer' AND pin_number > 0),
  pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
  authorizing_event_id TEXT NOT NULL CHECK (
    length(authorizing_event_id) = 26 AND substr(authorizing_event_id, 1, 1) BETWEEN '0' AND '7'
    AND authorizing_event_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
  ),
  occurred_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS occurred_at),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  UNIQUE (principal_id, pin_id),
  UNIQUE (principal_id, item_id, pin_number),
  FOREIGN KEY (principal_id, item_id)
    REFERENCES memory_items(principal_id, item_id) ON DELETE CASCADE
) STRICT;

-- The ledger's numbering discipline, for the same reason: a gap or a repeat
-- means two writers disagreed about what the current answer is.
CREATE TRIGGER memory_item_pins_insert_guard
BEFORE INSERT ON memory_item_pins
WHEN NEW.pin_number <> COALESCE(
    (SELECT max(pin.pin_number) + 1 FROM memory_item_pins pin
     WHERE pin.principal_id = NEW.principal_id AND pin.item_id = NEW.item_id),
    1
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_item_pin_sequence_invalid');
END;

CREATE TRIGGER memory_item_pins_immutable_update
BEFORE UPDATE ON memory_item_pins
BEGIN
  SELECT RAISE(ABORT, 'memory_item_pin_immutable');
END;

CREATE TRIGGER memory_item_pins_immutable_delete
BEFORE DELETE ON memory_item_pins
BEGIN
  SELECT RAISE(ABORT, 'memory_item_pin_immutable');
END;

CREATE VIEW memory_current_pins AS
SELECT pin.*
FROM memory_item_pins pin
WHERE pin.pin_number = (
  SELECT max(inner_pin.pin_number) FROM memory_item_pins inner_pin
  WHERE inner_pin.principal_id = pin.principal_id
    AND inner_pin.item_id = pin.item_id
);

-- The core profile: what is pinned AND still retrievable.
--
-- Built on `memory_retrievable_item_versions` rather than on the pin table
-- alone so a pinned fact that Sid later forgets leaves the profile by the same
-- enforcement every other read path uses. A view that read pins directly would
-- be a second answer to "is this hidden", which is how the suppression
-- machinery would get quietly bypassed by the one feature most likely to be
-- trusted in a prompt.
CREATE VIEW memory_pinned_item_versions AS
SELECT version.*
FROM memory_retrievable_item_versions version
JOIN memory_current_pins pin
  ON pin.principal_id = version.principal_id
  AND pin.item_id = version.item_id
WHERE pin.pinned = 1;

CREATE INDEX memory_item_pins_current
  ON memory_item_pins (principal_id, item_id, pin_number DESC);

-- Pinning is an owner memory command like forgetting, so it goes through the
-- same owner-authorised ingress rather than around it. The guard is recreated
-- with two more operations, and nothing it already allowed changes.
DROP TRIGGER IF EXISTS events_memory_owner_command_ingress_guard;

CREATE TRIGGER events_memory_owner_command_ingress_guard
BEFORE INSERT ON events
WHEN (NEW.event_type = 'memory.owner_command' AND NEW.source <> 'memory-control')
  OR (NEW.source = 'memory-control' AND NEW.event_type <> 'memory.owner_command')
  OR (
    NEW.event_type = 'memory.owner_command'
    AND NOT EXISTS (
      SELECT 1
      FROM principals principal
      WHERE principal.principal_id = NEW.subject_id
        AND principal.principal_type = 'human'
        AND principal.status = 'active'
        AND json_type(NEW.envelope_json, '$') = 'object'
        AND json_extract(NEW.envelope_json, '$.eventId') = NEW.event_id
        AND json_extract(NEW.envelope_json, '$.correlationId') = NEW.event_id
        AND json_extract(NEW.envelope_json, '$.eventType') = NEW.event_type
        AND json_extract(NEW.envelope_json, '$.source') = NEW.source
        AND json_extract(NEW.envelope_json, '$.subjectId') = NEW.subject_id
        AND json_extract(NEW.envelope_json, '$.occurredAt') = NEW.occurred_at
        AND json_extract(NEW.envelope_json, '$.receivedAt') = NEW.received_at
        AND json_extract(NEW.envelope_json, '$.contentHash') = NEW.content_hash
        AND json_extract(NEW.envelope_json, '$.producerVersion') = 'memory-control-v1'
        AND json_type(NEW.envelope_json, '$.payload') = 'object'
        AND json_extract(NEW.envelope_json, '$.payload.operation') IN (
          'item.transition', 'item.forget', 'item.correct', 'item.pin', 'item.unpin',
          'history.suppress', 'history.lift',
          'topic.create', 'topic.rename', 'topic.move', 'topic.merge',
          'placement.place', 'placement.refile', 'placement.remove',
          'reprocess.create'
        )
        AND json_type(NEW.envelope_json, '$.payload.targetId') = 'text'
        AND length(json_extract(NEW.envelope_json, '$.payload.targetId')) = 26
        AND substr(json_extract(NEW.envelope_json, '$.payload.targetId'), 1, 1)
          BETWEEN '0' AND '7'
        AND json_extract(NEW.envelope_json, '$.payload.targetId')
          NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_owner_command_ingress_invalid');
END;
