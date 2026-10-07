# Payment Webhooks & Immutable Financial Ledger

Douglas Bagambe — Blue ICT × Horse Capital technical assessment.

This TypeScript service verifies payment notifications, records each payment once in PostgreSQL, and reconciles provider transactions without rewriting financial history. The database makes the final concurrency decision; application instances do not coordinate through process memory.

## Architecture

```text
Provider -> raw-body HMAC -> input validation -> database transaction -> HTTP acknowledgement
                                               | webhook_events: unique event ID
                                               | ledger_entries: unique transaction ID
Provider JSON -> reconciliation CLI -> compare -> append missing payment recovery
```

A webhook is the provider calling our API to tell us that an event happened. At-least-once delivery means the provider can retry, so duplicates are normal.

The service processes a successful payment synchronously in one short database transaction. There are no network side effects, queue dependencies or background workers in the acknowledgement path. PostgreSQL stores the accepted event and financial effect together, and the response is sent after commit. A database failure returns 503 so the provider can retry.

## Files

| File | Responsibility |
| --- | --- |
| `src/app.ts` | Fastify route, raw body, HTTP status mapping and audit hook |
| `src/security.ts` | HMAC verification and deterministic customer identity |
| `src/validation.ts` | Webhook/provider-file validation and supported currencies |
| `src/webhookService.ts` | Atomic event/ledger insertion and conflict decisions |
| `src/reconciliationService.ts` | Comparison, recovery inserts and race handling |
| `src/db.ts` | Connection pool and transaction/rollback helper |
| `src/config.ts`, `src/server.ts` | Environment checks, startup and graceful shutdown |
| `cli/reconcile.ts` | File input and readable JSON summary |
| `sql/schema.sql` | Tables, constraints, covering index and immutable triggers |
| `sql/runtime-role.sql` | Optional least-privilege runtime grants |
| `sql/seed.sql`, `sql/explain*.sql` | Reproducible million-row benchmark and queries |
| `scripts/` | Setup, signing, live demo, benchmark and packaging |
| `tests/` | Real PostgreSQL integration, concurrency and reconciliation tests |
| `fixtures/payment.json`, `provider_transactions.json` | Example inputs |
| `evidence/` | Actual performance plans and validation results |

## Prerequisites and setup

Use Node.js **22.20 or newer**, npm, and PostgreSQL 16 or newer. Docker Compose is an optional database/application launcher. Python 3 is used only to produce the submission ZIP. Commands below run from the project directory. The local machine-specific setup is described separately in `LOCAL_RUN.md`, which is excluded from the submission.

```bash
npm ci
cp .env.example .env
```

Generate two separate secrets; place their values in `.env` without committing the file:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
# Run twice: WEBHOOK_SECRET and CUSTOMER_HASH_SECRET.
```

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Application/reconciliation PostgreSQL connection |
| `TEST_DATABASE_URL` | Disposable integration database; name must end in `_test` |
| `BENCHMARK_DATABASE_URL` | Optional empty benchmark database; name must end in `_benchmark` |
| `WEBHOOK_SECRET` | Provider shared HMAC secret |
| `CUSTOMER_HASH_SECRET` | Separate stable customer pseudonymization key |
| `PORT` | HTTP port, default 3000 |
| `DEMO_URL` | Optional live-demo server URL, default `http://127.0.0.1:3000` |

### Docker database

```bash
docker compose up -d db
# First initialization creates ledger schema and an empty ledger_test database.
# .env.example uses localhost:5433 for host commands.
npm run dev
```

To run the application in Docker too:

```bash
docker compose up --build -d
curl http://localhost:3000/health
# Reconciliation against the container's database:
docker compose exec app node dist/cli/reconcile.js provider_transactions.json
```

The database init scripts run only on the first initialization of an empty volume. Do not run `npm run db:setup` over the Docker-initialized application schema. Stop an existing local app before starting the Docker app on port 3000. The Compose password is a public local-development value, not a deployment credential.

### Local PostgreSQL, without Docker

Using an administrator-created login and PostgreSQL client tools:

```bash
createdb -h localhost -p 5432 -U YOUR_DB_LOGIN ledger
createdb -h localhost -p 5432 -U YOUR_DB_LOGIN ledger_test
# Set DATABASE_URL and TEST_DATABASE_URL in .env to those databases.
npm run db:setup
npm run build
npm start
```

