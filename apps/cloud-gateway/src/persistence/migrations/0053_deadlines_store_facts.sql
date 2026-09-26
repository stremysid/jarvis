-- Deadlines store what the school systems state and nothing they do not: the
-- title, the course, the due date when there is one, the source and Sid's
-- status. Code no longer stores an effort category or a warning lead, because
-- whether and when to warn Sid is Jarvis's decision through the reminder tools.
--
-- The due date must be able to be absent. The table cannot be rebuilt for that:
-- triggers created in 0027 reference `deadlines`, and a DROP TABLE while they
-- exist fails in the full migration order (measured, `collector-migration`).
-- So the absent date is an added column rather than a relaxed one:
--
--   * `due_date` is the real column. NULL means the assignment states no due
--     date, which is stored as NULL and never filled in.
--   * `due_at` (NOT NULL, 0011) becomes a legacy placeholder. It is written as
--     the date when there is one and as '' when there is not, and nothing reads
--     it any more.
--   * `effort`, `lead_minutes` and `reminded_at` are written as placeholders
--     ('other', 0, NULL) to satisfy the old NOT NULLs and are never read.
--     Dropping them would need the same rebuild this migration cannot do.
ALTER TABLE deadlines ADD COLUMN due_date TEXT;

UPDATE deadlines SET due_date = due_at;

ALTER TABLE deadline_revisions ADD COLUMN due_date TEXT;

UPDATE deadline_revisions SET due_date = due_at;
