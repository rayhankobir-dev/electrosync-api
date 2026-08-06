import { DrizzleQueryError } from 'drizzle-orm';

import { isUniqueViolation } from './database.errors';

/** Shape of the error `pg` raises for a constraint violation. */
function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error(`violates constraint`), { code, constraint });
}

/**
 * The genuine wrapper Drizzle throws, not a stand-in.
 *
 * Constructing the real class is the point of this test: if a future Drizzle
 * release changes where it stashes the driver error, this fails loudly instead
 * of letting every unique violation quietly become a 500 again.
 */
function wrapped(cause: Error): Error {
  return new DrizzleQueryError('insert into "meter" ...', [], cause);
}

describe('isUniqueViolation', () => {
  it('sees through the DrizzleQueryError wrapper', () => {
    const error = wrapped(
      pgError('23505', 'meter_user_id_provider_customer_no_idx'),
    );

    expect(isUniqueViolation(error)).toBe(true);
  });

  it('still recognises a bare driver error', () => {
    expect(isUniqueViolation(pgError('23505'))).toBe(true);
  });

  it('does not mistake other constraint violations for a duplicate', () => {
    // 23503 is a foreign-key violation — a different bug with a different fix.
    expect(isUniqueViolation(wrapped(pgError('23503')))).toBe(false);
    expect(isUniqueViolation(wrapped(pgError('23502')))).toBe(false);
  });

  it('unwraps a nested cause chain', () => {
    expect(isUniqueViolation(wrapped(wrapped(pgError('23505'))))).toBe(true);
  });

  it('is safe on values that are not errors at all', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
    expect(isUniqueViolation(new Error('plain'))).toBe(false);
  });

  it('terminates on a self-referential cause', () => {
    const loop = new Error('loop') as Error & { cause?: unknown };
    loop.cause = loop;

    expect(isUniqueViolation(loop)).toBe(false);
  });
});
