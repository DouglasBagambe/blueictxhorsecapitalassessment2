import 'dotenv/config';
import pg from 'pg';
import { readFile, writeFile } from 'node:fs/promises';
import { customerId } from '../src/security.js';
if (!process.env.BENCHMARK_DATABASE_URL || !process.env.CUSTOMER_HASH_SECRET)
  throw new Error('Configure benchmark database and customer hash secret');
const pool = new pg.Pool({ connectionString: process.env.BENCHMARK_DATABASE_URL });
try {
  const hash = customerId('user@example.com', process.env.CUSTOMER_HASH_SECRET);
  const sql = (await readFile('sql/explain-assessment.sql', 'utf8')).replaceAll(
    ':target_customer',
    `'${hash}'`,
  );
  const result = await pool.query(sql);
  const report = result.rows.map((row) => row['QUERY PLAN']).join('\n') + '\n';
  console.log(report);
  await writeFile('evidence/assessment-query-plan.txt', report);
} finally {
  await pool.end();
}