`db:setup` intentionally applies the schema once to an empty database; it fails rather than resetting an existing financial ledger. To use a least-privilege runtime account, create a separate login named `ledger_app`, apply `sql/runtime-role.sql` as schema owner, and switch `DATABASE_URL` to that login. Set the login password privately. Grant CONNECT and TEMP on the database if those privileges have been revoked. The runtime role needs SELECT/INSERT and identity-sequence usage; it should not own tables, have DDL permission, or be a superuser.

## Sign and send a webhook

HMAC is a keyed hash proving that the sender knew the shared secret and the payload was not changed. Verification uses the timestamp header string followed immediately by the **exact raw bytes**, with no separator. Parsing or reserializing the body before verification could change whitespace, key order or encoding and invalidate a legitimate signature.

```bash
npm run sign -- fixtures/payment.json /tmp/payment-signature.txt
curl -i http://localhost:3000/webhooks/payment \
  -H 'Content-Type: application/json' \
  -H "X-Webhook-Signature: $(cat /tmp/payment-signature.txt)" \
  --data-binary @fixtures/payment.json
# Repeat the identical curl command: 200, duplicate_event, still one ledger entry.

curl -i http://localhost:3000/webhooks/payment \
  -H 'Content-Type: application/json' \
  -H 'X-Webhook-Signature: t=1,v1=0000000000000000000000000000000000000000000000000000000000000000' \
  --data-binary @fixtures/payment.json
# 401; no financial effect.
```

The header is strictly `t=<1–12 decimal digits>,v1=<64 hex characters>`. Comparison uses `timingSafeEqual`. A timestamp freshness window is deliberately disabled: an authenticated provider retry may arrive long after the original timestamp, and this assessment does not specify whether retries are re-signed. Identity constraints still prevent replayed payments from adding credits. Production should agree a re-signing/replay policy with the provider before adding a window.

| Condition | Response |
| --- | --- |
| New valid successful payment | 200 `inserted` |
| Same event and financial data | 200 `duplicate_event` |
| New event for the same transaction and financial data | 200 `duplicate_transaction` |
| Reused event/transaction identity with different amount, currency or customer | 409 `identity_conflict` |
| Invalid, missing or tampered signature | 401 |
| Authenticated malformed JSON or invalid payload | 400 |
| Database unavailable, lock timeout or transaction failure | 503; retry |
| Unsupported content type / oversized body | Framework rejection, 415 / 413 |

Authenticate before parsing: malformed JSON with a valid signature returns 400; an unauthenticated malformed request returns 401. Fields are strict, required and validated. The accepted event type is `payment.succeeded` with status `completed`. Negative/fractional/unsafe-integer amounts and unsupported currencies are rejected. Currencies are KES, UGX, USD, EUR and GBP. The body limit is 64 KiB.

## Idempotency and concurrency

Idempotency means receiving the same payment notification twice creates only one financial effect. A race condition occurs when two operations make decisions from the same old state.

The service does **not** select a row and then decide whether to insert it. It attempts:

```sql
INSERT INTO webhook_events (...) VALUES (...)
ON CONFLICT (event_id) DO NOTHING RETURNING event_id;

INSERT INTO ledger_entries (...) VALUES (...)
ON CONFLICT (transaction_id) DO NOTHING RETURNING id;
```

A unique constraint means PostgreSQL guarantees only one row can have that identity. `ON CONFLICT` lets PostgreSQL decide atomically which insertion wins. Concurrent losers wait on the winning transaction's result, then follow the conflict path. The SELECTs in the service happen **after** a conflicting insert; they compare established records and do not decide whether a new insert is safe. Default READ COMMITTED isolation gives the later SELECT a fresh snapshot after a concurrent winner commits.

The event table deduplicates provider event IDs; the ledger deduplicates economic transaction IDs even when a provider creates another event ID. Both inserts commit together. A failure rolls both back. Conflicting financial data raises an internal exception to roll back a newly inserted event too, so repeated conflicts remain 409. Genuine duplicates return 200. Duplicate deliveries do not perform any additional financial or external effects; this implementation has no external side-effect integration.

