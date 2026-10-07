import { createHmac, timingSafeEqual } from 'node:crypto';
export function signBody(raw: Buffer, timestamp: string, secret: string): string {
  return createHmac('sha256', secret).update(timestamp).update(raw).digest('hex');
}
export function verifySignature(raw: Buffer, header: unknown, secret: string): boolean {
  if (typeof header !== 'string') return false;
  const match = /^t=([0-9]{1,12}),v1=([a-fA-F0-9]{64})$/.exec(header);
  if (!match) return false;
  const expected = Buffer.from(signBody(raw, match[1]!, secret), 'hex');
  return timingSafeEqual(expected, Buffer.from(match[2]!, 'hex'));
}
export function customerId(email: string, secret: string): string {
  return createHmac('sha256', secret).update(email.trim().toLowerCase()).digest('hex');
}
