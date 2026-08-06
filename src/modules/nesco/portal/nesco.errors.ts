/**
 * Failure modes of the NESCO portal, as a closed set.
 *
 * This is the typesafety pivot of the module: the client and parser only ever
 * throw `NescoPortalError` carrying one of these reasons, and the service maps
 * each to an HTTP status in an exhaustive switch. Adding a reason here turns
 * the unhandled case into a compile error rather than a surprise 500.
 */
export type NescoFailureReason =
  /** The portal could not be reached at all (DNS, refused, reset). */
  | 'UPSTREAM_UNREACHABLE'
  /** The portal accepted the connection but did not answer in time. */
  | 'UPSTREAM_TIMEOUT'
  /** The portal answered, but with a non-2xx status. */
  | 'UPSTREAM_ERROR'
  /** The portal answered 200 with markup we no longer recognise. */
  | 'LAYOUT_CHANGED'
  /** The portal answered, but has no record of this customer number. */
  | 'CUSTOMER_NOT_FOUND';

export class NescoPortalError extends Error {
  constructor(
    readonly reason: NescoFailureReason,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'NescoPortalError';
    // Required so `instanceof` survives compilation to an ES5-style class.
    Object.setPrototypeOf(this, NescoPortalError.prototype);
  }
}

export function isNescoPortalError(error: unknown): error is NescoPortalError {
  return error instanceof NescoPortalError;
}
