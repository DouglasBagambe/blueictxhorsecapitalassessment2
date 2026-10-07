import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { createPool } from '../src/db.js';
import { reconcile } from '../src/reconciliationService.js';
import { parseFinancialJson } from '../src/validation.js';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = createPool(process.env.DATABASE_URL, true);
try {
  const input: unknown = parseFinancialJson(
    await readFile(process.argv[2] ?? './provider_transactions.json', 'utf8'),
  );
  const findings = await reconcile(pool, input);
  const counts = Object.fromEntries(
    ['MATCHED', 'DISCREPANCY', 'MISSING LOCAL', 'ORPHAN LOCAL'].map((key) => [
      key,
      findings.filter((f) => f.classification === key).length,
    ]),
  );
  process.stdout.write(JSON.stringify({ counts, findings }, null, 2) + '\n');
} catch {
  process.stderr.write(
    'Reconciliation failed; check file validation and database access. No partial batch was committed.\n',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
