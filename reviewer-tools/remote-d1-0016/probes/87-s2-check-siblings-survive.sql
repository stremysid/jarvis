SELECT (
  (SELECT count(*) FROM memory_topics WHERE principal_id = 'principal:proof:0016' AND topic_id IN ('01k3wpg0000000000000000001', '01k3wpg0000000000000000002', '01k3wpg0000000000000000003', '01k3wpg0000000000000000004')) = 4
) AS ok;
