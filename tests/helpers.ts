import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { createPool } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { signBody } from '../src/security.js';
export const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith('_test'))
  throw new Error('TEST_DATABASE_URL must point to a disposable database ending in _test');
export const config = {
  databaseUrl: testUrl,
  webhookSecret: 'test-webhook-secret',
  customerHashSecret: 'test-customer-secret',
  port: 3000,
};
export const pool = createPool(testUrl);
export const audits: Record<string, unknown>[] = [];
export const app = buildApp(pool, config, (record) => {
  audits.push(record);
});
export function payment(event = 'evt_1', tx = 'txn_1') {
  return {
    event_id: event,
    type: 'payment.succeeded',
    timestamp: '2026-08-13T12:00:00Z',
    data: {
      transaction_id: tx,
      amount_cents: 14999,
      currency: 'KES',
      customer_email: 'user.email@example.com',
      status: 'completed',
    },
  };
}
export function signed(raw: string) {
  const t = '1755086400';
  return `t=${t},v1=${signBody(Buffer.from(raw), t, config.webhookSecret)}`;
}
export async function send(payload: unknown, signature?: string) {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return app.inject({
    method: 'POST',
    url: '/webhooks/payment',
    headers: {
      'content-type': 'application/json',
      'x-webhook-signature': signature ?? signed(raw),
    },
    payload: raw,
  });
}
export async function reset() {
  // Only the explicitly guarded disposable test database is dropped, never application history.
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query(await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8'));
  audits.length = 0;
}
export async function count() {
  return Number((await pool.query('SELECT count(*) FROM ledger_entries')).rows[0].count);
}
export async function close() {
  await app.close();
  await pool.end();
}
