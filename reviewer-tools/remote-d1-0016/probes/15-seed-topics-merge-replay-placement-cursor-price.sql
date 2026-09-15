INSERT INTO memory_topic_events (topic_event_id, principal_id, topic_id, operation, new_parent_topic_id, new_display_name, new_normalized_name, reparented_child_ids_json, moved_placement_ids_json, added_aliases_json, reason, actor, occurred_at)
VALUES ('01k3wpv0000000000000000202', 'principal:proof:0016', '01k3wpd0000000000000000002', 'create', '01k3wpa0000000000000000001', 'Merge source', 'merge source', '[]', '[]', '[]', 'proof topic event', 'rules', '2026-09-14T00:10:00.000Z');

INSERT INTO memory_topic_events (topic_event_id, principal_id, topic_id, operation, new_parent_topic_id, new_display_name, new_normalized_name, reparented_child_ids_json, moved_placement_ids_json, added_aliases_json, reason, actor, occurred_at)
VALUES ('01k3wpv0000000000000000203', 'principal:proof:0016', '01k3wpd0000000000000000003', 'create', '01k3wpd0000000000000000002', 'Merge child one', 'merge child one', '[]', '[]', '[]', 'proof topic event', 'rules', '2026-09-14T00:10:00.000Z');

INSERT INTO memory_topic_events (topic_event_id, principal_id, topic_id, operation, new_parent_topic_id, new_display_name, new_normalized_name, reparented_child_ids_json, moved_placement_ids_json, added_aliases_json, reason, actor, occurred_at)
VALUES ('01k3wpv0000000000000000204', 'principal:proof:0016', '01k3wpd0000000000000000004', 'create', '01k3wpd0000000000000000002', 'Merge child two', 'merge child two', '[]', '[]', '[]', 'proof topic event', 'rules', '2026-09-14T00:10:00.000Z');

INSERT INTO memory_topic_events (topic_event_id, principal_id, topic_id, operation, new_parent_topic_id, new_display_name, new_normalized_name, reparented_child_ids_json, moved_placement_ids_json, added_aliases_json, reason, actor, occurred_at)
VALUES ('01k3wpv0000000000000000205', 'principal:proof:0016', '01k3wpd0000000000000000005', 'create', '01k3wpd0000000000000000003', 'Merge grandchild', 'merge grandchild', '[]', '[]', '[]', 'proof topic event', 'rules', '2026-09-14T00:10:00.000Z');

INSERT INTO memory_topic_events (topic_event_id, principal_id, topic_id, operation, new_parent_topic_id, new_display_name, new_normalized_name, reparented_child_ids_json, moved_placement_ids_json, added_aliases_json, reason, actor, occurred_at)
VALUES ('01k3wpv0000000000000000301', 'principal:proof:0016', '01k3wpf0000000000000000001', 'create', '01k3wpa0000000000000000001', 'Replay zero', 'replay zero', '[]', '[]', '[]', 'proof topic event', 'rules', '2026-09-14T00:10:00.000Z');

INSERT INTO memory_topic_events (topic_event_id, principal_id, topic_id, operation, new_parent_topic_id, new_display_name, new_normalized_name, reparented_child_ids_json, moved_placement_ids_json, added_aliases_json, reason, actor, occurred_at)
VALUES ('01k3wpv0000000000000000302', 'principal:proof:0016', '01k3wpf0000000000000000002', 'create', '01k3wpa0000000000000000001', 'Replay one', 'replay one', '[]', '[]', '[]', 'proof topic event', 'rules', '2026-09-14T00:10:00.000Z');

INSERT INTO memory_topic_events (topic_event_id, principal_id, topic_id, operation, new_parent_topic_id, new_display_name, new_normalized_name, reparented_child_ids_json, moved_placement_ids_json, added_aliases_json, reason, actor, occurred_at)
VALUES ('01k3wpv0000000000000000303', 'principal:proof:0016', '01k3wpf0000000000000000003', 'create', '01k3wpf0000000000000000001', 'Replay topic', 'replay topic', '[]', '[]', '[]', 'proof topic event', 'rules', '2026-09-14T00:10:00.000Z');

INSERT INTO memory_topic_events (topic_event_id, principal_id, topic_id, operation, previous_parent_topic_id, new_parent_topic_id, reparented_child_ids_json, moved_placement_ids_json, added_aliases_json, reason, actor, occurred_at)
VALUES ('01k3wpv0000000000000000311', 'principal:proof:0016', '01k3wpf0000000000000000003', 'move', '01k3wpf0000000000000000001', '01k3wpf0000000000000000002', '[]', '[]', '[]', 'proof topic event', 'rules', '2026-09-14T00:10:00.000Z');

INSERT INTO memory_topic_events (topic_event_id, principal_id, topic_id, operation, previous_parent_topic_id, new_parent_topic_id, reparented_child_ids_json, moved_placement_ids_json, added_aliases_json, reason, actor, occurred_at)
VALUES ('01k3wpv0000000000000000312', 'principal:proof:0016', '01k3wpf0000000000000000003', 'move', '01k3wpf0000000000000000002', '01k3wpf0000000000000000001', '[]', '[]', '[]', 'proof topic event', 'rules', '2026-09-14T00:10:00.000Z');

INSERT INTO memory_topic_events (topic_event_id, principal_id, topic_id, operation, previous_parent_topic_id, new_parent_topic_id, reparented_child_ids_json, moved_placement_ids_json, added_aliases_json, reason, actor, occurred_at)
VALUES ('01k3wpv0000000000000000313', 'principal:proof:0016', '01k3wpf0000000000000000002', 'move', '01k3wpa0000000000000000001', '01k3wpf0000000000000000003', '[]', '[]', '[]', 'proof topic event', 'rules', '2026-09-14T00:10:00.000Z');

INSERT INTO memory_item_placement_events (placement_event_id, principal_id, placement_id, placement_event_number, item_id, operation, previous_topic_id, new_topic_id, relation, filing_source, confidence, reason, owner_authorizing_event_id, occurred_at)
VALUES ('01k3wpq0000000000000000001', 'principal:proof:0016', '01k3wpp0000000000000000001', 1, '01k3wpm0000000000000000001', 'place', NULL, '01k3wpd0000000000000000002', 'related', 'rule', 1, 'proof placement', NULL, '2026-09-14T00:10:00.000Z');

INSERT INTO memory_cursors (principal_id, cursor_name, current_event_sequence, updated_at)
VALUES ('principal:proof:0016', 'fts_items', 5, '2026-09-14T00:00:05.000Z');

INSERT INTO memory_model_prices (price_id, principal_id, provider, model_id, effective_at, input_micros_per_million, output_micros_per_million, cache_read_micros_per_million, currency, source_receipt, created_at)
VALUES ('01k3wpy0000000000000000001', 'principal:proof:0016', 'deepseek', 'deepseek:deepseek-v4-pro', '2026-09-14T00:00:00.000Z', 1, 1, 0, 'USD', 'proof price', '2026-09-14T00:00:00.000Z');
