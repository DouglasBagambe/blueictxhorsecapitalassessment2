import 'dotenv/config';
import pg from 'pg';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { customerId } from '../src/security.js';
const url = process.env.BENCHMARK_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_benchmark'))
  throw new Error('BENCHMARK_DATABASE_URL must name a disposable database ending in _benchmark');
if (!process.env.CUSTOMER_HASH_SECRET) throw new Error('CUSTOMER_HASH_SECRET is required');
const pool = new pg.Pool({ connectionString: url, statement_timeout: 0 });
const hash = customerId('user@example.com', process.env.CUSTOMER_HASH_SECRET);
const interpolate = (sql: string) => sql.replaceAll(':target_customer', `'${hash}'`);
try {
  if (
    (await pool.query("SELECT to_regclass('public.ledger_entries') AS existing")).rows[0].existing
  )
    throw new Error('Benchmark database must be empty; use a fresh database');
  await pool.query(await readFile('sql/schema.sql', 'utf8'));
  console.log('Seeding 1,000,000 ledger rows and 1,000,000 event rows...');
  const start = performance.now();
  await pool.query(interpolate(await readFile('sql/seed.sql', 'utf8')));
  const seedSeconds = (performance.now() - start) / 1000;
  await pool.query('VACUUM (ANALYZE) ledger_entries');
  const metadata = await pool.query(`SELECT version(), count(*)::text AS ledger_rows,
    count(*) FILTER (WHERE status='completed')::text AS completed_rows,
    pg_size_pretty(pg_total_relation_size('ledger_entries')) AS ledger_total_size,
    pg_size_pretty(pg_relation_size('ledger_completed_customer_cover')) AS covering_index_size FROM ledger_entries`);
  const explain = interpolate(await readFile('sql/explain.sql', 'utf8'));
  const indexed = await pool.query(explain);
  // Honest comparison: remove only the optional index inside a rolled-back transaction.
  await pool.query('BEGIN');
  await pool.query('DROP INDEX ledger_completed_customer_cover');
  const baseline = await pool.query(explain);
  await pool.query('ROLLBACK');
  const query = explain.replace('EXPLAIN (ANALYZE, BUFFERS)', '');
  const balance = await pool.query(query);
  const indexedText = indexed.rows.map((r) => r['QUERY PLAN']).join('\n');
  const baselineText = baseline.rows.map((r) => r['QUERY PLAN']).join('\n');
  if (!indexedText.includes('Index Only Scan') || indexedText.includes('Seq Scan'))
    throw new Error('Expected index-only plan not observed');
  const report = `Measured at ${new Date().toISOString()}\nNode ${process.version}\n${JSON.stringify(metadata.rows[0], null, 2)}\nSeed seconds: ${seedSeconds.toFixed(3)}\nTarget customer rows: 100\nKES sum: ${balance.rows[0].sum}\nAfter seeding and VACUUM ANALYZE; OS cache not cleared, some PostgreSQL buffers read; no forced planner settings.\n\nWITH COVERING INDEX\n${indexedText}\n\nWITHOUT COVERING INDEX (index removal rolled back)\n${baselineText}\n`;
  await mkdir('evidence', { recursive: true });
  await writeFile('evidence/benchmark.txt', report);
  console.log(report);
} finally {
  await pool.end();
}
