-- Tier row for the `owner_access` tool, so the owner agent's guest-access
-- management is a classified capability rather than an unregistered name.
--
-- `access.manage` is already the capability `VoiceAccessAuthorityService`
-- checks before it mints owner management authority, and the registry installs
-- it for the owner. This row is the autonomy registry's separate view of the
-- same name, which the tool-classification guard reads.
--
-- Tier 1: managing who may call is the owner acting on his own access list,
-- reachable only from his own authenticated call, and it is not one of the five
-- actions he wants a confirmation for (Sid, 2026-09-24). The model decides
-- whether to read the number back or ask him to confirm, and code adds no
-- second confirmation of its own.

INSERT OR IGNORE INTO capability_tiers (capability, tier, description, updated_at) VALUES
  ('access.manage', 1, 'Manage who may call Jarvis as a guest', '2026-09-25T00:00:00.000Z');
