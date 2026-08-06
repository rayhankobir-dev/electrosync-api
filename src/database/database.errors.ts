/** PostgreSQL SQLSTATE codes this application distinguishes. */
export const PG_ERROR = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  NOT_NULL_VIOLATION: '23502',
} as const;

/** How deep to follow `cause` before giving up. */
const MAX_CAUSE_DEPTH = 10;

/**
 * Finds the SQLSTATE code for a thrown value, looking through wrappers.
 *
 * Drizzle does not rethrow the driver's error: it throws a `DrizzleQueryError`
 * whose message is `Failed query: ...` and hangs the original `pg` error off
 * `cause`. So `error.code` on the caught value is `undefined`, and any check
 * written against it silently fails — turning a 409 into a 500 with no
 * indication that a branch was skipped.
 *
 * Walking the chain rather than reaching for `error.cause` directly keeps this
 * working whether the driver error arrives wrapped, doubly wrapped, or bare.
 */
export function pgErrorCode(error: unknown): string | null {
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return null;

    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;

    const cause = (current as { cause?: unknown }).cause;
    // A self-referential cause would otherwise spin until the depth cap; this
    // exits on the first cycle instead.
    if (cause === current) return null;
    current = cause;
  }

  return null;
}

/** True when the error is a duplicate-key rejection from a unique index. */
export function isUniqueViolation(error: unknown): boolean {
  return pgErrorCode(error) === PG_ERROR.UNIQUE_VIOLATION;
}
