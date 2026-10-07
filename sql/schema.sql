BEGIN;
CREATE TABLE webhook_events (
    event_id TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 200),
    transaction_id TEXT NOT NULL CHECK (length(transaction_id) BETWEEN 1 AND 200),
    amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
    currency TEXT NOT NULL CHECK (currency IN ('KES','UGX','USD','EUR','GBP')),
    customer_id TEXT NOT NULL CHECK (customer_id ~ '^[a-f0-9]{64}$'),
    event_type TEXT NOT NULL CHECK (event_type = 'payment.succeeded'),
    provider_timestamp TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE ledger_entries (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transaction_id TEXT NOT NULL UNIQUE CHECK (length(transaction_id) BETWEEN 1 AND 200),
    amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
    currency TEXT NOT NULL CHECK (currency IN ('KES','UGX','USD','EUR','GBP')),
    customer_id TEXT CHECK (customer_id ~ '^[a-f0-9]{64}$'),
    status TEXT NOT NULL CHECK (status IN ('completed','reconciled_missing')),
    entry_type TEXT NOT NULL CHECK (entry_type IN ('payment','compensating')),
    source_event_id TEXT UNIQUE REFERENCES webhook_events(event_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((status = 'completed' AND entry_type = 'payment' AND customer_id IS NOT NULL AND source_event_id IS NOT NULL)
        OR (status = 'reconciled_missing' AND entry_type = 'compensating' AND customer_id IS NULL AND source_event_id IS NULL))
);
CREATE INDEX ledger_completed_customer_cover
    ON ledger_entries (customer_id, currency) INCLUDE (amount_cents)
    WHERE status = 'completed';
CREATE FUNCTION reject_financial_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'financial history is append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER ledger_no_update_delete BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION reject_financial_mutation();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON ledger_entries
    FOR EACH STATEMENT EXECUTE FUNCTION reject_financial_mutation();
CREATE TRIGGER events_no_update_delete BEFORE UPDATE OR DELETE ON webhook_events
    FOR EACH ROW EXECUTE FUNCTION reject_financial_mutation();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON webhook_events
    FOR EACH STATEMENT EXECUTE FUNCTION reject_financial_mutation();
COMMIT;
