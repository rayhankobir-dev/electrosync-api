import { Module } from '@nestjs/common';

import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/**
 * Reads usage samples; never writes them. The sweep in `AlertsModule` is the
 * only producer.
 *
 * `AnalyticsService` is exported because that sweep also *reads*: its
 * usage-anomaly baseline is the same daily series the charts draw, and it asks
 * for it here rather than keeping a second copy of the bucketing SQL. The
 * dependency runs one way — alerts → analytics — and nothing here reaches back.
 */
@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
