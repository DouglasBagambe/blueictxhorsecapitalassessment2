import type pg from 'pg';
import { transaction } from './db.js';
import { providerFile } from './validation.js';
export interface Finding {
  classification: 'MATCHED' | 'DISCREPANCY' | 'MISSING LOCAL' | 'ORPHAN LOCAL';
  transaction_id: string;
  provider?: { amount_cents: string; currency: string };
  local?: { amount_cents: string; currency: string };
  compensation_inserted?: boolean;
}
export async function reconcile(pool: pg.Pool, input: unknown): Promise<Finding[]> {
  const records = providerFile.parse(input);
  return transaction(pool, async (client) => {
    // A single server-side join avoids copying a 50M-row ledger into application memory.
    await client.query(
      `CREATE TEMP TABLE provider_input (transaction_id TEXT PRIMARY KEY, amount_cents BIGINT NOT NULL, currency TEXT NOT NULL) ON COMMIT DROP`,
    );
    await client.query(
      `INSERT INTO provider_input SELECT transaction_id, amount_cents, currency
      FROM jsonb_to_recordset($1::jsonb) AS r(transaction_id TEXT, amount_cents BIGINT, currency TEXT)`,
      [JSON.stringify(records)],
    );
    const findings: Finding[] = [];
    const compared =
      await client.query(`SELECT p.transaction_id, p.amount_cents::text AS provider_amount, p.currency AS provider_currency,
      l.amount_cents::text AS local_amount, l.currency AS local_currency
      FROM provider_input p LEFT JOIN ledger_entries l USING (transaction_id) ORDER BY p.transaction_id`);
    for (const row of compared.rows) {
      const provider = { amount_cents: row.provider_amount, currency: row.provider_currency };
      if (row.local_amount !== null) {
        findings.push({
          classification:
            row.local_amount === row.provider_amount && row.local_currency === row.provider_currency
              ? 'MATCHED'
              : 'DISCREPANCY',
          transaction_id: row.transaction_id,
          provider,
          local: { amount_cents: row.local_amount, currency: row.local_currency },
        });
        continue;
      }
      const inserted = await client.query(
        `INSERT INTO ledger_entries (transaction_id,amount_cents,currency,status,entry_type)
        VALUES ($1,$2,$3,'reconciled_missing','compensating') ON CONFLICT (transaction_id) DO NOTHING RETURNING id`,
        [row.transaction_id, row.provider_amount, row.provider_currency],
      );
      if (inserted.rowCount) {
        findings.push({
          classification: 'MISSING LOCAL',
          transaction_id: row.transaction_id,
          provider,
          compensation_inserted: true,
        });
      } else {
        // A webhook or another reconciler won the unique constraint while we were comparing.
        const current = await client.query(
          'SELECT amount_cents::text, currency FROM ledger_entries WHERE transaction_id=$1',
          [row.transaction_id],
        );
        const local = current.rows[0];
        findings.push({
          classification:
            local.amount_cents === provider.amount_cents && local.currency === provider.currency
              ? 'MATCHED'
              : 'DISCREPANCY',
          transaction_id: row.transaction_id,
          provider,
          local,
        });
      }
    }
    const orphans =
      await client.query(`SELECT l.transaction_id, l.amount_cents::text, l.currency FROM ledger_entries l
      WHERE NOT EXISTS (SELECT 1 FROM provider_input p WHERE p.transaction_id=l.transaction_id) ORDER BY l.transaction_id`);
    for (const row of orphans.rows)
      findings.push({
        classification: 'ORPHAN LOCAL',
        transaction_id: row.transaction_id,
        local: { amount_cents: row.amount_cents, currency: row.currency },
      });
    return findings;
  });
}
