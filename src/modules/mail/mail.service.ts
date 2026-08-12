import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';

export interface OutboundMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * The single seam through which anything leaves this server by email.
 *
 * Deliberately dumb: it takes an already-composed message and delivers it. What
 * a password-reset email *says* is the reset flow's business, not the
 * transport's, so swapping nodemailer for a provider SDK later touches only
 * this file.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    const host = this.config.get<string>('SMTP_HOST')?.trim();
    const user = this.config.get<string>('SMTP_USER')?.trim();

    this.from =
      this.config.get<string>('MAIL_FROM')?.trim() ||
      user ||
      'no-reply@electrosync.app';

    if (!host) {
      this.transporter = null;
      this.logger.warn(
        'SMTP_HOST is not set — email will be written to this log instead of sent. ' +
          'Fine for local development; in production, nobody receives their reset code.',
      );
      return;
    }

    const password = this.config.get<string>('SMTP_PASSWORD');

    this.transporter = createTransport({
      host,
      port: this.config.get<number>('SMTP_PORT'),
      secure: this.config.get<boolean>('SMTP_SECURE'),
      // Omitted entirely when absent rather than passed as `undefined`:
      // nodemailer treats the presence of an `auth` object as "authenticate",
      // and an empty one fails against relays that accept anonymous submission.
      ...(user && password ? { auth: { user, pass: password } } : {}),
    });

    this.logger.log(
      `SMTP ready: ${host}:${this.config.get<number>('SMTP_PORT')}`,
    );
  }

  /**
   * Whether a real SMTP connection exists behind `send`.
   *
   * Exposed because the two callers want opposite things from an unconfigured
   * transport. A password reset still calls `send` and lets the code land in
   * the log, which is what makes local development possible. An alert must not:
   * it would report a delivery that never happened to a user who is relying on
   * the channel, so `NotificationService` checks this and reports a skip
   * instead. Mirrors `SmsService.isConfigured`.
   */
  get isConfigured(): boolean {
    return this.transporter !== null;
  }

  /**
   * Delivers one message, or throws.
   *
   * Callers are expected to let the throw propagate. Swallowing it would turn a
   * broken SMTP configuration into a flow that reports success while silently
   * delivering nothing — undiagnosable from the client, which is the one place
   * the problem gets noticed.
   */
  async send(mail: OutboundMail): Promise<void> {
    if (!this.transporter) {
      // The full body, not a "would have sent" placeholder: for a code-bearing
      // email the body IS the thing the developer needs.
      this.logger.warn(
        [
          '',
          '──────── email not sent (SMTP unconfigured) ────────',
          `To:      ${mail.to}`,
          `Subject: ${mail.subject}`,
          '',
          mail.text,
          '───────────────────────────────────────────────────',
        ].join('\n'),
      );
      return;
    }

    try {
      await this.transporter.sendMail({
        from: this.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
    } catch (cause) {
      // The recipient is logged; the body is not. Reset emails carry a live
      // credential, and an error path is the last place it should be written
      // where log shipping will copy it around.
      this.logger.error(
        `Failed to send "${mail.subject}" to ${mail.to}`,
        cause instanceof Error ? cause.stack : String(cause),
      );

      throw new ServiceUnavailableException(
        'Could not send the email. Please try again shortly.',
      );
    }
  }
}
