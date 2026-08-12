import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '@/app.module';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { createValidationPipe } from '@/common/pipes/validation.pipe';
import { setupSwagger } from './config/swagger.config';
import { Logger } from '@nestjs/common';

const logger = new Logger('Mohajon');

/**
 * Bind every interface, and deliberately not from configuration.
 *
 * Traffic reaches the VPS on its external address, so the only other plausible
 * value is a loopback bind — which makes the API unreachable rather than more
 * private, and fails in a way that looks like a network fault instead of a
 * config line. A setting whose every non-default value is wrong here is worse
 * than a constant.
 */
const HOST = '0.0.0.0';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  const corsOrigins = configService.getOrThrow<string[]>('CORS_ORIGINS');

  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'QUERY', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  setupSwagger(app);
  const port = configService.getOrThrow<number>('PORT');
  await app.listen(port, HOST);

  return { url: await app.getUrl(), port, host: HOST };
}

void bootstrap()
  .then(({ url, port, host }) =>
    logger.log(`Server is running on ${host}:${port}: ${url}`),
  )
  .catch((err) => logger.error('Failed to start the server!', err));
