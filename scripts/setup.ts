import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  await pool.query(await readFile('sql/schema.sql', 'utf8'));
  console.log('Schema created');
} finally {
  await pool.end();
}
