INSERT INTO events (event_id, event_type, source, subject_id, occurred_at, received_at, content_hash, envelope_json, created_at)
VALUES ('01k3wpe0000000000000000003', 'conversation.user_committed', 'jarvis.conversation', 'principal:proof:0016', '2026-09-14T00:00:07.000Z', '2026-09-14T00:00:07.000Z', 'e000000000000000000000000000000000000000000000000000000000000003', '{}', '2026-09-14T00:00:07.000Z');

INSERT INTO events (event_id, event_type, source, subject_id, occurred_at, received_at, content_hash, envelope_json, created_at)
VALUES ('01k3wpe0000000000000000004', 'conversation.user_committed', 'jarvis.conversation', 'principal:proof:0016', '2026-09-14T00:00:08.000Z', '2026-09-14T00:00:08.000Z', 'e000000000000000000000000000000000000000000000000000000000000004', '{}', '2026-09-14T00:00:08.000Z');

INSERT INTO memory_items (item_id, principal_id, kind, creation_event_id, creation_event_sequence, created_at)
VALUES ('01k3wpm0000000000000000002', 'principal:proof:0016', 'preference', '01k3wpe0000000000000000002', (SELECT sequence FROM events WHERE event_id = '01k3wpe0000000000000000002'), '2026-09-14T00:04:00.000Z');

INSERT INTO memory_item_versions (version_id, principal_id, item_id, version_number, text, text_normalization, text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to, extractor_version, extractor_model_id, created_at)
VALUES ('01k3wpn0000000000000000003', 'principal:proof:0016', '01k3wpm0000000000000000002', 1, 'I prefer short reports.', 'NFC', 'a000000000000000000000000000000000000000000000000000000000000003', 'stated', 'authenticated_first_person', 0, 'normal', NULL, '2026-10-01T00:00:00.000Z', 'policy-v1', NULL, '2026-09-14T00:04:00.000Z');

INSERT INTO memory_item_sources (source_id, principal_id, item_id, version_id, source_position, event_id, event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash, channel, occurred_at, created_at)
VALUES ('01k3wps0000000000000000002', 'principal:proof:0016', '01k3wpm0000000000000000002', '01k3wpn0000000000000000003', 0, '01k3wpe0000000000000000002', (SELECT sequence FROM events WHERE event_id = '01k3wpe0000000000000000002'), 'live', NULL, 'I prefer short reports.', 'b000000000000000000000000000000000000000000000000000000000000002', 'telegram', '2026-09-14T00:04:00.000Z', '2026-09-14T00:04:00.000Z');

INSERT INTO memory_item_transitions (transition_id, principal_id, item_id, transition_number, version_id, lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at)
VALUES ('01k3wpr0000000000000000004', 'principal:proof:0016', '01k3wpm0000000000000000002', 1, '01k3wpn0000000000000000003', 'proposed', 'proof proposal', 'rules', 'policy-v1', NULL, '2026-09-14T00:04:00.000Z');

INSERT INTO memory_items (item_id, principal_id, kind, creation_event_id, creation_event_sequence, created_at)
VALUES ('01k3wpm0000000000000000003', 'principal:proof:0016', 'preference', '01k3wpe0000000000000000003', (SELECT sequence FROM events WHERE event_id = '01k3wpe0000000000000000003'), '2026-09-14T00:04:00.000Z');

INSERT INTO memory_item_versions (version_id, principal_id, item_id, version_number, text, text_normalization, text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to, extractor_version, extractor_model_id, created_at)
VALUES ('01k3wpn0000000000000000004', 'principal:proof:0016', '01k3wpm0000000000000000003', 1, 'I prefer short reports.', 'NFC', 'a000000000000000000000000000000000000000000000000000000000000004', 'stated', 'authenticated_first_person', 0, 'normal', NULL, NULL, 'policy-v1', NULL, '2026-09-14T00:04:00.000Z');

