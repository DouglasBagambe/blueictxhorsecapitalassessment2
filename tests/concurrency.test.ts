import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { app, close, config, count, payment, pool, reset, signed, testUrl } from './helpers.js';
const otherPool = createPool(testUrl!);
const otherApp = buildApp(otherPool, config, () => {});
beforeEach(reset);
after(async () => {
  await otherApp.close();
  await otherPool.end();
  await close();
});
for (const distinctEvents of [false, true])
  test(`40 concurrent deliveries across two independent app pools; distinct event IDs=${distinctEvents}`, async () => {
    const start = performance.now();
    const replies = await Promise.all(
      Array.from({ length: 40 }, (_, i) => {
        const raw = JSON.stringify(
          payment(distinctEvents ? `evt_${i}` : 'evt_shared', 'txn_shared'),
        );
        return (i % 2 ? otherApp : app).inject({
          method: 'POST',
          url: '/webhooks/payment',
          headers: { 'content-type': 'application/json', 'x-webhook-signature': signed(raw) },
          payload: raw,
        });
      }),
    );
    for (const reply of replies) assert.equal(reply.statusCode, 200, reply.body);
    assert.equal(await count(), 1);
    assert.equal(
      Number((await pool.query('SELECT count(*) FROM webhook_events')).rows[0].count),
      distinctEvents ? 40 : 1,
    );
    assert.ok(
      performance.now() - start < 3000,
      'local concurrent batch should complete under 3 seconds',
    );
  });
