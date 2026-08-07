import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

/** How deep to follow `cause` before giving up. Mirrors `pgErrorCode`. */
const MAX_CAUSE_DEPTH = 10;

/**
 * Renders an error and everything it wraps as a single line.
 *
 * The outermost message is routinely the least useful one. Drizzle's
 * `DrizzleQueryError` reports the SQL it ran — `Failed query: select ...` —
 * while the driver error naming the missing relation, the dropped connection
 * or the SQLSTATE hangs off `cause`. The same shape shows up wherever a library
 * wraps a lower-level failure, so this walks the chain rather than special
 * casing Drizzle.
 */
function describeCauseChain(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null || seen.has(current)) {
      break;
    }
    seen.add(current);

    const { message, code } = current as { message?: unknown; code?: unknown };
    const label = typeof message === 'string' ? message : String(current);
    // The SQLSTATE is the part that turns "it failed" into a diagnosis: 42P01
    // is a missing table (run your migrations), 28P01 is bad credentials,
    // 53300 is too many connections. It is never in the message text.
    parts.push(typeof code === 'string' ? `${label} [${code}]` : label);

    current = (current as { cause?: unknown }).cause;
  }

  return parts.join('\n  caused by: ');
}

/**
 * Logs the real reason for every unhandled exception, and keeps Nest's HTTP
 * behaviour otherwise unchanged.
 *
 * Without this, Nest's default handler prints `exception.message` alone. For a
 * wrapped database error that is the SQL statement — which is valid, which is
 * why it is so misleading to read. The failure that actually needs fixing is
 * one `cause` hop away and never appears.
 *
 * Deliberately narrow: `HttpException`s keep their status and their response
 * body verbatim, so the validation pipe's structured errors and every
 * deliberate 404/409 reach the client exactly as before. Only the logging
 * changes, plus a generic body for genuinely unexpected failures — a SQL error
 * names tables and columns, and that belongs in a log, not in a response handed
 * to a mobile client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionsFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<{
      status: (code: number) => { json: (body: unknown) => void };
    }>();
    const request = http.getRequest<{ method?: string; url?: string }>();
    const route = `${request?.method ?? '?'} ${request?.url ?? '?'}`;

    const isHttp = exception instanceof HttpException;
    const status = isHttp
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${route} -> ${status}: ${describeCauseChain(exception)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      // A client asking for something that is not there is not an incident.
      // Logging it at error level is how real errors get lost in the noise.
      this.logger.warn(
        `${route} -> ${status}: ${describeCauseChain(exception)}`,
      );
    }

    response.status(status).json(
      isHttp
        ? exception.getResponse()
        : {
            statusCode: status,
            message: 'Internal server error',
          },
    );
  }
}
