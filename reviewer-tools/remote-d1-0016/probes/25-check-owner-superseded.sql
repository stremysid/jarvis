SELECT (
  (SELECT lifecycle_state || '|' || last_transition_number FROM memory_item_state WHERE principal_id = 'principal:proof:0016' AND item_id = '01k3wpm0000000000000000001') = 'superseded|3'
  AND (SELECT count(*) FROM memory_item_transitions WHERE principal_id = 'principal:proof:0016' AND item_id = '01k3wpm0000000000000000001') = 3
) AS ok;
