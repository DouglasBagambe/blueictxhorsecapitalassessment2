import { z } from 'zod';
export const currencies = z.enum(['KES', 'UGX', 'USD', 'EUR', 'GBP']);
const identity = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !value.includes('\0'), 'Identity cannot contain a null byte');
export const providerRecord = z
  .object({
    transaction_id: identity,
    amount_cents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    currency: currencies,
  })
  .strict();
export const paymentWebhook = z
  .object({
    event_id: identity,
    type: z.literal('payment.succeeded'),
    timestamp: z.string().datetime({ offset: true }),
    data: providerRecord
      .extend({ customer_email: z.string().email().max(320), status: z.literal('completed') })
      .strict(),
  })
  .strict();
export const providerFile = z.array(providerRecord).superRefine((records, ctx) => {
  const ids = new Set<string>();
  records.forEach((record, index) => {
    if (ids.has(record.transaction_id))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, 'transaction_id'],
        message: 'Duplicate transaction ID in provider file',
      });
    ids.add(record.transaction_id);
  });
});
export type Payment = z.infer<typeof paymentWebhook>;
export type ProviderRecord = z.infer<typeof providerRecord>;

export function parseFinancialJson(raw: string): unknown {
  return JSON.parse(raw, (key, value: unknown, context?: { source: string }) => {
    // Inspect the original number token: JSON.parse can round a fractional value into an integer.
    if (
      key === 'amount_cents' &&
      typeof value === 'number' &&
      (!context || !/^(0|[1-9][0-9]*)$/.test(context.source))
    ) {
      throw new Error('amount_cents must use a nonnegative decimal integer literal');
    }
    return value;
  });
}
