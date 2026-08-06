/** What gets pushed to a device. */
export interface PushPayload {
  readonly title: string;
  readonly body: string;
  readonly data?: Record<string, string>;
}

export interface FcmSendResult {
  readonly successCount: number;
  readonly failureCount: number;
  readonly invalidTokens: readonly string[];
}

export const PERMANENTLY_INVALID_TOKEN_CODES: ReadonlySet<string> = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

export const FCM_MULTICAST_BATCH_LIMIT = 500;
