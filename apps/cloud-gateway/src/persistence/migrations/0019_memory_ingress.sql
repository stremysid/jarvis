-- Privileged memory commands use one reserved event type and source pair.
-- Every accepted command must also be the canonical envelope emitted by the
-- reviewed memory-control producer for an active human principal. The 0016
-- mutation guards bind the operation, target and every material operand to the
-- exact row the command authorizes.
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
          'item.transition', 'item.forget', 'item.correct',
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

-- Topic order and alias precedence use writer-stamped time. Refuse stale
-- queued or retried writes so commit order cannot be reversed by an old stamp.
CREATE TRIGGER memory_topic_events_recent_insert_guard
BEFORE INSERT ON memory_topic_events
WHEN NEW.occurred_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes')
BEGIN
  SELECT RAISE(ABORT, 'memory_topic_event_stale');
END;
