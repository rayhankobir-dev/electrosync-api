import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { MeterModule } from '@/modules/meter/meter.module';
import { NescoModule } from '@/modules/nesco/nesco.module';
import { NotificationModule } from '@/modules/notification/notification.module';

import { BalanceSweepService } from './balance-sweep.service';

/**
 * The scheduled side of the app: nothing here is reachable over HTTP.
 *
 * It deliberately has no controller. A "check my meters now" endpoint would
 * hand any authenticated user a lever to hammer the NESCO portal on demand,
 * so if one is ever added it belongs behind a rate limit and an owner check,
 * not on this module's default surface.
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    MeterModule,
    NescoModule,
    NotificationModule,
  ],
  providers: [BalanceSweepService],
  exports: [BalanceSweepService],
})
export class AlertsModule {}