If PostgreSQL commits but the HTTP response is lost, the provider retries and receives a successful duplicate acknowledgement. This is an exactly-once **database financial effect**, not a claim that network delivery happens exactly once. Availability, provider retry policy and retention of deduplication records remain necessary.

The integration suite fires 40 simultaneous requests through two Fastify applications with independent pools for both identical-event and distinct-event/same-transaction cases. Every response is 200 and each case has exactly one ledger row. The live demo additionally uses actual HTTP requests, not injection:

```bash
npm run demo
# Produces valid, invalid, duplicate and 20 concurrent HTTP deliveries.
# Creates a fresh /tmp/payment-ledger-demo-provider.json for reconciliation.
```

The connection-acquisition timeout is 500 ms, statement timeout 700 ms and lock timeout 500 ms for webhook pools. Short local requests are measured below the three-second target. These are bounded individual waits, not an absolute end-to-end SLA: network delays, queueing and multiple statements still require production latency monitoring and capacity testing. Fastify's request timeout concerns receiving a request; it is not a promise to cancel a running database transaction after 2.5 seconds. Batch reconciliation uses a separate pool configuration without the short statement deadline.

## Immutable ledger, money and PII

An immutable ledger means financial history is appended rather than rewritten. PostgreSQL triggers reject UPDATE, DELETE and TRUNCATE on both ledger entries and recorded events. The tests verify these operations fail and records remain intact. Runtime permissions provide an additional boundary; triggers alone cannot stop a database owner or superuser disabling them or dropping a table. Privileged maintenance needs access control, review, backups and an audit trail.

Amounts use PostgreSQL BIGINT minor units and never floating-point money columns. Incoming JSON numbers must be nonnegative safe integers written as plain decimal integer literals (no decimal point or exponent). `parseFinancialJson` checks JSON.parse's original numeric source token so a tiny fractional part cannot round into an integer before validation; the service passes them to PostgreSQL as decimal strings. `pg` returns BIGINT and SUM values as strings. There is no JavaScript financial arithmetic. Larger values than `Number.MAX_SAFE_INTEGER` are rejected rather than rounded. For KES, 14999 minor units means KES 149.99; currency minor-digit rules vary, and UGX ordinarily has zero minor digits despite the assessment's `amount_cents` field name. Never add unrelated currencies together.

Customer emails are normalized by trimming and lowercasing, then HMAC-SHA256 hashed with a separate secret. Plaintext email and raw payloads are not persisted. Deterministic `customer_id` supports lookup by the same normalized email, while a keyed hash makes offline guessing harder than an unkeyed email digest. It is pseudonymization, not anonymization or encryption; protect the key and preserve a deliberate rotation/migration plan. Email-as-identity assumes the provider treats case variants as the same customer; a provider's stable customer ID would be preferable in production.

Each webhook response emits one NDJSON audit record with timestamp, request ID, outcome, HTTP status and duration. Audit records omit email, amount, event/transaction values, raw bodies, signatures and secrets. Logs therefore capture accepted and rejected deliveries without exposing provider-supplied identifiers that could themselves contain PII. Durable log shipping and request correlation across restarts belong in production.

## Reconciliation

Reconciliation compares our financial records against provider records and explains differences. A compensating entry appends a record explaining a historical recovery instead of editing earlier history.

```bash
npm run reconcile
# Default input: ./provider_transactions.json
npm run reconcile -- /tmp/payment-ledger-demo-provider.json
npm run reconcile -- /tmp/payment-ledger-demo-provider.json
```

| Classification | Meaning and action |
| --- | --- |
| MATCHED | Same transaction, amount and currency; no write |
| DISCREPANCY | Same ID, different amount or currency; report, do not overwrite |
| MISSING LOCAL | Provider record absent locally; append `reconciled_missing` / `compensating` |
| ORPHAN LOCAL | Local record absent from provider file; report, do not delete |

A validated provider file is staged in a temporary PostgreSQL table. A join compares its IDs with the ledger's unique transaction index. Missing entries use `INSERT ... ON CONFLICT (transaction_id) DO NOTHING`; a second command or a concurrent webhook cannot add another financial effect. If another writer wins, reconciliation rereads and reports MATCHED or DISCREPANCY. All recovery inserts commit in one transaction, so a failed batch does not leave partial compensation.

