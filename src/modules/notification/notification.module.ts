import { Module } from '@nestjs/common';

import { MailModule } from '@/modules/mail/mail.module';
import { SmsModule } from '@/modules/sms/sms.module';

import { FcmService } from './fcm/fcm.service';
import { firebaseAppProvider } from './fcm/firebase.provider';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

@Module({
  imports: [SmsModule, MailModule],
  controllers: [NotificationController],
  providers: [firebaseAppProvider, FcmService, NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
