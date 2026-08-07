import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '@/app.module';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { createValidationPipe } from '@/common/pipes/validation.pipe';
import { setupSwagger } from './config/swagger.config';
import { Logger } from '@nestjs/common';

const logger = new Logger('Mohajon');

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
  await app.listen(port);

  return { url: await app.getUrl(), port };
}

void bootstrap()
  .then(({ url, port }) =>
    logger.log(`Server is running at port ${port}: ${url}`),
  )
  .catch((err) => logger.error('Failed to start the server!', err));
