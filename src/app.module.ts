import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';

import { validateEnv } from '@/config/env.validation';
import { AlertsModule } from '@/modules/alerts/alerts.module';
import { AnalyticsModule } from '@/modules/analytics/analytics.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { UserModule } from '@/modules/user/user.module';
import { MeterModule } from '@/modules/meter/meter.module';
import { NescoModule } from '@/modules/nesco/nesco.module';
import { DatabaseModule } from '@/database/database.module';
import { JwtAuthGuard } from '@/modules/auth/guards/jwt-auth.guard';
import { NotificationModule } from '@/modules/notification/notification.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    DatabaseModule,
    AuthModule,
    UserModule,
    MeterModule,
    NescoModule,
    NotificationModule,
    AlertsModule,
    AnalyticsModule,
  ],
  controllers: [],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AppModule {}
