import 'dotenv/config';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createPool } from '../src/db.js';
import { signBody } from '../src/security.js';
if (!process.env.WEBHOOK_SECRET || !process.env.DATABASE_URL)
  throw new Error('Configure .env first');
const pool = createPool(process.env.DATABASE_URL, true);
const url = process.env.DEMO_URL ?? 'http://127.0.0.1:3000';
const secret = process.env.WEBHOOK_SECRET;
const prefix = 'demo_' + Date.now();
async function deliver(event: string, tx: string, valid = true) {
  const raw = JSON.stringify({
    event_id: event,
    type: 'payment.succeeded',
    timestamp: new Date().toISOString(),
    data: {
      transaction_id: tx,
      amount_cents: 14999,
      currency: 'KES',
      customer_email: 'user@example.com',
      status: 'completed',
    },
  });
  const t = String(Math.floor(Date.now() / 1000));
  const start = performance.now();
  const response = await fetch(url + '/webhooks/payment', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-signature': `t=${t},v1=${valid ? signBody(Buffer.from(raw), t, secret) : '0'.repeat(64)}`,
    },
    body: raw,
  });
  const body: unknown = await response.json();
  return { status: response.status, ms: Math.round((performance.now() - start) * 100) / 100, body };
}
try {
  const tx = prefix + '_matched';
  const valid = await deliver(prefix + '_evt', tx);
  assert.equal(valid.status, 200);
  const invalid = await deliver(prefix + '_invalid', prefix + '_invalid_tx', false);
  assert.equal(invalid.status, 401);
  const duplicate = await deliver(prefix + '_evt', tx);
  assert.equal(duplicate.status, 200);
  const concurrent = await Promise.all(
    Array.from({ length: 20 }, () =>
      deliver(prefix + '_concurrent_evt', prefix + '_concurrent_tx'),
    ),
  );
  concurrent.forEach((reply) => assert.equal(reply.status, 200));
  const count = await pool.query('SELECT count(*) FROM ledger_entries WHERE transaction_id=$1', [
    prefix + '_concurrent_tx',
  ]);
  assert.equal(count.rows[0].count, '1');
  await deliver(prefix + '_discrepancy_evt', prefix + '_discrepancy');
  await deliver(prefix + '_orphan_evt', prefix + '_orphan');
  const provider = [
    { transaction_id: tx, amount_cents: 14999, currency: 'KES' },
    { transaction_id: prefix + '_discrepancy', amount_cents: 5000, currency: 'KES' },
    { transaction_id: prefix + '_missing', amount_cents: 2500, currency: 'KES' },
  ];
  const path = '/tmp/payment-ledger-demo-provider.json';
  await writeFile(path, JSON.stringify(provider, null, 2));
  console.log(
    JSON.stringify(
      {
        valid,
        invalid,
        duplicate,
        concurrent_requests: concurrent.length,
        concurrent_max_ms: Math.max(...concurrent.map((r) => r.ms)),
        concurrent_ledger_count: count.rows[0].count,
        provider_fixture: path,
        prefix,
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
