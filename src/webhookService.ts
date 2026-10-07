import type pg from 'pg';
import type { Payment } from './validation.js';
import { transaction } from './db.js';
class IdentityConflict extends Error {}
export type WebhookResult =
  | 'inserted'
  | 'duplicate_event'
  | 'duplicate_transaction'
  | 'identity_conflict';
function samePayment(row: Record<string, unknown>, payment: Payment, customer: string): boolean {
  return (
    row.transaction_id === payment.data.transaction_id &&
    row.amount_cents === String(payment.data.amount_cents) &&
    row.currency === payment.data.currency &&
    row.customer_id === customer
  );
}
export async function ingest(
  pool: pg.Pool,
  payment: Payment,
  customer: string,
): Promise<WebhookResult> {
  return transaction(pool, async (client) => {
    const event = await client.query(
      `INSERT INTO webhook_events
      (event_id, transaction_id, amount_cents, currency, customer_id, event_type, provider_timestamp)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [
        payment.event_id,
        payment.data.transaction_id,
        String(payment.data.amount_cents),
        payment.data.currency,
        customer,
        payment.type,
        payment.timestamp,
      ],
    );
    if (!event.rowCount) {
      const existing = await client.query('SELECT * FROM webhook_events WHERE event_id=$1', [
        payment.event_id,
      ]);
      if (!samePayment(existing.rows[0], payment, customer)) throw new IdentityConflict();
      return 'duplicate_event';
    }
    const ledger = await client.query(
      `INSERT INTO ledger_entries
      (transaction_id, amount_cents, currency, customer_id, status, entry_type, source_event_id)
      VALUES ($1,$2,$3,$4,'completed','payment',$5)
      ON CONFLICT (transaction_id) DO NOTHING RETURNING id`,
      [
        payment.data.transaction_id,
        String(payment.data.amount_cents),
        payment.data.currency,
        customer,
        payment.event_id,
      ],
    );
    if (ledger.rowCount) return 'inserted';
    const existing = await client.query('SELECT * FROM ledger_entries WHERE transaction_id=$1', [
      payment.data.transaction_id,
    ]);
    const row = existing.rows[0];
    // Reconciliation lacks customer identity; a later webhook must not credit the payment again.
    const same =
      row.amount_cents === String(payment.data.amount_cents) &&
      row.currency === payment.data.currency &&
      (row.customer_id === null || row.customer_id === customer);
    if (!same) throw new IdentityConflict();
    return 'duplicate_transaction';
  }).catch((error) => {
    if (error instanceof IdentityConflict) return 'identity_conflict';
    throw error;
  });
}
