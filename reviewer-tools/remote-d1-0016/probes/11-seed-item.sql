INSERT INTO memory_items (item_id, principal_id, kind, creation_event_id, creation_event_sequence, created_at)
VALUES ('01k3wpm0000000000000000001', 'principal:proof:0016', 'preference', '01k3wpe0000000000000000001', (SELECT sequence FROM events WHERE event_id = '01k3wpe0000000000000000001'), '2026-09-14T00:01:00.000Z');

INSERT INTO memory_item_versions (version_id, principal_id, item_id, version_number, text, text_normalization, text_hash, basis, origin, uncertain, sensitivity, valid_from, valid_to, extractor_version, extractor_model_id, created_at)
VALUES ('01k3wpn0000000000000000001', 'principal:proof:0016', '01k3wpm0000000000000000001', 1, 'I prefer short reports.', 'NFC', 'a000000000000000000000000000000000000000000000000000000000000001', 'stated', 'authenticated_first_person', 0, 'normal', NULL, NULL, 'policy-v1', NULL, '2026-09-14T00:01:00.000Z');

INSERT INTO memory_item_sources (source_id, principal_id, item_id, version_id, source_position, event_id, event_sequence, source_location, r2_segment_id, excerpt, excerpt_hash, channel, occurred_at, created_at)
VALUES ('01k3wps0000000000000000001', 'principal:proof:0016', '01k3wpm0000000000000000001', '01k3wpn0000000000000000001', 0, '01k3wpe0000000000000000001', (SELECT sequence FROM events WHERE event_id = '01k3wpe0000000000000000001'), 'live', NULL, 'I prefer short reports.', 'b000000000000000000000000000000000000000000000000000000000000001', 'telegram', '2026-09-14T00:01:00.000Z', '2026-09-14T00:01:00.000Z');

INSERT INTO memory_item_transitions (transition_id, principal_id, item_id, transition_number, version_id, lifecycle_state, reason, actor, policy_version, owner_authorizing_event_id, occurred_at)
VALUES ('01k3wpr0000000000000000001', 'principal:proof:0016', '01k3wpm0000000000000000001', 1, '01k3wpn0000000000000000001', 'proposed', 'proof proposal', 'rules', 'policy-v1', NULL, '2026-09-14T00:01:00.000Z');
