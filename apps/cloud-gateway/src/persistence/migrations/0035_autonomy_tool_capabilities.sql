-- Capability tiers for the eight tools the owner agent can already dispatch.
--
-- `0008_autonomy.sql` seeded the tiers for the hands the roadmap adds. The
-- owner tools predate the registry and had no rows. Under the fail-closed rule
-- -- an unregistered capability is denied, never guessed at -- wiring the gate
-- without these rows would deny every memory, school, university and study call
-- the moment it deployed. So the rows and the wiring ship together, and this
-- migration must be applied BEFORE the gateway that reads it.
--
-- All five are tier 1, and that is a classification rather than a convenience.
-- The tier-2 exemplars `0008` seeds are all DEVICE actions (write.project_file,
-- write.calendar, open.application, vehicle.precondition), and the roadmap
-- scopes tier-2 shadow gating to "that device". These five are cloud-side
-- operations on the owner's own store: reachable only from his own first-party
-- authenticated turn, already gated by the agent's authority checks, and
-- reversible within that store.
--
-- The alternative was tier 2, and it is worth writing down why it was not
-- taken. `0008` seeds shadow mode and `decideOutcome` withholds every tier-2
-- action while the system is in shadow. Registering these at tier 2 would
-- therefore stop the school, university, study and memory tools the owner is
-- using today -- a safety change disabling the features it protects. Leaving
-- shadow mode is the owner's decision, and this migration does not make it for
-- him. If he later wants these stricter, one UPDATE to tier 2 is the change,
-- and its consequence is that production must be live first.
--
-- `memory.write` and not `delete.data`: memory forget hides by transition and
-- suppression and is never erasure. Its own receipt says the original
-- conversation remains retained.

INSERT INTO capability_tiers (capability, tier, description, updated_at) VALUES
  ('memory.read',      1, 'Read the owner memory ledger and its evidence', '2026-09-18T00:00:00.000Z'),
  ('memory.write',     1, 'Remember, forget, restore or confirm an owner memory', '2026-09-18T00:00:00.000Z'),
  ('school.track',     1, 'Update the owner school catch-up tracker', '2026-09-18T00:00:00.000Z'),
  ('university.track', 1, 'Update the owner university application tracker', '2026-09-18T00:00:00.000Z'),
  ('study.coach',      1, 'Update the owner study-coach evidence and practice', '2026-09-18T00:00:00.000Z');