INSERT INTO memory_item_sources (source_id, principal_id, item_id, version_id, source_position, event_id, event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash, channel, occurred_at, created_at)
VALUES ('01k3wps0000000000000000003', 'principal:proof:0016', '01k3wpm0000000000000000003', '01k3wpn0000000000000000004', 0, '01k3wpe0000000000000000003', (SELECT sequence FROM events WHERE event_id = '01k3wpe0000000000000000003'), 'live', NULL, 'I prefer short reports.', 'b000000000000000000000000000000000000000000000000000000000000003', 'telegram', '2026-09-14T00:04:00.000Z', '2026-09-14T00:04:00.000Z');

INSERT INTO memory_item_transitions (transition_id, principal_id, item_id, transition_number, version_id, lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at)
VALUES ('01k3wpr0000000000000000007', 'principal:proof:0016', '01k3wpm0000000000000000003', 1, '01k3wpn0000000000000000004', 'proposed', 'proof proposal', 'rules', 'policy-v1', NULL, '2026-09-14T00:04:00.000Z');

INSERT INTO memory_items (item_id, principal_id, kind, creation_event_id, creation_event_sequence, created_at)
VALUES ('01k3wpm0000000000000000004', 'principal:proof:0016', 'preference', '01k3wpe0000000000000000004', (SELECT sequence FROM events WHERE event_id = '01k3wpe0000000000000000004'), '2026-09-14T00:04:00.000Z');

INSERT INTO memory_item_versions (version_id, principal_id, item_id, version_number, text, text_normalization, text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to, extractor_version, extractor_model_id, created_at)
VALUES ('01k3wpn0000000000000000005', 'principal:proof:0016', '01k3wpm0000000000000000004', 1, 'I prefer short reports.', 'NFC', 'a000000000000000000000000000000000000000000000000000000000000005', 'stated', 'authenticated_first_person', 0, 'normal', NULL, '2026-09-14T00:30:00.000Z', 'policy-v1', NULL, '2026-09-14T00:04:00.000Z');

INSERT INTO memory_item_sources (source_id, principal_id, item_id, version_id, source_position, event_id, event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash, channel, occurred_at, created_at)
VALUES ('01k3wps0000000000000000004', 'principal:proof:0016', '01k3wpm0000000000000000004', '01k3wpn0000000000000000005', 0, '01k3wpe0000000000000000004', (SELECT sequence FROM events WHERE event_id = '01k3wpe0000000000000000004'), 'live', NULL, 'I prefer short reports.', 'b000000000000000000000000000000000000000000000000000000000000004', 'telegram', '2026-09-14T00:04:00.000Z', '2026-09-14T00:04:00.000Z');

INSERT INTO memory_item_transitions (transition_id, principal_id, item_id, transition_number, version_id, lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at)
VALUES ('01k3wpr0000000000000000010', 'principal:proof:0016', '01k3wpm0000000000000000004', 1, '01k3wpn0000000000000000005', 'proposed', 'proof proposal', 'rules', 'policy-v1', NULL, '2026-09-14T00:04:00.000Z');

INSERT INTO events (event_id, event_type, source, subject_id, occurred_at, received_at, content_hash, envelope_json, created_at)
VALUES ('01k3wpc0000000000000000005', 'memory.owner_command', 'memory-control', 'principal:proof:0016', '2026-09-14T00:00:09.000Z', '2026-09-14T00:00:09.000Z', 'c000000000000000000000000000000000000000000000000000000000000005', '{"eventId":"01k3wpc0000000000000000005","correlationId":"01k3wpc0000000000000000005","eventType":"memory.owner_command","source":"memory-control","subjectId":"principal:proof:0016","occurredAt":"2026-09-14T00:00:09.000Z","receivedAt":"2026-09-14T00:00:09.000Z","contentHash":"c000000000000000000000000000000000000000000000000000000000000005","producerVersion":"memory-control-v1","payload":{"operation":"item.transition","targetId":"01k3wpr0000000000000000005","itemId":"01k3wpm0000000000000000002","versionId":"01k3wpn0000000000000000003","lifecycleState":"active"}}', '2026-09-14T00:00:09.000Z');

