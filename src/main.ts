import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '@/app.module';
import { createValidationPipe } from '@/common/pipes/validation.pipe';
import { setupSwagger } from './config/swagger.config';
import { Logger } from '@nestjs/common';

const logger = new Logger('Mohajon');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(createValidationPipe());
  app.enableShutdownHooks();

  app.enableCors({
    origin: ['exp://192.168.1.107:8082', 'http://localhost:8082'],
    credentials: true,
    methods: ['GET', 'QUERY', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  setupSwagger(app);
  const configService = app.get(ConfigService);
  const port = parseInt(configService.getOrThrow('PORT'), 10);
  await app.listen(port);

  return { url: await app.getUrl(), port };
}

void bootstrap()
  .then(({ url, port }) =>
    logger.log(`Server is running at port ${port}: ${url}`),
  )
  .catch((err) => logger.error('Failed to start the server!', err));
