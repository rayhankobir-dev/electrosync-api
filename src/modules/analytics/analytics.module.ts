import { Module } from '@nestjs/common';

import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/**
 * Reads usage samples; never writes them. The sweep in `AlertsModule` is the
 * only producer, so the two modules share a table but no code.
 */
@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
