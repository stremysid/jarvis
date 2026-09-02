-- The decision queue (plan section 6).
--
-- Everything waiting on the owner arrives here rather than as scattered pings
-- from whichever subsystem happened to need an answer. One ranked list, one
-- place to clear it.
--
-- Two rules from the plan are enforced structurally rather than left to the
-- code that builds a prompt. Every question carries an escape: a free-text
-- option and an explain-more option are inserted with the item, so a question
-- cannot be posed that boxes the owner into a forced pick. And an answered
-- item is never rewritten -- the response is a separate append-only row, so
-- "what did I actually choose" survives any later edit of the question.

CREATE TABLE decision_items (
  decision_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  -- Which subsystem is blocked. Used to route the answer back.
  origin TEXT NOT NULL CHECK (length(origin) <= 64),
  -- Opaque to this table: the origin's own correlation handle, quoted back
  -- verbatim when the answer is delivered.
  origin_reference TEXT,
  urgency TEXT NOT NULL CHECK (urgency IN ('urgent', 'normal')),
  question TEXT NOT NULL CHECK (length(question) > 0 AND length(question) <= 2048),
  -- Shown only when the owner asks for it, so the question itself stays short
  -- enough to answer from a lock screen.
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 8192),
  status TEXT NOT NULL CHECK (status IN ('open', 'delivered', 'answered', 'expired', 'withdrawn')),
  -- Ranking within the queue. Lower sorts first, with urgency breaking
  -- ties above it.
  rank INTEGER NOT NULL DEFAULT 100 CHECK (rank >= 0),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  resolved_at TEXT,
  -- A resolved item has a resolution time and an unresolved one does not.
  -- Without this, a bug that forgets the timestamp produces an item that is
  -- both answered and still owed an answer.
  CHECK ((status IN ('answered', 'expired', 'withdrawn')) = (resolved_at IS NOT NULL)),
  CHECK ((status = 'open') = (delivered_at IS NULL))
);
CREATE INDEX decision_items_queue_idx ON decision_items(status, urgency, rank, created_at);
CREATE INDEX decision_items_origin_idx ON decision_items(origin, status);

CREATE TABLE decision_options (
  decision_id TEXT NOT NULL REFERENCES decision_items(decision_id) ON DELETE RESTRICT,
  option_key TEXT NOT NULL CHECK (length(option_key) > 0 AND length(option_key) <= 32),
  label TEXT NOT NULL CHECK (length(label) > 0 AND length(label) <= 64),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  -- 'choice' is a real answer. 'free_text' and 'explain' are the two
  -- escapes the plan requires on every question.
  kind TEXT NOT NULL CHECK (kind IN ('choice', 'free_text', 'explain')),
  PRIMARY KEY (decision_id, option_key)
);
CREATE UNIQUE INDEX decision_options_ordinal_idx ON decision_options(decision_id, ordinal);

CREATE TABLE decision_responses (
  response_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES decision_items(decision_id) ON DELETE RESTRICT,
  -- NULL when the owner typed instead of tapping.
  option_key TEXT,
  free_text TEXT CHECK (free_text IS NULL OR length(free_text) <= 4096),
  -- The channel identity that answered. An answer from an identity that is
  -- not the owner's is not an answer.
  answered_by_identity_id TEXT NOT NULL,
  responded_at TEXT NOT NULL,
  CHECK (option_key IS NOT NULL OR free_text IS NOT NULL),
  FOREIGN KEY (decision_id, option_key) REFERENCES decision_options(decision_id, option_key) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX decision_responses_one_per_item_idx ON decision_responses(decision_id);

CREATE TRIGGER decision_responses_reject_delete
BEFORE DELETE ON decision_responses
BEGIN
  SELECT RAISE(ABORT, 'decision_response_delete_forbidden');
END;

CREATE TRIGGER decision_responses_reject_update
BEFORE UPDATE ON decision_responses
BEGIN
  SELECT RAISE(ABORT, 'decision_response_update_forbidden');
END;

-- The question the owner answered is the question that stays on record. A
-- later edit would silently change what their tap meant.
CREATE TRIGGER decision_items_freeze_question
BEFORE UPDATE OF question, detail ON decision_items
WHEN OLD.status IN ('answered', 'expired', 'withdrawn')
BEGIN
  SELECT RAISE(ABORT, 'decision_item_frozen');
END;

CREATE TRIGGER decision_items_reject_delete
BEFORE DELETE ON decision_items
BEGIN
  SELECT RAISE(ABORT, 'decision_item_delete_forbidden');
END;

-- Status runs forward only: open -> delivered -> answered/expired, or
-- withdrawn from either live state. Re-opening an answered item would let a
-- second, different answer overwrite the first.
CREATE TRIGGER decision_items_forward_only
BEFORE UPDATE OF status ON decision_items
WHEN NOT (
  (OLD.status = 'open' AND NEW.status IN ('delivered', 'answered', 'expired', 'withdrawn'))
  OR (OLD.status = 'delivered' AND NEW.status IN ('answered', 'expired', 'withdrawn'))
  OR OLD.status = NEW.status
)
BEGIN
  SELECT RAISE(ABORT, 'decision_item_state_transition_invalid');
END;
