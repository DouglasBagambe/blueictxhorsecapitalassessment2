import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { signBody } from '../src/security.js';
if (!process.env.WEBHOOK_SECRET) throw new Error('WEBHOOK_SECRET is required');
const raw = await readFile(process.argv[2] ?? 'fixtures/payment.json');
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = `t=${timestamp},v1=${signBody(raw, timestamp, process.env.WEBHOOK_SECRET)}`;
if (process.argv[3]) await writeFile(process.argv[3], signature + '\n');
else console.log(signature);
