import {
  CODE_LENGTH,
  CODE_TTL_MINUTES,
  MAX_ATTEMPTS,
  MAX_REQUESTS_PER_WINDOW,
  RESEND_COOLDOWN_SECONDS,
  codeExpiryFrom,
  generateCode,
  rejectionFor,
  throttleFor,
  type ResetCodeRecord,
} from './password-reset.policy';

const NOW = new Date('2026-08-06T12:00:00.000Z');

function at(offsetSeconds: number): Date {
  return new Date(NOW.getTime() + offsetSeconds * 1000);
}

function record(over: Partial<ResetCodeRecord> = {}): ResetCodeRecord {
  return {
    expiresAt: at(CODE_TTL_MINUTES * 60),
    consumedAt: null,
    attempts: 0,
    ...over,
  };
}

describe('generateCode', () => {
  it('is always exactly CODE_LENGTH digits', () => {
    for (let i = 0; i < 500; i += 1) {
      expect(generateCode()).toMatch(new RegExp(`^\\d{${CODE_LENGTH}}$`));
    }
  });

  it('spans the whole keyspace rather than a padded subset', () => {
    // A modulo-folded or floating-point derivation tends to cluster; drawing 500
    // codes and seeing fewer than 400 distinct values would mean the effective
    // keyspace is far smaller than a million, which the attempt cap is sized
    // against.
    const drawn = new Set(Array.from({ length: 500 }, generateCode));
    expect(drawn.size).toBeGreaterThan(400);
  });
});

describe('codeExpiryFrom', () => {
  it('lands CODE_TTL_MINUTES ahead', () => {
    expect(codeExpiryFrom(NOW).toISOString()).toBe('2026-08-06T12:15:00.000Z');
  });
});

describe('rejectionFor', () => {
  it('accepts a fresh unconsumed code', () => {
    expect(rejectionFor(record(), NOW)).toBeNull();
  });

  it.each([[null], [undefined]])('reports a %p row as missing', (value) => {
    expect(rejectionFor(value, NOW)).toBe('missing');
  });

  it('rejects a consumed code even while unexpired', () => {
    expect(rejectionFor(record({ consumedAt: at(-30) }), NOW)).toBe('consumed');
  });

  it('rejects at the exact expiry instant, not a tick later', () => {
    expect(rejectionFor(record({ expiresAt: NOW }), NOW)).toBe('expired');
  });

  it('accepts one second before expiry', () => {
    expect(rejectionFor(record({ expiresAt: at(1) }), NOW)).toBeNull();
  });

  it('allows the last permitted attempt', () => {
    expect(rejectionFor(record({ attempts: MAX_ATTEMPTS - 1 }), NOW)).toBeNull();
  });

  it('rejects once the attempt ceiling is reached', () => {
    expect(rejectionFor(record({ attempts: MAX_ATTEMPTS }), NOW)).toBe(
      'attempts-exhausted',
    );
  });

  it('reports consumption ahead of exhaustion for a row that is both', () => {
    // Ordering matters only for the log line, but pinning it keeps the reason
    // stable for anyone reading those logs.
    expect(
      rejectionFor(
        record({ consumedAt: at(-10), attempts: MAX_ATTEMPTS }),
        NOW,
      ),
    ).toBe('consumed');
  });
});

describe('throttleFor', () => {
  it('permits a first request', () => {
    expect(throttleFor([], NOW)).toBeNull();
  });

  it('blocks a resend inside the cooldown and says how long to wait', () => {
    const throttle = throttleFor([{ createdAt: at(-10) }], NOW);

    expect(throttle).toEqual({
      reason: 'cooldown',
      retryAfterSeconds: RESEND_COOLDOWN_SECONDS - 10,
    });
  });

  it('permits a resend once the cooldown has elapsed', () => {
    expect(
      throttleFor([{ createdAt: at(-RESEND_COOLDOWN_SECONDS) }], NOW),
    ).toBeNull();
  });

  it('never reports a zero wait', () => {
    // Just inside the cooldown: a Retry-After of 0 would invite an immediate
    // retry that fails again.
    const throttle = throttleFor(
      [{ createdAt: at(-RESEND_COOLDOWN_SECONDS + 0.2) }],
      NOW,
    );

    expect(throttle?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('blocks once the hourly quota is full, past the cooldown', () => {
    // Newest-first, all inside the window, oldest 50 minutes back.
    const recent = [
      { createdAt: at(-120) },
      { createdAt: at(-600) },
      { createdAt: at(-1200) },
      { createdAt: at(-1800) },
      { createdAt: at(-3000) },
    ];

    expect(recent).toHaveLength(MAX_REQUESTS_PER_WINDOW);

    const throttle = throttleFor(recent, NOW);

    expect(throttle?.reason).toBe('quota');
    // The oldest leaves the 60-minute window 10 minutes from now.
    expect(throttle?.retryAfterSeconds).toBe(600);
  });

  it('reports the cooldown, not the quota, when both apply', () => {
    const recent = [
      { createdAt: at(-5) },
      { createdAt: at(-600) },
      { createdAt: at(-1200) },
      { createdAt: at(-1800) },
      { createdAt: at(-3000) },
    ];

    // The cooldown clears in under a minute and the quota in ten, so reporting
    // the quota would tell the user to wait ten times longer than they must.
    expect(throttleFor(recent, NOW)?.reason).toBe('cooldown');
  });

  it('ignores requests that have aged out of the window', () => {
    const recent = [
      { createdAt: at(-120) },
      { createdAt: at(-600) },
      { createdAt: at(-1200) },
      { createdAt: at(-1800) },
      // Just over 60 minutes ago — outside the window, so the quota is not full.
      { createdAt: at(-3601) },
    ];

    expect(throttleFor(recent, NOW)).toBeNull();
  });
});
