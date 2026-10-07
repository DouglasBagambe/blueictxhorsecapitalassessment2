import 'dotenv/config';
export interface Config {
  databaseUrl: string;
  webhookSecret: string;
  customerHashSecret: string;
  port: number;
}
export function readConfig(): Config {
  for (const key of ['DATABASE_URL', 'WEBHOOK_SECRET', 'CUSTOMER_HASH_SECRET']) {
    if (!process.env[key]) throw new Error(`Missing environment variable: ${key}`);
  }
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  return {
    databaseUrl: process.env.DATABASE_URL!,
    webhookSecret: process.env.WEBHOOK_SECRET!,
    customerHashSecret: process.env.CUSTOMER_HASH_SECRET!,
    port,
  };
}
