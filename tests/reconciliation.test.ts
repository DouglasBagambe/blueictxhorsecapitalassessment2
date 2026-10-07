import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../src/reconciliationService.js';
import { parseFinancialJson } from '../src/validation.js';
import { close, count, payment, pool, reset, send } from './helpers.js';
beforeEach(reset);
after(close);
const fixture = [
  { transaction_id: 'txn_matched', amount_cents: 14999, currency: 'KES' },
  { transaction_id: 'txn_discrepancy', amount_cents: 5000, currency: 'KES' },
  { transaction_id: 'txn_missing', amount_cents: 2500, currency: 'KES' },
];
test('all classifications, one compensation and repeat idempotency', async () => {
  for (const tx of ['txn_matched', 'txn_discrepancy', 'txn_orphan'])
    await send(payment(`evt_${tx}`, tx));
  const first = await reconcile(pool, fixture);
  assert.deepEqual(
    first.map((f) => f.classification).sort(),
    ['DISCREPANCY', 'MATCHED', 'MISSING LOCAL', 'ORPHAN LOCAL'].sort(),
  );
  assert.equal(
    first.find((f) => f.classification === 'MISSING LOCAL')?.compensation_inserted,
    true,
  );
  const second = await reconcile(pool, fixture);
  assert.equal(second.filter((f) => f.classification === 'MISSING LOCAL').length, 0);
  assert.equal(await count(), 4);
  const row = (await pool.query("SELECT * FROM ledger_entries WHERE transaction_id='txn_missing'"))
    .rows[0];
  assert.equal(row.status, 'reconciled_missing');
  assert.equal(row.entry_type, 'compensating');
  assert.equal(row.customer_id, null);
});
test('concurrent reconciliation runs insert only one compensation', async () => {
  await Promise.all(Array.from({ length: 5 }, () => reconcile(pool, [fixture[2]])));
  assert.equal(await count(), 1);
});
test('webhook racing reconciliation creates one financial effect', async () => {
  const p = payment('evt_race', 'txn_missing');
  p.data.amount_cents = 2500;
  const [, response] = await Promise.all([reconcile(pool, [fixture[2]]), send(p)]);
  assert.equal(response.statusCode, 200);
  assert.equal(await count(), 1);
});
test('later webhook for a reconciled payment never adds a credit', async () => {
  await reconcile(pool, [fixture[2]]);
  const p = payment('evt_late', 'txn_missing');
  p.data.amount_cents = 2500;
  assert.equal((await send(p)).json().result, 'duplicate_transaction');
  assert.equal(await count(), 1);
});
test('duplicate provider IDs or invalid record rejects the whole batch', async () => {
  await assert.rejects(reconcile(pool, [fixture[0], fixture[0]]));
  await assert.rejects(
    reconcile(pool, [fixture[0], { transaction_id: 'bad', amount_cents: -1, currency: 'KES' }]),
  );
  assert.equal(await count(), 0);
});
test('currency mismatch is discrepancy and never edits history', async () => {
  await send(payment('evt_currency', 'txn_matched'));
  const result = await reconcile(pool, [{ ...fixture[0], currency: 'USD' }]);
  assert.equal(result[0]?.classification, 'DISCREPANCY');
  assert.equal((await pool.query('SELECT currency FROM ledger_entries')).rows[0].currency, 'KES');
});

test('provider JSON rejects rounded fractional money before reconciliation', () => {
  assert.throws(() =>
    parseFinancialJson(
      '[{"transaction_id":"bad","amount_cents":9007199254740990.5,"currency":"KES"}]',
    ),
  );
});
