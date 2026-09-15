-- Bind privileged memory commands to their one reviewed ingress identity.
-- The runtime producer is not enabled by this migration.
CREATE TRIGGER events_memory_owner_command_ingress_guard
BEFORE INSERT ON events
WHEN (
    NEW.event_type = 'memory.owner_command'
    AND (
      NEW.source <> 'memory-control'
      OR json_extract(NEW.envelope_json, '$.producerVersion') IS NOT 'memory-control-v1'
    )
  )
  OR (
    NEW.source = 'memory-control'
    AND NEW.event_type <> 'memory.owner_command'
  )
BEGIN
  SELECT RAISE(ABORT, 'memory_owner_command_ingress_invalid');
END;