Provider files cannot contain duplicate transaction IDs. The file must be authoritative for the scope being compared; a partial export will legitimately report other local transactions as orphans. No orphan is automatically deleted. This report observes a live READ COMMITTED database, not a frozen end-of-day snapshot. Production reconciliation should agree provider/export cutoffs and explicitly scope by settlement period/account.

Provider records lack customer email, so missing-payment recovery stores `customer_id = NULL`, no event ID, and status `reconciled_missing`. The completed-customer balance query deliberately excludes these unresolved recoveries. A later matching webhook records its event but does not create another ledger credit or rewrite the recovered row. Customer attribution and other accounting adjustments would require a separate append-only adjustment/attribution model. This assessment's one-credit-per-transaction schema does not model refunds, reversals or full double-entry accounting; production economic effects need distinct, linked identities.

The comparison stays in SQL rather than loading the whole ledger just to compare provider IDs. The assessment CLI still loads the provider file and report, including orphan findings, into memory and inserts missing rows individually. For tens of millions of report findings, use streamed file ingestion/COPY, set-based inserts and streamed output. An exhaustive orphan comparison necessarily visits the relevant ledger scope; the customer balance index does not make that full comparison free.

## Tests and checks

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm audit --omit=dev
```

Tests require a real PostgreSQL database, with no mock persistence and no skipped integration tests. The database name must end in `_test`. Tests drop and recreate the `public` schema **only in that explicitly guarded disposable database**, using a schema-owning test login. That is administrative fixture reset, not a runtime exception to the immutability rule. Never point the test URL at valuable data. Tests execute serially between files, while designated tests issue requests/writes concurrently.

The suite covers signatures, raw whitespace, tampering, malformed JSON, required fields, invalid money/currency/types, duplicate events and transactions, identity conflicts, concurrent independent pools, audit redaction, immutable triggers, transaction rollback, all reconciliation categories, repeated/concurrent reconciliation and webhook/reconciliation races.

## Performance and 50-million-row design

A partial index contains only rows useful for a particular query. A covering index stores the amount alongside the lookup keys so PostgreSQL may answer without fetching heap rows.

```sql
CREATE INDEX ledger_completed_customer_cover
ON ledger_entries (customer_id, currency) INCLUDE (amount_cents)
WHERE status = 'completed';
```

The assessment's email lookup becomes `customer_id = HMAC(normalized_email)`. The literal `status = 'completed'` matches the partial predicate. The index supports both the assessment-equivalent query below and the safer per-currency query in `sql/explain.sql`. The supplied dataset contains only KES, so the assessment-equivalent sum is meaningful; real balances must select or group by currency.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT SUM(amount_cents)
FROM ledger_entries
WHERE customer_id = '<deterministic customer HMAC>'
  AND status = 'completed';
```

Reproduce in a **new empty database**, separate from application and tests:

```bash
createdb -h localhost -p 5432 -U YOUR_DB_LOGIN ledger_benchmark
# Add BENCHMARK_DATABASE_URL to .env with that connection.
npm run benchmark
npm run explain
```

The runner refuses an existing benchmark ledger rather than deleting historical data. It creates the schema, inserts 1,000,000 ledger rows and 1,000,000 events using `sql/seed.sql`, runs VACUUM ANALYZE, captures real plans, and compares with the covering index temporarily dropped inside a rolled-back transaction. It does not disable sequential scans or fabricate timings. To rerun seeding, use a fresh database name ending in `_benchmark`; `npm run explain` can safely repeat the query on the existing dataset.

Measured on PostgreSQL 16.15, Node 22.20.0, Linux laptop with 15 GiB RAM. Dataset: 1,000,000 ledger rows, 900,000 completed; 100 completed rows for the target customer. Seeding took 34.080 seconds. Ledger table plus indexes used 435 MB; the partial covering index used 143 MB. The database was measured after seeding/VACUUM; the OS cache was not cleared. `shared read` means PostgreSQL loaded a block into its buffers and does not prove a physical disk read.

Actual assessment-equivalent plan:

