SELECT (
  (SELECT display_name || '|' || last_topic_event_id FROM memory_topics WHERE principal_id = 'principal:proof:0016' AND topic_id = '01k3wpb0000000000000000020') = 'Branch twenty|01k3wpv0000000000000000510'
  AND (SELECT count(*) FROM memory_topic_aliases WHERE principal_id = 'principal:proof:0016') = 2
  AND (SELECT group_concat(run_id || '|' || outcome) FROM memory_runs WHERE principal_id = 'principal:proof:0016') = '01k3wpx0000000000000000001|running'
) AS ok;