INSERT INTO events (event_id, event_type, source, subject_id, occurred_at, received_at, content_hash, envelope_json, created_at)
VALUES ('01k3wpc0000000000000000006', 'memory.owner_command', 'memory-control', 'principal:proof:0016', '2026-09-14T00:00:10.000Z', '2026-09-14T00:00:10.000Z', 'c000000000000000000000000000000000000000000000000000000000000006', '{"eventId":"01k3wpc0000000000000000006","correlationId":"01k3wpc0000000000000000006","eventType":"memory.owner_command","source":"memory-control","subjectId":"principal:proof:0016","occurredAt":"2026-09-14T00:00:10.000Z","receivedAt":"2026-09-14T00:00:10.000Z","contentHash":"c000000000000000000000000000000000000000000000000000000000000006","producerVersion":"memory-control-v1","payload":{"operation":"item.transition","targetId":"01k3wpr0000000000000000008","itemId":"01k3wpm0000000000000000003","versionId":"01k3wpn0000000000000000004","lifecycleState":"active"}}', '2026-09-14T00:00:10.000Z');

INSERT INTO events (event_id, event_type, source, subject_id, occurred_at, received_at, content_hash, envelope_json, created_at)
VALUES ('01k3wpc0000000000000000007', 'memory.owner_command', 'memory-control', 'principal:proof:0016', '2026-09-14T00:00:11.000Z', '2026-09-14T00:00:11.000Z', 'c000000000000000000000000000000000000000000000000000000000000007', '{"eventId":"01k3wpc0000000000000000007","correlationId":"01k3wpc0000000000000000007","eventType":"memory.owner_command","source":"memory-control","subjectId":"principal:proof:0016","occurredAt":"2026-09-14T00:00:11.000Z","receivedAt":"2026-09-14T00:00:11.000Z","contentHash":"c000000000000000000000000000000000000000000000000000000000000007","producerVersion":"memory-control-v1","payload":{"operation":"item.transition","targetId":"01k3wpr0000000000000000009","itemId":"01k3wpm0000000000000000003","versionId":"01k3wpn0000000000000000004","lifecycleState":"expired"}}', '2026-09-14T00:00:11.000Z');

INSERT INTO events (event_id, event_type, source, subject_id, occurred_at, received_at, content_hash, envelope_json, created_at)
VALUES ('01k3wpc0000000000000000008', 'memory.owner_command', 'memory-control', 'principal:proof:0016', '2026-09-14T00:00:12.000Z', '2026-09-14T00:00:12.000Z', 'c000000000000000000000000000000000000000000000000000000000000008', '{"eventId":"01k3wpc0000000000000000008","correlationId":"01k3wpc0000000000000000008","eventType":"memory.owner_command","source":"memory-control","subjectId":"principal:proof:0016","occurredAt":"2026-09-14T00:00:12.000Z","receivedAt":"2026-09-14T00:00:12.000Z","contentHash":"c000000000000000000000000000000000000000000000000000000000000008","producerVersion":"memory-control-v1","payload":{"operation":"item.transition","targetId":"01k3wpr0000000000000000011","itemId":"01k3wpm0000000000000000004","versionId":"01k3wpn0000000000000000005","lifecycleState":"active"}}', '2026-09-14T00:00:12.000Z');

INSERT INTO memory_item_transitions (transition_id, principal_id, item_id, transition_number, version_id, lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at)
VALUES ('01k3wpr0000000000000000005', 'principal:proof:0016', '01k3wpm0000000000000000002', 2, '01k3wpn0000000000000000003', 'active', 'proof owner active', 'owner', 'policy-v1', '01k3wpc0000000000000000005', '2026-09-14T00:05:00.000Z');

INSERT INTO memory_item_transitions (transition_id, principal_id, item_id, transition_number, version_id, lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at)
VALUES ('01k3wpr0000000000000000008', 'principal:proof:0016', '01k3wpm0000000000000000003', 2, '01k3wpn0000000000000000004', 'active', 'proof owner active', 'owner', 'policy-v1', '01k3wpc0000000000000000006', '2026-09-14T00:05:00.000Z');

INSERT INTO memory_item_transitions (transition_id, principal_id, item_id, transition_number, version_id, lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at)
VALUES ('01k3wpr0000000000000000011', 'principal:proof:0016', '01k3wpm0000000000000000004', 2, '01k3wpn0000000000000000005', 'active', 'proof owner active', 'owner', 'policy-v1', '01k3wpc0000000000000000008', '2026-09-14T00:05:00.000Z');
