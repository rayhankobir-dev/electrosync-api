import { randomInt } from 'node:crypto';

/**
 * Every rule governing a reset code, as pure functions over plain data.
 *
 * Separated from `PasswordResetService` so the parts worth being sure about —
 * expiry, single use, the attempt ceiling, both throttles — are testable without
 * a database, a transaction, or an SMTP server. The service keeps the I/O and
 * defers every decision to this file.
 */

/** Six digits: short enough to retype from memory, long enough with a cap. */
export const CODE_LENGTH = 6;

/**
 * Short on purpose. The window is the attacker's budget, and the user is
 * sitting in the app with the email already open — they do not need an hour.
 */
export const CODE_TTL_MINUTES = 15;

/**
 * Failed guesses before the code is dead.
 *
 * With a million values and five tries, a blind attacker's odds inside one
 * window are 1 in 200,000. Raising this to 50 makes it 1 in 20,000 for no
 * meaningful gain in user forgiveness — nobody mistypes six digits five times.
 */
export const MAX_ATTEMPTS = 5;

/** Minimum gap between sends for one email, so "resend" cannot become a mail bomb. */
export const RESEND_COOLDOWN_SECONDS = 60;

/** Ceiling per email per hour, on top of the cooldown. */
export const MAX_REQUESTS_PER_WINDOW = 5;
export const REQUEST_WINDOW_MINUTES = 60;

/** Just the fields the rules read — not the whole `verification` row. */
export interface ResetCodeRecord {
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly attempts: number;
}

export interface IssuedRequest {
  readonly createdAt: Date;
}

/**
 * Why a code cannot be redeemed, or `null` if it can.
 *
 * These are distinguished here, and then deliberately collapsed into one
 * message at the controller: knowing which of "wrong", "expired" and "already
 * used" applies tells an attacker whether a live code exists for that email.
 * The distinction is for logs and tests, not for the response.
 */
export type CodeRejection =
  | 'missing'
  | 'expired'
  | 'consumed'
  | 'attempts-exhausted';

export type ThrottleReason = 'cooldown' | 'quota';

export interface Throttle {
  readonly reason: ThrottleReason;
  /** Whole seconds until the caller may retry. Always at least 1. */
  readonly retryAfterSeconds: number;
}

/**
 * A cryptographically random six-digit code, zero-padded.
 *
 * `randomInt` rather than `Math.random()`: the latter is seeded predictably and
 * is not a CSPRNG, so codes drawn from it can be reproduced by an attacker who
 * has observed a few. `randomInt` also rejects-and-redraws internally, so the
 * distribution is uniform rather than skewed by a modulo fold.
 *
 * Padding means `000042` is a legitimate code, which is why the DTO validates
 * the shape with a regex rather than parsing an integer — `Number('000042')`
 * would compare equal to `42` and quietly accept the wrong input.
 */
export function generateCode(): string {
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

export function codeExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + CODE_TTL_MINUTES * 60_000);
}

/** Start of the rate-limit window ending at `now`. */
export function requestWindowStart(now: Date): Date {
  return new Date(now.getTime() - REQUEST_WINDOW_MINUTES * 60_000);
}

export function rejectionFor(
  record: ResetCodeRecord | null | undefined,
  now: Date,
): CodeRejection | null {
  if (!record) return 'missing';
  if (record.consumedAt) return 'consumed';
  // `<=` so a code is dead exactly at its expiry, not one tick after.
  if (record.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (record.attempts >= MAX_ATTEMPTS) return 'attempts-exhausted';
  return null;
}

/**
 * Whether another code may be sent for this email, given the requests already
 * issued inside the window.
 *
 * `recent` is expected newest-first, which is the order the query returns.
 * Checks the cooldown before the quota so a rapid second tap reports the one
 * that will clear in seconds rather than the one that clears in an hour.
 */
export function throttleFor(
  recent: readonly IssuedRequest[],
  now: Date,
): Throttle | null {
  const newest = recent.at(0);

  if (newest) {
    const elapsed = (now.getTime() - newest.createdAt.getTime()) / 1000;
    if (elapsed < RESEND_COOLDOWN_SECONDS) {
      return {
        reason: 'cooldown',
        retryAfterSeconds: secondsUntil(RESEND_COOLDOWN_SECONDS - elapsed),
      };
    }
  }

  const windowStart = requestWindowStart(now).getTime();
  const inWindow = recent.filter(
    (request) => request.createdAt.getTime() > windowStart,
  );

  if (inWindow.length >= MAX_REQUESTS_PER_WINDOW) {
    // The quota frees up when the oldest request in the window falls out of it,
    // so that — not the window length — is what the caller should wait for.
    const oldest = inWindow[inWindow.length - 1];
    const freesAt =
      oldest.createdAt.getTime() + REQUEST_WINDOW_MINUTES * 60_000;

    return {
      reason: 'quota',
      retryAfterSeconds: secondsUntil((freesAt - now.getTime()) / 1000),
    };
  }

  return null;
}

/** Rounds up, and never to 0 — a `Retry-After: 0` invites an instant retry that fails again. */
function secondsUntil(seconds: number): number {
  return Math.max(1, Math.ceil(seconds));
}
