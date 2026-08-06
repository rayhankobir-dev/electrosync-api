import { ValidationPipe } from '@nestjs/common';

/**
 * The single definition of request validation, shared by `main.ts` and the e2e
 * suite. Constructing the pipe separately in tests would mean the tests verify
 * a configuration that production does not actually run.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    // `transform` is what turns the raw params object into a DTO instance, so
    // the class-validator decorators actually run.
    transform: true,
    // Strip unknown properties, and reject rather than silently ignore them.
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}
