// The decorators on `EnvironmentVariables` read their metadata through
// reflect-metadata, which Nest's bootstrap normally imports before anything
// else. A spec that calls the validator directly has to bring it itself.
import 'reflect-metadata';

import { validateEnv } from './env.validation';

/**
 * The smallest env that validates, so each test can vary one variable and have
 * any thrown error be about that variable alone.
 */
const MINIMAL = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  CORS_ORIGINS: 'http://localhost:3000',
  JWT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n',
  JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nnot-a-real-key\n',
};

function envWith(over: Record<string, unknown>): Record<string, unknown> {
  return { ...MINIMAL, ...over };
}

describe('validateEnv', () => {
  describe('ALERTS_CRON', () => {
    it('accepts a schedule that fires every six hours', () => {
      expect(validateEnv(envWith({ ALERTS_CRON: '0 */6 * * *' })).ALERTS_CRON) //
        .toBe('0 */6 * * *');
    });

    it('rejects a field-shaped string that means something else entirely', () => {
      // "* * 6 * *" is five fields, so a shape-only check passes it. It reads
      // as "every minute on the 6th of the month" — no sweep for weeks, then
      // 1440 portal scrapes in a day. Meaning has to be validated, not shape.
      expect(() => validateEnv(envWith({ ALERTS_CRON: '* * 6 * *' }))).toThrow(
        /ALERTS_CRON/,
      );
    });

    it('rejects an out-of-range field the parser cannot honour', () => {
      expect(() => validateEnv(envWith({ ALERTS_CRON: '0 99 * * *' }))).toThrow(
        /ALERTS_CRON/,
      );
    });
  });
});
