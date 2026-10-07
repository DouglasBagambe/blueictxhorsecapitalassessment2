import Fastify from 'fastify';
import type pg from 'pg';
import type { Config } from './config.js';
import { customerId, verifySignature } from './security.js';
import { paymentWebhook, parseFinancialJson } from './validation.js';
import { ingest } from './webhookService.js';
export type AuditSink = (record: Record<string, unknown>) => void;
export function buildApp(
  pool: pg.Pool,
  config: Config,
  audit: AuditSink = (record) => process.stdout.write(JSON.stringify(record) + '\n'),
) {
  const outcomes = new WeakMap<object, string>();
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, requestTimeout: 2500 });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) =>
    done(null, body),
  );
  app.addHook('onResponse', async (request, reply) => {
    if (request.url.split('?')[0] === '/webhooks/payment') {
      audit({
        timestamp: new Date().toISOString(),
        request_id: request.id,
        action: 'payment_webhook',
        http_status: reply.statusCode,
        outcome: outcomes.get(request) ?? 'rejected',
        duration_ms: Math.round(reply.elapsedTime),
      });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode =
      error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
        ? error.statusCode
        : 503;
    const status = statusCode >= 400 && statusCode < 500 ? statusCode : 503;
    reply.code(status).send({
      error: status === 503 ? 'Service temporarily unavailable; retry delivery' : 'Invalid request',
    });
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.post('/webhooks/payment', async (request, reply) => {
    if (!Buffer.isBuffer(request.body))
      return reply.code(400).send({ error: 'Expected JSON body' });
    if (
      !verifySignature(request.body, request.headers['x-webhook-signature'], config.webhookSecret)
    ) {
      return reply.code(401).send({ error: 'Invalid signature' });
    }
    let parsed: unknown;
    try {
      parsed = parseFinancialJson(new TextDecoder('utf-8', { fatal: true }).decode(request.body));
    } catch {
      return reply.code(400).send({ error: 'Malformed JSON' });
    }
    const validated = paymentWebhook.safeParse(parsed);
    if (!validated.success) return reply.code(400).send({ error: 'Invalid payment payload' });
    const result = await ingest(
      pool,
      validated.data,
      customerId(validated.data.data.customer_email, config.customerHashSecret),
    );
    outcomes.set(request, result);
    return reply.code(result === 'identity_conflict' ? 409 : 200).send({ result });
  });
  return app;
}
