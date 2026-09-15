SELECT (
  (SELECT current_event_sequence FROM memory_cursors WHERE principal_id = 'principal:proof:0016' AND cursor_name = 'fts_items') = 5
  AND (SELECT group_concat(price_id) FROM memory_model_prices WHERE principal_id = 'principal:proof:0016') = '01k3wpy0000000000000000001'
  AND (SELECT count(*) FROM memory_item_versions WHERE principal_id = 'principal:proof:0016' AND item_id = '01k3wpm0000000000000000001') = 1
  AND (SELECT lifecycle_state || '|' || last_transition_number FROM memory_item_state WHERE principal_id = 'principal:proof:0016' AND item_id = '01k3wpm0000000000000000001') = 'superseded|3'
  AND (SELECT count(*) FROM memory_topics WHERE principal_id = 'principal:proof:0016') = 90
  AND (SELECT count(*) FROM memory_topic_events WHERE principal_id = 'principal:proof:0016') = 93
  AND (SELECT parent_topic_id FROM memory_topics WHERE principal_id = 'principal:proof:0016' AND topic_id = '01k3wpf0000000000000000001') = '01k3wpa0000000000000000001'
  AND (SELECT parent_topic_id || '|' || last_topic_event_id FROM memory_topics WHERE principal_id = 'principal:proof:0016' AND topic_id = '01k3wpf0000000000000000002') = '01k3wpf0000000000000000003|01k3wpv0000000000000000313'
) AS ok;
