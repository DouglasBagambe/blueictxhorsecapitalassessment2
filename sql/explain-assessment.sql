-- Assessment query with email replaced by its deterministic customer identifier.
-- This synthetic benchmark contains only KES. For real balances, filter or group by currency.
EXPLAIN (ANALYZE, BUFFERS)
SELECT SUM(amount_cents)
FROM ledger_entries
WHERE customer_id = :target_customer
  AND status = 'completed';
