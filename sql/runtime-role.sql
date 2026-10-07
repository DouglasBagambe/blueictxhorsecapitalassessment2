-- Run as schema owner after creating a separate LOGIN role named ledger_app.
-- Assign the login password outside source control. Never run the app as the schema owner.
GRANT USAGE ON SCHEMA public TO ledger_app;
GRANT SELECT, INSERT ON webhook_events, ledger_entries TO ledger_app;
GRANT USAGE, SELECT ON SEQUENCE ledger_entries_id_seq TO ledger_app;
REVOKE UPDATE, DELETE, TRUNCATE ON webhook_events, ledger_entries FROM ledger_app;
-- Reconciliation also needs TEMP on its database (enabled by default in PostgreSQL).
