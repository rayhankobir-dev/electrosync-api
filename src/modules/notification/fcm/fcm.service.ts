import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

import { FIREBASE_APP } from './fcm.constants';
import {
  FCM_MULTICAST_BATCH_LIMIT,
  FcmSendResult,
  PERMANENTLY_INVALID_TOKEN_CODES,
  PushPayload,
} from './fcm.types';

@Injectable()
export class FcmService {
  private readonly logger = new Logger(FcmService.name);

  constructor(@Inject(FIREBASE_APP) private readonly app: App | null) {}

  get isConfigured(): boolean {
    return this.app !== null;
  }

  async sendToTokens(
    tokens: readonly string[],
    payload: PushPayload,
  ): Promise<FcmSendResult> {
    if (!this.app) {
      throw new ServiceUnavailableException(
        'Push notifications are not configured on this server.',
      );
    }

    if (tokens.length === 0) {
      return { successCount: 0, failureCount: 0, invalidTokens: [] };
    }

    const messaging = getMessaging(this.app);
    let successCount = 0;
    let failureCount = 0;
    const invalidTokens: string[] = [];

    for (const batch of this.batch(tokens)) {
      const response = await messaging.sendEachForMulticast({
        tokens: [...batch],
        notification: { title: payload.title, body: payload.body },
        data: payload.data,
      });

      successCount += response.successCount;
      failureCount += response.failureCount;

      response.responses.forEach((result, index) => {
        if (result.success) {
          return;
        }

        const code = result.error?.code ?? 'unknown';
        const token = batch[index];

        if (PERMANENTLY_INVALID_TOKEN_CODES.has(code)) {
          invalidTokens.push(token);
        } else {
          this.logger.warn(`Push failed for a device token [${code}]`);
        }
      });
    }

    return { successCount, failureCount, invalidTokens };
  }

  private *batch(tokens: readonly string[]): Generator<readonly string[]> {
    for (let i = 0; i < tokens.length; i += FCM_MULTICAST_BATCH_LIMIT) {
      yield tokens.slice(i, i + FCM_MULTICAST_BATCH_LIMIT);
    }
  }
}
