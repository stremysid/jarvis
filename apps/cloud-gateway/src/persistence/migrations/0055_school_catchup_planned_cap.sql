-- The per-day plan caps are gone. Code used to refuse a fourth action on one
-- day, or a day totalling more than 180 minutes, and drop the extra actions
-- from the model's plan. That was code deciding how much Sid can manage in a
-- day. His pinned capacity lives in the core profile, which the prompt already
-- carries, and the plan's load is the model's judgment. Only the runaway cap
-- stays: at most 21 planned actions in total, which bounds the storage and the
-- prompt the next turn has to fit.
--
-- The per-block `estimated_minutes BETWEEN 5 AND 180` CHECK on the table is
-- unchanged: it is a named storage bound, and the model is told its range
-- rather than having a number rewritten to fit.
DROP TRIGGER school_catchup_actions_planned_cap_insert;

CREATE TRIGGER school_catchup_actions_planned_cap_insert
BEFORE INSERT ON school_catchup_actions
WHEN NEW.status = 'planned'
BEGIN
  SELECT RAISE(ABORT, 'school_catchup_action_limit_exceeded') WHERE (
    SELECT COUNT(*) FROM school_catchup_actions
    WHERE principal_id = NEW.principal_id AND status = 'planned'
  ) >= 21;
END;
