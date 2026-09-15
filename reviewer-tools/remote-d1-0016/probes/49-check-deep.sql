WITH RECURSIVE up(topic_id, parent_topic_id, depth) AS (
  SELECT topic_id, parent_topic_id, 1 FROM memory_topics WHERE principal_id = 'principal:proof:0016' AND topic_id = '01k3wpb0000000000000000020'
  UNION ALL
  SELECT t.topic_id, t.parent_topic_id, up.depth + 1 FROM memory_topics t
  JOIN up ON t.principal_id = 'principal:proof:0016' AND t.topic_id = up.parent_topic_id
  WHERE up.depth < 100
)
SELECT (
  (SELECT max(depth) FROM up) = 64
  AND (SELECT parent_topic_id || '|' || last_topic_event_id FROM memory_topics WHERE principal_id = 'principal:proof:0016' AND topic_id = '01k3wpb0000000000000000002') = '01k3wpa0000000000000000045|01k3wpv0000000000000000501'
  AND (SELECT status || '|' || redirect_to_topic_id || '|' || last_topic_event_id || '|' || parent_topic_id FROM memory_topics WHERE principal_id = 'principal:proof:0016' AND topic_id = '01k3wpd0000000000000000002') = 'merged|01k3wpa0000000000000000060|01k3wpv0000000000000000502|01k3wpa0000000000000000001'
  AND (SELECT count(*) FROM memory_topics WHERE principal_id = 'principal:proof:0016' AND topic_id IN ('01k3wpd0000000000000000003', '01k3wpd0000000000000000004') AND parent_topic_id = '01k3wpa0000000000000000060' AND last_topic_event_id = '01k3wpv0000000000000000502') = 2
  AND (SELECT parent_topic_id || '|' || last_topic_event_id FROM memory_topics WHERE principal_id = 'principal:proof:0016' AND topic_id = '01k3wpd0000000000000000005') = '01k3wpd0000000000000000003|01k3wpv0000000000000000205'
  AND (SELECT count(*) FROM memory_topic_aliases WHERE principal_id = 'principal:proof:0016') = 1
  AND (SELECT topic_id || '|' || created_by_topic_event_id FROM memory_topic_aliases WHERE alias_id = '01k3wpk0000000000000000001') = '01k3wpa0000000000000000060|01k3wpv0000000000000000502'
  AND (SELECT topic_id || '|' || last_event_kind || '|' || last_event_id || '|' || last_placement_event_number || '|' || status FROM memory_item_placement_state WHERE principal_id = 'principal:proof:0016' AND placement_id = '01k3wpp0000000000000000001') = '01k3wpa0000000000000000060|topic|01k3wpv0000000000000000502|1|active'
  AND (SELECT count(*) FROM memory_topics WHERE principal_id = 'principal:proof:0016') = 90
  AND (SELECT count(*) FROM memory_topic_events WHERE principal_id = 'principal:proof:0016') = 95
) AS ok,
  (SELECT max(depth) FROM up) AS b20_depth,
  (SELECT count(*) FROM memory_topic_events WHERE principal_id = 'principal:proof:0016') AS topic_events;