```text
Aggregate  (cost=10.35..10.36 rows=1 width=32) (actual time=0.039..0.040 rows=1 loops=1)
  Buffers: shared hit=6
  ->  Index Only Scan using ledger_completed_customer_cover on ledger_entries  (cost=0.55..10.13 rows=90 width=8) (actual time=0.025..0.032 rows=100 loops=1)
        Index Cond: (customer_id = '23f29821ec8e78654a3d8388b063b2cbd41d29535c982ad693d6c1b676b60a79'::text)
        Heap Fetches: 0
        Buffers: shared hit=6
Planning:
  Buffers: shared hit=170 read=1
Planning Time: 0.362 ms
Execution Time: 0.072 ms
```

It used an Index Only Scan, returned 100 matching rows, performed **zero heap fetches**, and used six shared-buffer hits. There was no sequential table scan. That measured execution took **0.072 ms**; it is a local cached/selective-query result, not a prediction of production latency.

The full real per-currency query and index-removal comparison:

```text
Measured at 2026-10-06T23:41:26.684Z
Node v22.20.0
{
  "version": "PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1) on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0, 64-bit",
  "ledger_rows": "1000000",
  "completed_rows": "900000",
  "ledger_total_size": "435 MB",
  "covering_index_size": "143 MB"
}
Seed seconds: 34.080
Target customer rows: 100
KES sum: 4500100
After seeding and VACUUM ANALYZE; OS cache not cleared, some PostgreSQL buffers read; no forced planner settings.

WITH COVERING INDEX
Aggregate  (cost=10.58..10.59 rows=1 width=32) (actual time=0.037..0.038 rows=1 loops=1)
  Buffers: shared hit=1 read=5
  ->  Index Only Scan using ledger_completed_customer_cover on ledger_entries  (cost=0.55..10.35 rows=90 width=8) (actual time=0.020..0.029 rows=100 loops=1)
        Index Cond: ((customer_id = '23f29821ec8e78654a3d8388b063b2cbd41d29535c982ad693d6c1b676b60a79'::text) AND (currency = 'KES'::text))
        Heap Fetches: 0
        Buffers: shared hit=1 read=5
Planning:
  Buffers: shared hit=26 read=4
Planning Time: 0.115 ms
Execution Time: 0.051 ms

WITHOUT COVERING INDEX (index removal rolled back)
Finalize Aggregate  (cost=28746.99..28747.00 rows=1 width=32) (actual time=30.924..33.646 rows=1 loops=1)
  Buffers: shared hit=6564 read=13891 written=67
  ->  Gather  (cost=28746.76..28746.97 rows=2 width=32) (actual time=30.852..33.637 rows=3 loops=1)
        Workers Planned: 2
        Workers Launched: 2
        Buffers: shared hit=6564 read=13891 written=67
        ->  Partial Aggregate  (cost=27746.76..27746.77 rows=1 width=32) (actual time=29.092..29.093 rows=1 loops=3)
              Buffers: shared hit=6564 read=13891 written=67
              ->  Parallel Seq Scan on ledger_entries  (cost=0.00..27746.67 rows=38 width=8) (actual time=0.663..29.071 rows=33 loops=3)
                    Filter: ((customer_id = '23f29821ec8e78654a3d8388b063b2cbd41d29535c982ad693d6c1b676b60a79'::text) AND (status = 'completed'::text) AND (currency = 'KES'::text))
                    Rows Removed by Filter: 333300
                    Buffers: shared hit=6564 read=13891 written=67
Planning:
  Buffers: shared hit=6
Planning Time: 0.046 ms
Execution Time: 33.661 ms
```

