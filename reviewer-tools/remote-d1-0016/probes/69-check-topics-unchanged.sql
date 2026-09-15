SELECT (
  (SELECT count(*) FROM memory_topics WHERE principal_id = 'principal:proof:0016') = 90
  AND (SELECT count(*) FROM memory_topic_events WHERE principal_id = 'principal:proof:0016') = 95
  AND (SELECT count(*) FROM memory_topic_aliases WHERE principal_id = 'principal:proof:0016') = 1
  AND (SELECT parent_topic_id || '|' || last_topic_event_id FROM memory_topics WHERE principal_id = 'principal:proof:0016' AND topic_id = '01k3wpf0000000000000000003') = '01k3wpf0000000000000000001|01k3wpv0000000000000000312'
  AND (SELECT parent_topic_id || '|' || last_topic_event_id FROM memory_topics WHERE principal_id = 'principal:proof:0016' AND topic_id = '01k3wpf0000000000000000002') = '01k3wpf0000000000000000003|01k3wpv0000000000000000313'
  AND (SELECT parent_topic_id || '|' || status || '|' || last_topic_event_id FROM memory_topics WHERE principal_id = 'principal:proof:0016' AND topic_id = '01k3wpf0000000000000000001') = '01k3wpa0000000000000000001|active|01k3wpv0000000000000000301'
  AND (SELECT parent_topic_id || '|' || last_topic_event_id FROM memory_topics WHERE principal_id = 'principal:proof:0016' AND topic_id = '01k3wpb0000000000000000002') = '01k3wpa0000000000000000045|01k3wpv0000000000000000501'
  AND (SELECT count(*) FROM memory_topics WHERE topic_id = '01k3wpa0000000000000000065') = 0
) AS ok;
