import { buildApp } from './app.js';
import { readConfig } from './config.js';
import { createPool } from './db.js';
const config = readConfig();
const pool = createPool(config.databaseUrl);
const app = buildApp(pool, config);
async function shutdown() {
  await app.close();
  await pool.end();
}
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch {
  process.stderr.write('Server failed to start\n');
  await shutdown();
  process.exitCode = 1;
}
