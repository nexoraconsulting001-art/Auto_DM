import { z } from 'zod';
import { ERROR_CODES } from './errors.js';

/**
 * Building blocks every schema shares. API fields are camelCase; money is integer paise, named *Paise.
 * Input numbers stop at 32 bits, which is what the integer columns hold; output totals may be larger.
 */
const INT32_MAX = 2147483647;
const NO_NUL = /^[^\0]*$/; // Postgres text cannot hold a NUL byte

/** Trimmed text of at most `max` characters. */
export const text = (max) => z.string().trim().max(max, `Use ${max} characters or fewer`).regex(NO_NUL, 'Contains a character that isn’t allowed');
/** The same, but it can't be empty. */
export const required = (max, message = 'This is required') => text(max).min(1, message);

export const Id = z.number().int().positive().max(INT32_MAX);
export const Count = z.number().int().min(0);
export const Paise = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const PaiseInput = z.number().int('Use whole paise').min(0, 'Can’t be negative').max(INT32_MAX, 'That amount is too large');
export const Quantity = z.number().int('Use a whole number').min(0, 'Can’t be negative').max(INT32_MAX, 'That number is too large');

/** A numeric id arriving as text, in a path or a query string. */
export const IdText = z.string().regex(/^[1-9]\d{0,9}$/).transform(Number).refine((n) => n <= INT32_MAX);
export const IdParams = z.object({ id: IdText });

/** A time in a response. Handlers may return the database's Date. */
export const Timestamp = z.union([z.date().transform((d) => d.toISOString()), z.iso.datetime({ offset: true })]);

/** An uploaded file (/media/<id>) or a web link. */
export const MediaLink = z.string().trim().max(1000).regex(/^(https?:\/\/\S+|\/media\/[\w-]+)$/i, 'Use an uploaded file or a web link');
export const MediaLinkOrEmpty = z.union([z.literal(''), MediaLink]);

/** Every list takes these. Pass back `nextCursor` as `cursor` for the next page; a cursor means nothing outside the API. */
export const ListQuery = z.object({
  cursor: z.string().max(512).regex(/^[\w-]+$/, 'Invalid cursor').optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** Every list returns this shape. `nextCursor` is null on the last page. */
export const page = (item) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const ErrorBody = z.object({
  error: z.string(),
  code: z.enum(ERROR_CODES),
  fields: z.record(z.string(), z.string()).optional(),
  reason: z.string().optional(),
  storeUrl: z.string().optional(),
  feature: z.string().optional(),
  plan: z.string().optional(),
  limit: z.number().int().optional(),
  used: z.number().int().optional(),
  requestId: z.string().optional(),
});
