PRAGMA foreign_keys = ON;

CREATE TABLE conversation_turns (
  turn_id TEXT NOT NULL PRIMARY KEY
    CHECK (length(turn_id) = 26 AND substr(turn_id, 1, 1) BETWEEN '0' AND '7' AND turn_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'),
  session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 256),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  channel TEXT NOT NULL CHECK (channel IN ('voice', 'telegram')),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  user_event_id TEXT NOT NULL UNIQUE
    CHECK (length(user_event_id) = 26 AND substr(user_event_id, 1, 1) BETWEEN '0' AND '7' AND user_event_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'),
  state TEXT NOT NULL CHECK (state IN (
    'user_committed', 'model_claimed', 'assistant_staged', 'voice_sent', 'delivered',
    'cancelled', 'failed', 'model_outcome_unknown', 'delivery_unknown'
  )),
  model_claim_token_hash TEXT
    CHECK (model_claim_token_hash IS NULL OR (length(model_claim_token_hash) = 64 AND model_claim_token_hash NOT GLOB '*[^0-9a-f]*')),
  model_claimed_at TEXT CHECK (model_claimed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', model_claimed_at) IS model_claimed_at),
  model_claim_expires_at TEXT CHECK (model_claim_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', model_claim_expires_at) IS model_claim_expires_at),
  resolved_at TEXT CHECK (resolved_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at) IS resolved_at),
  staged_delivery_id TEXT UNIQUE
    CHECK (staged_delivery_id IS NULL OR (length(staged_delivery_id) = 26 AND substr(staged_delivery_id, 1, 1) BETWEEN '0' AND '7' AND staged_delivery_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*')),
  sent_assistant_event_id TEXT UNIQUE
    CHECK (sent_assistant_event_id IS NULL OR (length(sent_assistant_event_id) = 26 AND substr(sent_assistant_event_id, 1, 1) BETWEEN '0' AND '7' AND sent_assistant_event_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*')),
  delivered_assistant_event_id TEXT UNIQUE
    CHECK (delivered_assistant_event_id IS NULL OR (length(delivered_assistant_event_id) = 26 AND substr(delivered_assistant_event_id, 1, 1) BETWEEN '0' AND '7' AND delivered_assistant_event_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*')),
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
    'model_cancelled', 'model_failed', 'model_outcome_unknown', 'delivery_authentication',
    'delivery_permanent', 'delivery_idempotency_conflict', 'delivery_retry_exhausted', 'delivery_unknown'
  )),
  failure_category TEXT CHECK (failure_category IS NULL OR failure_category IN (
    'cancelled', 'provider', 'authentication', 'invalid_request', 'idempotency_conflict', 'ambiguous'
  )),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  CHECK (updated_at >= created_at),
  CHECK (
    (model_claim_token_hash IS NULL AND model_claimed_at IS NULL AND model_claim_expires_at IS NULL)
    OR (
      model_claim_token_hash IS NOT NULL AND model_claimed_at IS NOT NULL AND model_claim_expires_at IS NOT NULL
      AND model_claimed_at >= created_at
      AND model_claim_expires_at > model_claimed_at
      AND model_claim_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', model_claimed_at, '+45 seconds')
    )
  ),
  CHECK (resolved_at IS NULL OR (model_claimed_at IS NOT NULL AND resolved_at >= model_claimed_at)),
  CHECK (
    (state = 'user_committed'
      AND model_claim_token_hash IS NULL AND model_claimed_at IS NULL AND model_claim_expires_at IS NULL
      AND resolved_at IS NULL AND staged_delivery_id IS NULL AND sent_assistant_event_id IS NULL
      AND delivered_assistant_event_id IS NULL AND failure_code IS NULL AND failure_category IS NULL)
    OR
    (state = 'model_claimed'
      AND model_claim_token_hash IS NOT NULL AND model_claimed_at IS NOT NULL AND model_claim_expires_at IS NOT NULL
      AND resolved_at IS NULL AND staged_delivery_id IS NULL AND sent_assistant_event_id IS NULL
      AND delivered_assistant_event_id IS NULL AND failure_code IS NULL AND failure_category IS NULL)
    OR
    (state = 'assistant_staged'
      AND model_claim_token_hash IS NOT NULL AND model_claimed_at IS NOT NULL AND model_claim_expires_at IS NOT NULL
      AND resolved_at IS NOT NULL AND staged_delivery_id IS NOT NULL AND sent_assistant_event_id IS NULL
      AND delivered_assistant_event_id IS NULL AND failure_code IS NULL AND failure_category IS NULL)
    OR
    (state = 'voice_sent'
      AND model_claim_token_hash IS NOT NULL AND model_claimed_at IS NOT NULL AND model_claim_expires_at IS NOT NULL
      AND resolved_at IS NOT NULL AND staged_delivery_id IS NULL AND sent_assistant_event_id IS NOT NULL
      AND delivered_assistant_event_id IS NULL AND failure_code IS NULL AND failure_category IS NULL)
    OR
    (state = 'delivered'
      AND model_claim_token_hash IS NOT NULL AND model_claimed_at IS NOT NULL AND model_claim_expires_at IS NOT NULL
      AND resolved_at IS NOT NULL AND staged_delivery_id IS NOT NULL AND sent_assistant_event_id IS NULL
      AND delivered_assistant_event_id IS NOT NULL AND failure_code IS NULL AND failure_category IS NULL)
    OR
    (state = 'cancelled'
      AND model_claim_token_hash IS NOT NULL AND model_claimed_at IS NOT NULL AND model_claim_expires_at IS NOT NULL
      AND resolved_at IS NOT NULL AND staged_delivery_id IS NULL AND sent_assistant_event_id IS NULL
      AND delivered_assistant_event_id IS NULL AND failure_code = 'model_cancelled' AND failure_category = 'cancelled')
    OR
    (state = 'model_outcome_unknown'
      AND model_claim_token_hash IS NOT NULL AND model_claimed_at IS NOT NULL AND model_claim_expires_at IS NOT NULL
      AND resolved_at IS NOT NULL AND staged_delivery_id IS NULL AND sent_assistant_event_id IS NULL
      AND delivered_assistant_event_id IS NULL AND failure_code = 'model_outcome_unknown' AND failure_category = 'ambiguous')
    OR
    (state = 'delivery_unknown'
      AND model_claim_token_hash IS NOT NULL AND model_claimed_at IS NOT NULL AND model_claim_expires_at IS NOT NULL
      AND resolved_at IS NOT NULL AND staged_delivery_id IS NOT NULL AND sent_assistant_event_id IS NULL
      AND delivered_assistant_event_id IS NULL AND failure_code = 'delivery_unknown' AND failure_category = 'ambiguous')
    OR
    (state = 'failed'
      AND model_claim_token_hash IS NOT NULL AND model_claimed_at IS NOT NULL AND model_claim_expires_at IS NOT NULL
      AND resolved_at IS NOT NULL AND sent_assistant_event_id IS NULL AND delivered_assistant_event_id IS NULL
      AND failure_code IS NOT NULL AND failure_category IS NOT NULL)
  )
);

CREATE INDEX conversation_turns_principal_session_idx
  ON conversation_turns(principal_id, session_id, created_at DESC);
CREATE INDEX conversation_turns_state_expiry_idx
  ON conversation_turns(state, model_claim_expires_at);

CREATE TABLE conversation_deliveries (
  delivery_id TEXT NOT NULL PRIMARY KEY
    CHECK (length(delivery_id) = 26 AND substr(delivery_id, 1, 1) BETWEEN '0' AND '7' AND delivery_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'),
  correlation_id TEXT NOT NULL
    CHECK (length(correlation_id) = 26 AND substr(correlation_id, 1, 1) BETWEEN '0' AND '7' AND correlation_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'),
  turn_id TEXT UNIQUE
    CHECK (turn_id IS NULL OR (length(turn_id) = 26 AND substr(turn_id, 1, 1) BETWEEN '0' AND '7' AND turn_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*')),
  staged_event_id TEXT NOT NULL UNIQUE
    CHECK (length(staged_event_id) = 26 AND substr(staged_event_id, 1, 1) BETWEEN '0' AND '7' AND staged_event_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*'),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE RESTRICT,
  target_identity_id TEXT NOT NULL REFERENCES channel_identities(identity_id) ON DELETE RESTRICT,
  reply_to_message_id INTEGER CHECK (reply_to_message_id IS NULL OR (typeof(reply_to_message_id) = 'integer' AND reply_to_message_id > 0)),
  history_mode TEXT NOT NULL CHECK (history_mode IN ('assistant', 'system')),
  material_hash TEXT NOT NULL CHECK (length(material_hash) = 64 AND material_hash NOT GLOB '*[^0-9a-f]*'),
  provider_idempotency_key TEXT NOT NULL UNIQUE CHECK (length(provider_idempotency_key) BETWEEN 1 AND 128),
  state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'delivered', 'retry_wait', 'failed', 'unknown')),
  attempt_count INTEGER NOT NULL CHECK (typeof(attempt_count) = 'integer' AND attempt_count BETWEEN 0 AND 3),
  available_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', available_at) IS available_at),
  lease_token_hash TEXT CHECK (lease_token_hash IS NULL OR (length(lease_token_hash) = 64 AND lease_token_hash NOT GLOB '*[^0-9a-f]*')),
  claimed_at TEXT CHECK (claimed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at) IS claimed_at),
  lease_expires_at TEXT CHECK (lease_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at) IS lease_expires_at),
  resolved_at TEXT CHECK (resolved_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at) IS resolved_at),
  provider_message_id TEXT CHECK (provider_message_id IS NULL OR length(provider_message_id) BETWEEN 1 AND 128),
  delivered_assistant_event_id TEXT UNIQUE
    CHECK (delivered_assistant_event_id IS NULL OR (length(delivered_assistant_event_id) = 26 AND substr(delivered_assistant_event_id, 1, 1) BETWEEN '0' AND '7' AND delivered_assistant_event_id NOT GLOB '*[^0-9a-hjkmnp-tv-z]*')),
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
    'delivery_retry', 'delivery_authentication', 'delivery_permanent',
    'delivery_idempotency_conflict', 'delivery_retry_exhausted', 'delivery_unknown'
  )),
  failure_category TEXT CHECK (failure_category IS NULL OR failure_category IN (
    'provider', 'authentication', 'invalid_request', 'idempotency_conflict', 'ambiguous'
  )),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  CHECK (updated_at >= created_at AND available_at >= created_at),
  CHECK ((history_mode = 'assistant' AND turn_id IS NOT NULL AND correlation_id = turn_id) OR (history_mode = 'system' AND turn_id IS NULL)),
  CHECK (
    (claimed_at IS NULL AND lease_expires_at IS NULL AND lease_token_hash IS NULL)
    OR (
      claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_token_hash IS NOT NULL
      AND lease_expires_at > claimed_at
      AND lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at, '+30 seconds')
    )
  ),
  CHECK (resolved_at IS NULL OR (claimed_at IS NOT NULL AND resolved_at >= claimed_at)),
  CHECK (
    (state = 'pending' AND attempt_count = 0
      AND lease_token_hash IS NULL AND claimed_at IS NULL AND lease_expires_at IS NULL AND resolved_at IS NULL
      AND provider_message_id IS NULL AND delivered_assistant_event_id IS NULL
      AND failure_code IS NULL AND failure_category IS NULL)
    OR
    (state = 'claimed' AND attempt_count BETWEEN 1 AND 3
      AND lease_token_hash IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL AND resolved_at IS NULL
      AND provider_message_id IS NULL AND delivered_assistant_event_id IS NULL
      AND failure_code IS NULL AND failure_category IS NULL)
    OR
    (state = 'retry_wait' AND attempt_count BETWEEN 1 AND 2
      AND lease_token_hash IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL AND resolved_at IS NOT NULL
      AND provider_message_id IS NULL AND delivered_assistant_event_id IS NULL
      AND failure_code = 'delivery_retry' AND failure_category = 'provider')
    OR
    (state = 'delivered' AND attempt_count BETWEEN 1 AND 3
      AND lease_token_hash IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL AND resolved_at IS NOT NULL
      AND provider_message_id IS NOT NULL
      AND ((history_mode = 'assistant' AND delivered_assistant_event_id IS NOT NULL)
        OR (history_mode = 'system' AND delivered_assistant_event_id IS NULL))
      AND failure_code IS NULL AND failure_category IS NULL)
    OR
    (state IN ('failed', 'unknown') AND attempt_count BETWEEN 1 AND 3
      AND lease_token_hash IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL AND resolved_at IS NOT NULL
      AND provider_message_id IS NULL AND delivered_assistant_event_id IS NULL
      AND failure_code IS NOT NULL AND failure_category IS NOT NULL)
  )
);

CREATE INDEX conversation_deliveries_available_idx
  ON conversation_deliveries(state, available_at, delivery_id);
CREATE INDEX conversation_deliveries_target_idx
  ON conversation_deliveries(target_identity_id, state, available_at);

CREATE TRIGGER conversation_turns_insert_guard
BEFORE INSERT ON conversation_turns
WHEN NOT EXISTS (
  SELECT 1
  FROM principals p
  JOIN events e ON e.event_id = NEW.user_event_id
  WHERE p.principal_id = NEW.principal_id
    AND p.status = 'active'
    AND e.event_type = 'conversation.user_committed'
    AND e.subject_id = NEW.principal_id
    AND json_extract(e.envelope_json, '$.correlationId') = NEW.turn_id
    AND json_extract(e.envelope_json, '$.source') = 'conversation'
    AND json_extract(e.envelope_json, '$.producerVersion') = 'conversation-v1'
)
BEGIN
  SELECT RAISE(ABORT, 'conversation_turn_insert_invalid');
END;

CREATE TRIGGER conversation_turns_transition_guard
BEFORE UPDATE OF state ON conversation_turns
WHEN OLD.state IS NOT NEW.state AND NOT (
  (OLD.state = 'user_committed' AND NEW.state = 'model_claimed')
  OR (OLD.state = 'model_claimed' AND NEW.state IN ('assistant_staged', 'voice_sent', 'cancelled', 'failed', 'model_outcome_unknown'))
  OR (OLD.state = 'assistant_staged' AND NEW.state IN ('delivered', 'failed', 'delivery_unknown'))
)
BEGIN
  SELECT RAISE(ABORT, 'conversation_turn_transition_invalid');
END;

CREATE TRIGGER conversation_turns_immutable_guard
BEFORE UPDATE ON conversation_turns
WHEN OLD.turn_id IS NOT NEW.turn_id
  OR OLD.session_id IS NOT NEW.session_id
  OR OLD.principal_id IS NOT NEW.principal_id
  OR OLD.channel IS NOT NEW.channel
  OR OLD.request_hash IS NOT NEW.request_hash
  OR OLD.user_event_id IS NOT NEW.user_event_id
  OR OLD.created_at IS NOT NEW.created_at
  OR NEW.updated_at < OLD.updated_at
  OR (OLD.state IS NOT NEW.state AND NEW.updated_at < OLD.updated_at)
  OR (
    OLD.state <> 'user_committed'
    AND (
      OLD.model_claim_token_hash IS NOT NEW.model_claim_token_hash
      OR OLD.model_claimed_at IS NOT NEW.model_claimed_at
      OR OLD.model_claim_expires_at IS NOT NEW.model_claim_expires_at
    )
  )
  OR (OLD.staged_delivery_id IS NOT NULL AND OLD.staged_delivery_id IS NOT NEW.staged_delivery_id)
  OR (OLD.sent_assistant_event_id IS NOT NULL AND OLD.sent_assistant_event_id IS NOT NEW.sent_assistant_event_id)
  OR (OLD.delivered_assistant_event_id IS NOT NULL AND OLD.delivered_assistant_event_id IS NOT NEW.delivered_assistant_event_id)
  OR (OLD.failure_code IS NOT NULL AND OLD.failure_code IS NOT NEW.failure_code)
  OR (OLD.failure_category IS NOT NULL AND OLD.failure_category IS NOT NEW.failure_category)
BEGIN
  SELECT RAISE(ABORT, 'conversation_turn_immutable');
END;

CREATE TRIGGER conversation_turns_terminal_guard
BEFORE UPDATE ON conversation_turns
WHEN OLD.state IN ('voice_sent', 'delivered', 'cancelled', 'failed', 'model_outcome_unknown', 'delivery_unknown')
  AND (
    OLD.state IS NOT NEW.state OR OLD.resolved_at IS NOT NEW.resolved_at OR OLD.updated_at IS NOT NEW.updated_at
    OR OLD.staged_delivery_id IS NOT NEW.staged_delivery_id
    OR OLD.sent_assistant_event_id IS NOT NEW.sent_assistant_event_id
    OR OLD.delivered_assistant_event_id IS NOT NEW.delivered_assistant_event_id
    OR OLD.failure_code IS NOT NEW.failure_code OR OLD.failure_category IS NOT NEW.failure_category
  )
BEGIN
  SELECT RAISE(ABORT, 'conversation_turn_terminal_immutable');
END;

CREATE TRIGGER conversation_turns_reject_delete
BEFORE DELETE ON conversation_turns
BEGIN
  SELECT RAISE(ABORT, 'conversation_turn_delete_forbidden');
END;

CREATE TRIGGER conversation_deliveries_target_guard
BEFORE INSERT ON conversation_deliveries
WHEN NOT EXISTS (
  SELECT 1 FROM channel_identities i
  JOIN principals p ON p.principal_id = i.principal_id
  WHERE i.identity_id = NEW.target_identity_id
    AND i.principal_id = NEW.principal_id
    AND i.channel = 'telegram'
    AND i.status = 'active'
    AND i.verified_at IS NOT NULL
    AND p.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'conversation_delivery_target_invalid');
END;

CREATE TRIGGER conversation_deliveries_stage_guard
BEFORE INSERT ON conversation_deliveries
WHEN NOT EXISTS (
  SELECT 1 FROM events e
  WHERE e.event_id = NEW.staged_event_id
    AND e.subject_id = NEW.principal_id
    AND json_extract(e.envelope_json, '$.correlationId') = NEW.correlation_id
    AND json_extract(e.envelope_json, '$.source') = 'conversation'
    AND json_extract(e.envelope_json, '$.producerVersion') = 'conversation-v1'
    AND (
      (NEW.history_mode = 'assistant'
        AND e.event_type = 'conversation.assistant_staged'
        AND json_extract(e.envelope_json, '$.causationId') = (
          SELECT t.user_event_id FROM conversation_turns t
          WHERE t.turn_id = NEW.turn_id AND t.principal_id = NEW.principal_id AND t.state = 'model_claimed'
        ))
      OR
      (NEW.history_mode = 'system' AND e.event_type = 'conversation.system_staged')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'conversation_delivery_stage_invalid');
END;

CREATE TRIGGER conversation_deliveries_claim_target_guard
BEFORE UPDATE OF state ON conversation_deliveries
WHEN NEW.state = 'claimed' AND OLD.state IN ('pending', 'retry_wait') AND NOT EXISTS (
  SELECT 1 FROM channel_identities i
  JOIN principals p ON p.principal_id = i.principal_id
  WHERE i.identity_id = OLD.target_identity_id
    AND i.principal_id = OLD.principal_id
    AND i.channel = 'telegram'
    AND i.status = 'active'
    AND i.verified_at IS NOT NULL
    AND p.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'conversation_delivery_target_invalid');
END;

CREATE TRIGGER conversation_deliveries_transition_guard
BEFORE UPDATE OF state ON conversation_deliveries
WHEN OLD.state IS NOT NEW.state AND NOT (
  (OLD.state IN ('pending', 'retry_wait') AND NEW.state = 'claimed')
  OR (OLD.state = 'claimed' AND NEW.state IN ('delivered', 'retry_wait', 'failed', 'unknown'))
)
BEGIN
  SELECT RAISE(ABORT, 'conversation_delivery_transition_invalid');
END;

CREATE TRIGGER conversation_deliveries_immutable_guard
BEFORE UPDATE ON conversation_deliveries
WHEN OLD.delivery_id IS NOT NEW.delivery_id
  OR OLD.correlation_id IS NOT NEW.correlation_id
  OR OLD.turn_id IS NOT NEW.turn_id
  OR OLD.staged_event_id IS NOT NEW.staged_event_id
  OR OLD.principal_id IS NOT NEW.principal_id
  OR OLD.target_identity_id IS NOT NEW.target_identity_id
  OR OLD.reply_to_message_id IS NOT NEW.reply_to_message_id
  OR OLD.history_mode IS NOT NEW.history_mode
  OR OLD.material_hash IS NOT NEW.material_hash
  OR OLD.provider_idempotency_key IS NOT NEW.provider_idempotency_key
  OR OLD.created_at IS NOT NEW.created_at
  OR NEW.updated_at < OLD.updated_at
  OR (OLD.state IS NOT NEW.state AND NEW.updated_at < OLD.updated_at)
  OR (
    OLD.state = 'claimed'
    AND (
      OLD.attempt_count IS NOT NEW.attempt_count
      OR OLD.lease_token_hash IS NOT NEW.lease_token_hash
      OR OLD.claimed_at IS NOT NEW.claimed_at
      OR OLD.lease_expires_at IS NOT NEW.lease_expires_at
    )
  )
  OR (OLD.provider_message_id IS NOT NULL AND OLD.provider_message_id IS NOT NEW.provider_message_id)
  OR (OLD.delivered_assistant_event_id IS NOT NULL AND OLD.delivered_assistant_event_id IS NOT NEW.delivered_assistant_event_id)
BEGIN
  SELECT RAISE(ABORT, 'conversation_delivery_immutable');
END;

CREATE TRIGGER conversation_deliveries_terminal_guard
BEFORE UPDATE ON conversation_deliveries
WHEN OLD.state IN ('delivered', 'failed', 'unknown')
  AND (
    OLD.state IS NOT NEW.state OR OLD.attempt_count IS NOT NEW.attempt_count
    OR OLD.available_at IS NOT NEW.available_at OR OLD.lease_token_hash IS NOT NEW.lease_token_hash
    OR OLD.claimed_at IS NOT NEW.claimed_at OR OLD.lease_expires_at IS NOT NEW.lease_expires_at
    OR OLD.resolved_at IS NOT NEW.resolved_at OR OLD.provider_message_id IS NOT NEW.provider_message_id
    OR OLD.delivered_assistant_event_id IS NOT NEW.delivered_assistant_event_id
    OR OLD.failure_code IS NOT NEW.failure_code OR OLD.failure_category IS NOT NEW.failure_category
    OR OLD.updated_at IS NOT NEW.updated_at
  )
BEGIN
  SELECT RAISE(ABORT, 'conversation_delivery_terminal_immutable');
END;

CREATE TRIGGER conversation_deliveries_reject_delete
BEFORE DELETE ON conversation_deliveries
BEGIN
  SELECT RAISE(ABORT, 'conversation_delivery_delete_forbidden');
END;

CREATE TRIGGER events_conversation_transition_guard
BEFORE INSERT ON events
WHEN NEW.event_type IN (
  'conversation.assistant_sent', 'conversation.turn_cancelled', 'conversation.turn_failed',
  'conversation.assistant_delivered', 'conversation.system_delivered',
  'conversation.delivery_retry', 'conversation.delivery_failed', 'conversation.delivery_unknown'
)
AND NOT (
  (
    NEW.event_type = 'conversation.turn_failed'
    AND json_extract(NEW.envelope_json, '$.payload.failureCode') = 1
    AND NOT EXISTS (
      SELECT 1 FROM conversation_turns t
      WHERE t.turn_id = json_extract(NEW.envelope_json, '$.correlationId')
    )
  )
  OR
  (
    NEW.event_type IN ('conversation.assistant_sent', 'conversation.turn_cancelled', 'conversation.turn_failed')
    AND EXISTS (
      SELECT 1 FROM conversation_turns t
      WHERE t.turn_id = json_extract(NEW.envelope_json, '$.correlationId')
        AND t.principal_id = NEW.subject_id
        AND t.state = 'model_claimed'
        AND json_extract(NEW.envelope_json, '$.causationId') = t.user_event_id
    )
  )
  OR
  (
    NEW.event_type IN (
      'conversation.assistant_delivered', 'conversation.system_delivered',
      'conversation.delivery_retry', 'conversation.delivery_failed', 'conversation.delivery_unknown'
    )
    AND EXISTS (
      SELECT 1 FROM conversation_deliveries d
      WHERE d.staged_event_id = json_extract(NEW.envelope_json, '$.causationId')
        AND d.correlation_id = json_extract(NEW.envelope_json, '$.correlationId')
        AND d.principal_id = NEW.subject_id
        AND d.state = 'claimed'
        AND (
          (NEW.event_type = 'conversation.assistant_delivered' AND d.history_mode = 'assistant')
          OR (NEW.event_type = 'conversation.system_delivered' AND d.history_mode = 'system')
          OR NEW.event_type IN ('conversation.delivery_retry', 'conversation.delivery_failed', 'conversation.delivery_unknown')
        )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'conversation_event_transition_invalid');
END;

CREATE TRIGGER channel_identities_conversation_lineage_immutable
BEFORE UPDATE OF principal_id, channel ON channel_identities
WHEN (OLD.principal_id IS NOT NEW.principal_id OR OLD.channel IS NOT NEW.channel)
  AND EXISTS (SELECT 1 FROM conversation_deliveries d WHERE d.target_identity_id = OLD.identity_id)
BEGIN
  SELECT RAISE(ABORT, 'conversation_delivery_identity_immutable');
END;
