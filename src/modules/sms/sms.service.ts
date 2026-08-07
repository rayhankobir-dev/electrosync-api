import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

import { toBangladeshMsisdn } from '@/common/phone-number';

import {
  DEFAULT_SMS_ENDPOINT,
  SMS_ACCEPTED_CODE,
  SMS_REQUEST_TIMEOUT_MS,
} from './sms.constants';
import { describeSms } from './sms.encoding';
import {
  type BulkSmsBdResponse,
  type OutboundSms,
  type SmsSendResult,
} from './sms.types';

/**
 * The single seam through which anything leaves this server by SMS.
 *
 * Deliberately dumb, on the same terms as `MailService`: it takes an
 * already-composed message and delivers it. What an alert *says* is the alert
 * layer's business, so swapping bulksmsbd for another gateway touches only this
 * file.
 *
 * Optional as a group, like Firebase and SMTP — the app boots and serves
 * everything without `SMS_PROVIDER_API_KEY`, and only the SMS channel is
 * unavailable. Callers check `isConfigured` and skip the channel rather than
 * discovering the gap through a 503.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly senderId: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('SMS_PROVIDER_API_KEY')?.trim() ?? '';
    this.senderId =
      this.config.get<string>('SMS_PROVIDER_SENDER_ID')?.trim() ?? '';
    this.endpoint =
      this.config.get<string>('SMS_PROVIDER_URL')?.trim() ||
      DEFAULT_SMS_ENDPOINT;

    if (!this.isConfigured) {
      this.logger.warn(
        'SMS_PROVIDER_API_KEY / SMS_PROVIDER_SENDER_ID are not set — the SMS ' +
          'channel is off. Users with SMS alerts enabled receive push only.',
      );
      return;
    }

    this.logger.log(`SMS ready via ${this.endpoint} (sender ${this.senderId})`);
  }

  get isConfigured(): boolean {
    return this.apiKey !== '' && this.senderId !== '';
  }

  /**
   * Delivers one message, or throws.
   *
   * Throwing rather than returning a failure flag is the same call `MailService`
   * makes and for the same reason: a gateway that is rejecting everything —
   * expired balance, disabled sender ID, un-whitelisted IP — must not read as
   * success anywhere upstream. Callers for whom SMS is a secondary channel
   * (`NotificationService`) catch it deliberately and say so.
   */
  async send(sms: OutboundSms): Promise<SmsSendResult> {
    if (!this.isConfigured) {
      throw new ServiceUnavailableException(
        'SMS is not configured on this server.',
      );
    }

    const number = toBangladeshMsisdn(sms.to);
    if (!number) {
      throw new ServiceUnavailableException(
        `Not a usable Bangladeshi mobile number: ${sms.to}`,
      );
    }

    const shape = describeSms(sms.message);
    const encoding = sms.encoding ?? shape.encoding;

    const body = await this.post(number, sms.message, encoding);
    const code = Number(body.response_code);

    if (code !== SMS_ACCEPTED_CODE) {
      // The provider's own wording, not a translation of it. The code table is
      // long and undocumented publicly, and an operator reading this log needs
      // "Balance Insufficient" — a code we failed to anticipate would otherwise
      // surface as a bare number.
      const reason = body.error_message?.trim() || `response_code ${code}`;

      this.logger.error(`SMS to ${number} rejected by the provider: ${reason}`);

      throw new ServiceUnavailableException(
        `The SMS provider rejected the message: ${reason}`,
      );
    }

    this.logger.log(
      `SMS accepted for ${number} (${encoding}, ${shape.segments} segment(s))`,
    );

    return { to: number, encoding, segments: shape.segments };
  }

  /**
   * Issues the request and returns the parsed body.
   *
   * Everything bulksmsbd needs travels in the query string, including the
   * message — so it goes through axios's `params` rather than an interpolated
   * URL. That is not a style preference: the alert copy this sends carries `৳`,
   * Bengali text, and `&` in some wordings, and hand-built URLs corrupt all
   * three. axios percent-encodes them.
   */
  private async post(
    number: string,
    message: string,
    type: string,
  ): Promise<BulkSmsBdResponse> {
    let data: unknown;

    try {
      ({ data } = await axios.post<unknown>(this.endpoint, null, {
        params: {
          api_key: this.apiKey,
          type,
          number,
          senderid: this.senderId,
          message,
        },
        timeout: SMS_REQUEST_TIMEOUT_MS,
        // Application failures arrive as HTTP 200 with a non-202 code in the
        // body, so the status tells us almost nothing. Only a 5xx is a genuine
        // transport fault worth an axios throw; 4xx bodies are parsed below so
        // the provider's own error text reaches the log.
        validateStatus: (status) => status < 500,
      }));
    } catch (cause) {
      // The number is logged; the message body is not. It names the user's
      // meter and its balance, and an error path is the last place to write
      // that where log shipping will copy it around.
      this.logger.error(
        `SMS request to ${this.endpoint} failed for ${number}`,
        cause instanceof Error ? cause.stack : String(cause),
      );

      throw new ServiceUnavailableException(
        'Could not reach the SMS provider. Please try again shortly.',
      );
    }

    return this.parse(data, number);
  }

  /**
   * The endpoint answers JSON, but not always with a JSON content type — and a
   * proxy or captive portal in front of it answers HTML with the same 200. Both
   * are treated as "no code we can read", which fails the send rather than
   * letting `Number(undefined)` quietly become `NaN !== 202`.
   */
  private parse(data: unknown, number: string): BulkSmsBdResponse {
    if (typeof data === 'object' && data !== null) {
      return data as BulkSmsBdResponse;
    }

    if (typeof data === 'string') {
      try {
        return JSON.parse(data) as BulkSmsBdResponse;
      } catch {
        this.logger.error(
          `SMS provider returned an unparseable body for ${number}: ${data.slice(0, 200)}`,
        );
      }
    }

    throw new ServiceUnavailableException(
      'The SMS provider returned an unrecognised response.',
    );
  }
}
