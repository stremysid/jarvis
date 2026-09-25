-- Whether Jarvis has judged this deadline's effort, as opposed to ingestion
-- defaulting it to `other`.
--
-- Before this column every collected row was `other` with the `other` lead, and
-- nothing could tell an already-judged `other` from a default one. So a listing
-- could not show the model which rows still needed a judgment, and a collector
-- revision could not know whether `other` was ours to overwrite or the model's
-- answer to keep.
--
-- Owner-reported rows are judged by construction: the only writer is
-- `deadline_record`/`deadline_judge`, whose `effort` argument is the model's.
-- Collected rows become judged when `deadline_judge` writes one. Marking
-- existing collected rows unjudged also retires the deleted keyword
-- classifier's output: the model can now re-judge them instead of an old word
-- table's answer standing forever.
ALTER TABLE deadlines ADD COLUMN effort_judged INTEGER NOT NULL DEFAULT 0 CHECK (effort_judged IN (0, 1));

UPDATE deadlines SET effort_judged = 1 WHERE source_id = 'owner-reported';