`EXPLAIN ANALYZE` actually executes the query. BUFFERS describes blocks already in PostgreSQL's buffer cache (hit), loaded into it (read), or written. An index-only scan can still fetch heap pages if the visibility map does not mark them all-visible. [PostgreSQL 16's covering-index documentation](https://www.postgresql.org/docs/16/indexes-index-only-scans.html) explains this dependency. Fresh append-heavy pages may require heap visibility checks until vacuum catches up. Keep autovacuum/statistics healthy and measure plans with realistic customer distributions.

For 50M rows, BIGINT IDs/amounts and B-tree unique identities remain appropriate. The balance query's work is proportional mainly to that customer's matching entries rather than all ledger rows. This is an architectural expectation: **50M was not physically benchmarked**. A customer with millions of payments still needs to sum millions of entries; an independently verified balance projection may then be warranted.

Each index increases disk usage, WAL and insertion cost. This schema keeps required identity/FK-source indexes plus one measured balance index; it does not add speculative status-only or every-column indexes. Text HMACs are easy to inspect but wider than 32-byte binary storage; binary IDs or an internal customer surrogate would reduce index size in production. Budget storage, backups, WAL and replicas with measured row/index growth rather than assuming the million-row timing extrapolates linearly.

The initial schema is deliberately unpartitioned so event/transaction uniqueness is global and simple. Time partitioning is a future archival option, not an already-implemented scaling claim. PostgreSQL requires partition keys in unique constraints on a partitioned table; naively making `(transaction_id, created_at)` unique would permit the same transaction in different time partitions. Keep a global nonpartitioned identity registry and atomically claim transaction/event IDs before writing to partitioned history. Preserve that registry for retries after history is archived. See [PostgreSQL 16 partitioning limitations](https://www.postgresql.org/docs/16/ddl-partitioning.html#DDL-PARTITIONING-DECLARATIVE-LIMITATIONS).

## Task 4: architectural critique

### Proposal: delete entries older than 365 days nightly

Reject automatic deletion solely to save primary-database disk. Financial history supports audit trails, historical traceability, chain of custody, reconciliation, and dispute investigation. Removing earlier entries can make a later balance or correction impossible to explain and can also remove deduplication evidence, allowing an old retry to create a new credit.

Reliable supporting records matter when preparing financial statements under GAAP/IFRS accounting frameworks. [IAS 1's official overview](https://www.ifrs.org/issued-standards/list-of-standards/ias-1-presentation-of-financial-statements/) describes general-purpose financial statement presentation; it is not a universal technical retention-duration rule. This project makes no claim that IFRS or GAAP requires every row to be retained exactly a particular number of years. Financial records commonly have statutory/regulatory retention requirements depending on jurisdiction and institution. Verify the actual policy with accounting, legal and compliance stakeholders, including legal holds and privacy obligations.

Reduce active storage through a reviewed lifecycle policy: time partitioning, detach/archive older partitions to a read-only historical store, compressed archival copies, and cheaper cold object storage with immutability controls. Record manifests/checksums, provenance, access history and tested restore procedures to preserve chain of custody. Keep archived records queryable/recoverable for audits and disputes, and retain the identities needed for idempotency. Privileged archival changes must be explicit and reviewed; never silently destroy financial history to save disk.

### Proposal: sleep(5) before checking the database

Reject it. Sleep is not synchronization. Two application servers can both sleep, wake up, check the same old state and race again; one operation may also take longer than five seconds. Sleeping adds at least five seconds of latency, occupies request resources, violates the three-second target and still guarantees nothing. Let atomic database constraints decide which insert wins. A loser safely acknowledges a duplicate or reports conflicting data.

## Production improvements and limits

- Authenticate/TLS-verify deployment connections; use a separate runtime role, strong credentials, secret rotation and managed backups/PITR. The local portable database uses loopback-only trust for this assessment.
- Negotiate provider retry/replay behavior; add rate limiting, bounded request admission, deployment load tests and alerting for 409/503 and reconciliation discrepancies.
- Use a transactional outbox if emails, payouts or messages are added. Give each downstream effect its own durable idempotency key; a database commit alone cannot make an arbitrary external API exactly once.
- Use settlement-scoped, streamed reconciliation at large scale, with durable batch identity, file checksum, operator provenance and reports. The current trusted local JSON fixture is not an authenticated provider export pipeline.
- Model refunds/reversals, customer attribution, currency metadata and balanced debit/credit postings explicitly before expanding beyond successful-payment credits.
- Review hot-customer workloads, vacuum visibility, index bloat, WAL and archive retention before relying on this design at 50M rows.

Docker configuration is supplied for convenience. The submitted validation uses actual local Node.js/PostgreSQL execution; a Docker daemon was unavailable, so no Docker image-build/runtime result is claimed.

## Submission package

```bash
npm run package
```

Produces `../DouglasBagambe_Dev_TakeHome.zip` and checks ZIP integrity. Source, lockfile, fixtures, SQL, Docker files, README and measurement evidence are included. Dependencies, build output, `.env`, Git metadata, logs, caches, `LOCAL_RUN.md` and the private `INTERVIEW_NOTES.md` are excluded. See `evidence/validation.md` for the final verified outcomes.
