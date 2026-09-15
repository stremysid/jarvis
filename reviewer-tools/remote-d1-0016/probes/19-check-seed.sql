WITH RECURSIVE chain(topic_id, depth) AS (
  SELECT topic_id, 1 FROM memory_topics WHERE principal_id = 'principal:proof:0016' AND parent_topic_id IS NULL
  UNION ALL
  SELECT child.topic_id, chain.depth + 1 FROM memory_topics child
  JOIN chain ON child.parent_topic_id = chain.topic_id
  WHERE child.principal_id = 'principal:proof:0016' AND chain.depth < 100
)
SELECT (
  (SELECT count(*) FROM memory_topics WHERE principal_id = 'principal:proof:0016') = 90
  AND (SELECT count(*) FROM memory_topic_events WHERE principal_id = 'principal:proof:0016') = 93
  AND (SELECT max(depth) FROM chain) = 64
  AND (SELECT lifecycle_state || '|' || last_transition_number FROM memory_item_state WHERE principal_id = 'principal:proof:0016' AND item_id = '01k3wpm0000000000000000001') = 'proposed|1'
  AND (SELECT parent_topic_id FROM memory_topics WHERE principal_id = 'principal:proof:0016' AND topic_id = '01k3wpf0000000000000000002') = '01k3wpf0000000000000000003'
  AND (SELECT parent_topic_id || '|' || last_topic_event_id FROM memory_topics WHERE principal_id = 'principal:proof:0016' AND topic_id = '01k3wpf0000000000000000003') = '01k3wpf0000000000000000001|01k3wpv0000000000000000312'
  AND (SELECT count(*) FROM memory_item_placement_state WHERE principal_id = 'principal:proof:0016' AND topic_id = '01k3wpd0000000000000000002' AND status = 'active') = 1
  AND (SELECT current_event_sequence FROM memory_cursors WHERE principal_id = 'principal:proof:0016' AND cursor_name = 'fts_items') = 5
  AND (SELECT count(*) FROM memory_model_prices WHERE principal_id = 'principal:proof:0016') = 1
) AS ok,
  (SELECT count(*) FROM memory_topics WHERE principal_id = 'principal:proof:0016') AS topics,
  (SELECT max(depth) FROM chain) AS max_depth;
