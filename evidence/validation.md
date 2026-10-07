# Final validation

Verified 2026-10-07T03:02:34.004884+03:00 (East Africa Time).

- Clean `npm ci`: passed, using the submitted lockfile.
- `npm test`: **19 passed, 0 failed, 0 skipped**; real PostgreSQL, 2340.862 ms total in the final suite run.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run build`: passed.
- `npm run format:check`: passed.
- `npm audit`: **0 vulnerabilities** across runtime and development dependencies after dependency updates.
- Schema applied successfully to a fresh empty `ledger_fresh` database, separately from the test resets and benchmark.
- Direct curl delivery: valid **200**, sequential duplicate **200**, invalid signature **401**. Database confirmed exactly one `txn_sample_1` row.
- Live HTTP demo on compiled application with separate `ledger_app` runtime login: valid **200**, invalid **401**, duplicate **200**.
- Live **20 simultaneous HTTP deliveries**: all acknowledged 200, **one ledger row**; slowest observed response **37.01 ms**.
- Integration concurrency: **40 requests through two independent application/pool instances**, for identical event IDs and distinct event IDs sharing one transaction; exactly one ledger effect in each case. Final test durations including fixture setup were 111.642 ms and 68.583 ms.
- UPDATE / DELETE / TRUNCATE trigger enforcement: passed with the schema-owning test login. Attempts with runtime login were independently rejected by database permissions.
- Transaction failure injection: 503 response, no committed event or ledger row.
- Custom provider CLI first run: `{"MATCHED": 1, "DISCREPANCY": 1, "MISSING LOCAL": 1, "ORPHAN LOCAL": 8}`.
- Same CLI second run: `{"MATCHED": 2, "DISCREPANCY": 1, "MISSING LOCAL": 0, "ORPHAN LOCAL": 8}`. Database confirmed exactly one `reconciled_missing` row for that missing transaction. Previous demo rows explain the additional orphans.
- Default-path CLI: first run recovered 3 records; second run matched those 3 and recovered none.
- Invalid fractional-money CLI fixture: exit 1, no partial batch committed; no `invalid_fraction` ledger row.
- Real performance dataset: **1,000,000 ledger rows / 1,000,000 event rows**, 900,000 completed. Assessment-equivalent balance query **0.072 ms**, Index Only Scan, 6 shared hits, 0 heap fetches. Per-currency query **0.051 ms**; optional-index-removal baseline **33.661 ms**, Parallel Seq Scan. Full unedited plans are in the adjacent text files and README.

The benchmark was measured after seeding and VACUUM ANALYZE; OS caches were not cleared. Fifty million rows were not physically loaded. Timings are observations on this local dataset, not a production latency guarantee.

Docker configuration is included and statically inspected. Docker was not installed and its image/runtime were not exercised; local Node/PostgreSQL execution is the verified submission workflow.

The ZIP is produced by `scripts/package.py`, which excludes dependencies, generated builds, private environment files, Git metadata, logs, caches and private notes, and checks ZIP integrity. Private-secret-value scanning and archive contents are independently checked when packaging.
