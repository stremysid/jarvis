SELECT (
  (SELECT lifecycle_state || '|' || last_transition_number FROM memory_item_state WHERE principal_id = 'principal:proof:0016' AND item_id = '01k3wpm0000000000000000001') = 'active|2'
  AND (SELECT count(*) FROM memory_item_state WHERE principal_id = 'principal:proof:0016' AND item_id = '01k3wpm0000000000000000001') = 1
  AND (SELECT count(*) FROM memory_retrievable_item_versions WHERE version_id = '01k3wpn0000000000000000001') = 1
) AS ok;
