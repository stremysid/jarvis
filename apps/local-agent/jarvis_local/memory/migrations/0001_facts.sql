-- Distilled memory: facts derived from the archive, each citing its sources.
--
-- Distinct from the archive in one important way: the archive is immutable,
-- while a fact's *state* legitimately changes (proposed -> active, active ->
-- superseded). What never changes is a fact's content or its provenance, so
-- those are protected while `state` is not.
CREATE TABLE fact (
    fact_id          TEXT PRIMARY KEY,
    principal_id     TEXT NOT NULL,
    text             TEXT NOT NULL,
    origin           TEXT NOT NULL,
    state            TEXT NOT NULL,
    sensitivity      TEXT NOT NULL,
    confidence       REAL NOT NULL,
    distiller_version TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    content_hash     TEXT NOT NULL
) STRICT;

-- A fact with no source is an assertion with no evidence. The design requires
-- every distilled item to reference one or more raw event identifiers, so the
-- link table is the enforcement of that.
CREATE TABLE fact_source (
    fact_id        TEXT NOT NULL REFERENCES fact(fact_id),
    source_event_id TEXT NOT NULL,
    position       INTEGER NOT NULL,
    PRIMARY KEY (fact_id, source_event_id)
) STRICT;

-- Corrections create an immutable edge rather than rewriting the superseded
-- fact. Selection then picks the newest active fact; history stays readable.
CREATE TABLE fact_supersession (
    superseding_fact_id TEXT NOT NULL REFERENCES fact(fact_id),
    superseded_fact_id  TEXT NOT NULL REFERENCES fact(fact_id),
    created_at          TEXT NOT NULL,
    PRIMARY KEY (superseding_fact_id, superseded_fact_id)
) STRICT;

CREATE INDEX fact_by_principal_state ON fact (principal_id, state);
CREATE INDEX fact_source_by_event ON fact_source (source_event_id);

-- Content and provenance are immutable; only `state` may move. A trigger that
-- blanket-blocked UPDATE would prevent promotion, so this one is selective:
-- it aborts any update that alters what the fact says or where it came from.
CREATE TRIGGER fact_content_is_immutable BEFORE UPDATE ON fact
WHEN OLD.text IS NOT NEW.text
  OR OLD.origin IS NOT NEW.origin
  OR OLD.principal_id IS NOT NEW.principal_id
  OR OLD.content_hash IS NOT NEW.content_hash
  OR OLD.created_at IS NOT NEW.created_at
BEGIN SELECT RAISE(ABORT, 'fact_immutable_violation'); END;

CREATE TRIGGER fact_no_delete BEFORE DELETE ON fact
BEGIN SELECT RAISE(ABORT, 'fact_immutable_violation'); END;

CREATE TRIGGER fact_source_no_update BEFORE UPDATE ON fact_source
BEGIN SELECT RAISE(ABORT, 'fact_immutable_violation'); END;

CREATE TRIGGER fact_source_no_delete BEFORE DELETE ON fact_source
BEGIN SELECT RAISE(ABORT, 'fact_immutable_violation'); END;

CREATE TRIGGER fact_supersession_no_update BEFORE UPDATE ON fact_supersession
BEGIN SELECT RAISE(ABORT, 'fact_immutable_violation'); END;

CREATE TRIGGER fact_supersession_no_delete BEFORE DELETE ON fact_supersession
BEGIN SELECT RAISE(ABORT, 'fact_immutable_violation'); END;
