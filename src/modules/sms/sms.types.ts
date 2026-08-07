import { type SmsEncoding } from './sms.encoding';

export interface OutboundSms {
  /**
   * Any form a user might have typed. Normalised to `8801XXXXXXXXX` by the
   * service, which rejects what cannot be a Bangladeshi mobile number.
   */
  readonly to: string;
  readonly message: string;
  /**
   * Overrides the alphabet detected from the message body. Only reach for this
   * to force `unicode` on a message that happens to be pure ASCII — forcing
   * `text` on one that is not delivers mojibake.
   */
  readonly encoding?: SmsEncoding;
}

export interface SmsSendResult {
  /** The normalised number the provider was actually given. */
  readonly to: string;
  readonly encoding: SmsEncoding;
  /** Billable parts. The provider charges per part. */
  readonly segments: number;
}

/**
 * bulksmsbd's response body, verified against the live endpoint:
 *
 *   {"response_code":1011,"success_message":"","error_message":"user id not
 *    found in this INVALID key"}
 *
 * Every field is optional here because the shape is not contractual — it is an
 * undocumented endpoint that answers HTTP 200 for failures, and a gateway or
 * captive portal in front of it can return an HTML body with the same status.
 * Typing it as guaranteed would turn that into a `TypeError` inside the alert
 * sweep instead of a logged delivery failure.
 */
export interface BulkSmsBdResponse {
  readonly response_code?: number | string;
  readonly success_message?: string;
  readonly error_message?: string;
}
