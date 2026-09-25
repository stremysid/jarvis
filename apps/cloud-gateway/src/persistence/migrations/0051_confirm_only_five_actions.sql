-- Sid's five actions ask first. Nothing else does.
--
-- Sid, 2026-09-24, verbatim: "the only thing Jarvis has restrictions on
-- anything like spending money sending emails making a call submitting school
-- work texting/calling somone on my behalf, that stuff needs an extra 'hey just
-- to be sure you want me to do xxx and xxx and etc' ... treat it like a human
-- Personal assistant, the only things I'd might want a human to double check
-- with me is the stuff I mentioned and that's literaly it".
--
-- Tier 3 is the one tier that always asks (a Telegram tap, or the spoken or
-- keyed PIN on a call). After this migration exactly five capabilities hold it,
-- one per action he named:
--
--   spend.money          spending money                      (seeded by 0008)
--   send.email           sending an email                    (new)
--   place.call           making a phone call                 (new)
--   submit.school_work   submitting school work              (new)
--   contact.third_party  texting or calling someone for him  (0008, reworded)
--
-- `send.email` is its own row rather than part of `contact.third_party`
-- because Sid named email without a recipient qualifier: an email to his own
-- address still asks. A message or reminder to Sid himself is not a third
-- party and stays `notify.owner`, tier 1.
--
-- Four tier-3 rows leave the confirming tier. None is one of the five.
--
--   school.collector.revoke  3 to 1. It turns off his own school collector
--     and is re-paired in Telegram. Tier 1 and not 2 because it is the only one
--     of the four with a tool the agent dispatches today, and tier 2 is
--     withheld while the /shadow switch is on, which would leave the tool
--     unable to run at all rather than able to run without asking.
--   delete.data, write.production, vehicle.unlock  3 to 2. No tool reaches
--     any of them yet. Tier 2 is the device-action tier `0008` already uses
--     for the car climate, calendar, project files and app launch. It never
--     asks. It runs when Sid has turned shadow mode off with /shadow off and is
--     reported instead of run while it is on, and that switch is his.
--
-- Every tier still writes an `autonomy_evaluations` row, so an action that no
-- longer asks is still receipted. The tier stays in the database, as `0008`
-- requires, so this change is a reviewed schema event rather than a refactor.
--
-- It only UPDATEs rows `0008` and `0040` seed and INSERTs three new rows. No
-- table, trigger or other row changes. It applies after `0040`, which seeds
-- the collector row, and a missing row would make its UPDATE a silent no-op,
-- which the migration test checks.

UPDATE capability_tiers
SET tier = 1,
    description = 'Revoke one of the owner''s own school collectors',
    updated_at = '2026-09-25T00:00:00.000Z'
WHERE capability = 'school.collector.revoke';

UPDATE capability_tiers
SET tier = 2,
    updated_at = '2026-09-25T00:00:00.000Z'
WHERE capability IN ('delete.data', 'write.production', 'vehicle.unlock');

UPDATE capability_tiers
SET description = 'Text, message or call anyone who is not the owner, on the owner''s behalf',
    updated_at = '2026-09-25T00:00:00.000Z'
WHERE capability = 'contact.third_party';

INSERT INTO capability_tiers (capability, tier, description, updated_at) VALUES
  ('send.email',         3, 'Send an email as the owner, to anyone', '2026-09-25T00:00:00.000Z'),
  ('place.call',         3, 'Place a phone call for the owner', '2026-09-25T00:00:00.000Z'),
  ('submit.school_work', 3, 'Submit school work for the owner', '2026-09-25T00:00:00.000Z');
