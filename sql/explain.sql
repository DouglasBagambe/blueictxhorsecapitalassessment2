-- Substitute the customer HMAC, not the email. Do not sum different currencies together.
EXPLAIN (ANALYZE, BUFFERS)
SELECT SUM(amount_cents)
FROM ledger_entries
WHERE customer_id = :target_customer
  AND status = 'completed'
  AND currency = 'KES';
