import { Module } from '@nestjs/common';

import { FcmService } from './fcm/fcm.service';
import { firebaseAppProvider } from './fcm/firebase.provider';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

@Module({
  controllers: [NotificationController],
  providers: [firebaseAppProvider, FcmService, NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
