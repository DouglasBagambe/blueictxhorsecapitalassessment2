import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { app, audits, close, count, payment, pool, reset, send, signed } from './helpers.js';
beforeEach(reset);
after(close);
test('valid signature uses exact raw bytes and inserts once', async () => {
  const raw = JSON.stringify(payment(), null, 2) + '\n';
  assert.equal((await send(raw)).statusCode, 200);
  assert.equal(await count(), 1);
  assert.equal(
    (await pool.query('SELECT amount_cents FROM ledger_entries')).rows[0].amount_cents,
    '14999',
  );
});
test('invalid, missing, malformed and tampered signatures reject without persistence', async () => {
  const raw = JSON.stringify(payment());
  for (const signature of [
    'bad',
    't=1,v1=' + '0'.repeat(64),
    't=1,v1=xyz',
    't=1,t=2,v1=' + '0'.repeat(64),
  ])
    assert.equal((await send(raw, signature)).statusCode, 401);
  const response = await app.inject({
    method: 'POST',
    url: '/webhooks/payment',
    headers: { 'content-type': 'application/json' },
    payload: raw,
  });
  assert.equal(response.statusCode, 401);
  assert.equal((await send(raw.replace('14999', '15000'), signed(raw))).statusCode, 401);
  assert.equal(await count(), 0);
});
test('authenticated malformed JSON returns 400', async () => {
  assert.equal((await send('{broken')).statusCode, 400);
  assert.equal(await count(), 0);
});
test('negative, fractional, unsafe, wrong-type amounts, currency, missing fields and event types return 400', async () => {
  for (const amount of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '14999', null]) {
    const p = payment();
    const bad = { ...p, data: { ...p.data, amount_cents: amount } };
    assert.equal((await send(bad)).statusCode, 400);
  }
  for (const bad of [
    { ...payment(), data: { ...payment().data, currency: 'XYZ' } },
    { ...payment(), event_id: undefined },
    { ...payment(), type: 'payment.failed' },
    { ...payment(), timestamp: 'bad' },
    { ...payment(), data: { ...payment().data, status: 'pending' } },
  ])
    assert.equal((await send(bad)).statusCode, 400);
  assert.equal(await count(), 0);
});
test('duplicate event and distinct event for same transaction acknowledge without another effect', async () => {
  assert.equal((await send(payment())).statusCode, 200);
  assert.equal((await send(payment())).json().result, 'duplicate_event');
  assert.equal((await send(payment('evt_2'))).json().result, 'duplicate_transaction');
  assert.equal(await count(), 1);
  assert.equal(Number((await pool.query('SELECT count(*) FROM webhook_events')).rows[0].count), 2);
});
test('reused identity with changed financial data returns 409 and preserves original', async () => {
  await send(payment());
  const p = payment();
  p.data.amount_cents = 123;
  assert.equal((await send(p)).statusCode, 409);
  p.event_id = 'evt_conflict';
  assert.equal((await send(p)).statusCode, 409);
  assert.equal((await send(p)).statusCode, 409);
  assert.equal(Number((await pool.query('SELECT count(*) FROM webhook_events')).rows[0].count), 1);
  assert.equal(await count(), 1);
  assert.equal(
    (await pool.query('SELECT amount_cents FROM ledger_entries')).rows[0].amount_cents,
    '14999',
  );
});
test('audit logs every accepted/rejected webhook and excludes PII, raw bodies, signatures and secrets', async () => {
  await send(payment());
  await send(payment(), 'bad');
  await send('{broken');
  assert.equal(audits.length, 3);
  const logs = JSON.stringify(audits);
  for (const sensitive of [
    'user.email@example.com',
    'test-webhook-secret',
    'test-customer-secret',
    'customer_email',
    '14999',
    'v1=',
  ])
    assert.equal(logs.includes(sensitive), false);
  assert.deepEqual(
    audits.map((a) => a.http_status),
    [200, 401, 400],
  );
});
test('database rejects UPDATE, DELETE and TRUNCATE of financial history', async () => {
  await send(payment());
  for (const sql of [
    'UPDATE ledger_entries SET amount_cents=1',
    'DELETE FROM ledger_entries',
    'TRUNCATE ledger_entries',
    'TRUNCATE ledger_entries CASCADE',
    'UPDATE webhook_events SET amount_cents=1',
    'DELETE FROM webhook_events',
  ])
    await assert.rejects(pool.query(sql), /append-only/);
  assert.equal(await count(), 1);
});
test('ledger constraint violation rolls back event insert', async () => {
  await pool.query(
    `CREATE FUNCTION test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`,
  );
  await pool.query(
    'CREATE TRIGGER test_failure BEFORE INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION test_fail()',
  );
  assert.equal((await send(payment())).statusCode, 503);
  assert.equal(Number((await pool.query('SELECT count(*) FROM webhook_events')).rows[0].count), 0);
});

test('original money token cannot silently round a fraction into a safe integer', async () => {
  for (const amount of ['9007199254740990.5', '14999.0000000000000001', '1e4']) {
    const raw = JSON.stringify(payment()).replace('14999', amount);
    assert.equal((await send(raw)).statusCode, 400);
  }
  assert.equal(await count(), 0);
});
