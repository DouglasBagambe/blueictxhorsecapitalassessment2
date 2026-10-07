-- Run only in a new disposable benchmark database. :target_customer is a 64-character HMAC.
BEGIN;
INSERT INTO webhook_events(event_id,transaction_id,amount_cents,currency,customer_id,event_type,provider_timestamp)
SELECT 'bench_evt_'||i, 'bench_tx_'||i, (i % 100000)::bigint,
       'KES', CASE WHEN i % 10000 = 1 THEN :target_customer ELSE repeat(md5((i % 10000)::text),2) END,
       'payment.succeeded', '2026-08-13T12:00:00Z'::timestamptz
FROM generate_series(1,1000000) AS g(i);
INSERT INTO ledger_entries(transaction_id,amount_cents,currency,customer_id,status,entry_type,source_event_id)
SELECT 'bench_tx_'||i, (i % 100000)::bigint, 'KES',
       CASE WHEN i % 10 = 0 THEN NULL WHEN i % 10000 = 1 THEN :target_customer ELSE repeat(md5((i % 10000)::text),2) END,
       CASE WHEN i % 10 = 0 THEN 'reconciled_missing' ELSE 'completed' END,
       CASE WHEN i % 10 = 0 THEN 'compensating' ELSE 'payment' END,
       CASE WHEN i % 10 = 0 THEN NULL ELSE 'bench_evt_'||i END
FROM generate_series(1,1000000) AS g(i);
COMMIT;
