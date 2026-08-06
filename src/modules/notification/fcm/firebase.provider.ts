import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { App, cert, getApps, initializeApp } from 'firebase-admin/app';

import { FIREBASE_APP, FIREBASE_APP_NAME } from './fcm.constants';

const logger = new Logger('FirebaseProvider');

function normalizePrivateKey(key: string): string {
  return key.replace(/\\n/g, '\n');
}

export const firebaseAppProvider: Provider = {
  provide: FIREBASE_APP,
  inject: [ConfigService],
  useFactory: (config: ConfigService): App | null => {
    const projectId = config.get<string>('FIREBASE_PROJECT_ID');
    const clientEmail = config.get<string>('FIREBASE_CLIENT_EMAIL');
    const privateKey = config.get<string>('FIREBASE_PRIVATE_KEY');

    if (!projectId || !clientEmail || !privateKey) {
      logger.warn(
        'Firebase credentials are incomplete — push notifications are disabled. ' +
          'Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY to enable them.',
      );
      return null;
    }

    const existing = getApps().find((app) => app.name === FIREBASE_APP_NAME);
    if (existing) {
      return existing;
    }

    const app = initializeApp(
      {
        credential: cert({
          projectId,
          clientEmail,
          privateKey: normalizePrivateKey(privateKey),
        }),
      },
      FIREBASE_APP_NAME,
    );

    logger.log(`Firebase initialised for project "${projectId}"`);
    return app;
  },
};
