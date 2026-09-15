SELECT (
  (SELECT count(*) FROM memory_model_prices WHERE price_id = '01k3wpy0000000000000000004') = 1
  AND (SELECT count(*) FROM memory_model_prices WHERE price_id = '01k3wpy0000000000000000005') = 0
) AS ok;
