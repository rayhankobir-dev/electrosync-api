import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { AllExceptionsFilter } from './all-exceptions.filter';

/**
 * The reason this filter exists is one specific log line:
 *
 *   ERROR [ExceptionsHandler] Failed query: select "id", "title", ... limit $2
 *
 * That is the *wrapper*. Drizzle throws a `DrizzleQueryError` whose message is
 * the SQL and hangs the driver's real error — the one naming a missing table, a
 * dropped connection, a SQLSTATE — off `cause`. Nest's default handler prints
 * only `.message`, so the actual reason never reaches the log and the operator
 * is left reading SQL that is perfectly valid.
 */
describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let status: jest.Mock;
  let json: jest.Mock;
  let host: ArgumentsHost;
  let error: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    json = jest.fn();
    status = jest.fn().mockReturnValue({ json });
    host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ method: 'GET', url: '/api/v1/notifications' }),
      }),
    } as unknown as ArgumentsHost;

    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  /** Everything the logger was handed, flattened for substring assertions. */
  const logged = (spy: jest.SpyInstance): string =>
    spy.mock.calls.map((call) => call.join(' ')).join('\n');

  it('logs the driver error hidden beneath a Drizzle wrapper', () => {
    const pgError = Object.assign(
      new Error('relation "notification" does not exist'),
      { code: '42P01' },
    );
    const wrapped = new Error('Failed query: select "id", "title" from ...');
    wrapped.cause = pgError;

    filter.catch(wrapped, host);

    expect(logged(error)).toContain('relation "notification" does not exist');
    expect(logged(error)).toContain('42P01');
  });

  it('walks more than one level of wrapping', () => {
    const root = new Error('Connection terminated unexpectedly');
    const middle = new Error('Failed query: select 1');
    middle.cause = root;
    const outer = new Error('Query failed');
    outer.cause = middle;

    filter.catch(outer, host);

    expect(logged(error)).toContain('Connection terminated unexpectedly');
  });

  it('survives a self-referential cause instead of spinning', () => {
    const looping: Error & { cause?: unknown } = new Error('loops');
    looping.cause = looping;

    expect(() => filter.catch(looping, host)).not.toThrow();
  });

  it('answers 500 without leaking the internal message to the client', () => {
    filter.catch(new Error('relation "notification" does not exist'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    // A SQL error names tables and columns. The log is the right place for
    // that; an HTTP response body handed to a mobile client is not.
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('notification');
  });

  it('preserves the status and body of a deliberate HttpException', () => {
    filter.catch(new NotFoundException('No such notification.'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(JSON.stringify(json.mock.calls[0][0])).toContain(
      'No such notification.',
    );
  });

  it('keeps the validation pipe’s structured message intact', () => {
    // ValidationPipe puts an array of failures in the response body. Flattening
    // it here would change the contract the mobile client parses.
    filter.catch(
      new BadRequestException({
        message: ['limit must not be greater than 100'],
        error: 'Bad Request',
        statusCode: 400,
      }),
      host,
    );

    expect(JSON.stringify(json.mock.calls[0][0])).toContain(
      'limit must not be greater than 100',
    );
  });

  it('does not log expected 4xx rejections as errors', () => {
    filter.catch(new NotFoundException('nope'), host);

    // A user asking for something that is not there is not an incident. Logging
    // it at error level is how real errors get lost.
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('logs a 5xx HttpException as an error', () => {
    filter.catch(
      new HttpException('upstream exploded', HttpStatus.BAD_GATEWAY),
      host,
    );

    expect(error).toHaveBeenCalled();
  });
});
