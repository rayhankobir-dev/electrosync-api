import { INestApplication } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

export function setupSwagger(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('ElectroSync API')
    .setDescription(
      'Prepaid electricity meter data, sourced from the NESCO portal.',
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'Token' },
      'bearer',
    )
    .build();
  const document = SwaggerModule.createDocument(app, config, {
    ignoreGlobalPrefix: false,
    deepScanRoutes: true,
  });
  SwaggerModule.setup('docs', app, document);
}
