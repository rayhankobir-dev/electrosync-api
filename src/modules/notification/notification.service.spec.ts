import { Logger } from '@nestjs/common';

import { type DrizzleDb } from '@/database/types/drizzle';
import { type UserSettings } from '@/database/types/user-settings.type';
import { MailService } from '@/modules/mail/mail.service';
import { SmsService } from '@/modules/sms/sms.service';

import { FcmService } from './fcm/fcm.service';
import { NotificationService } from './notification.service';

/**
 * Pins which notifications become a text and which do not.
 *
 * The routing rules live in settings the user controls, and getting one wrong
 * is expensive in both directions — a missed alert on the channel they paid
 * attention to, or a text they never asked for, billed per segment.
 *
 * Firebase is left unconfigured throughout: push has its own tests, and
 * switching it off keeps these focused on the SMS decision.
 */
describe('NotificationService SMS fan-out', () => {
  const NOTIFICATION_ID = 'notification-1';

  interface UserRow {
    mobile: string | null;
    email?: string | null;
    settings: UserSettings | null;
  }

  let send: jest.Mock;
  let sendMail: jest.Mock;

  function serviceFor(row: UserRow | undefined, smsConfigured = true) {
    send = jest.fn().mockResolvedValue({
      to: '8801700000000',
      encoding: 'unicode',
      segments: 1,
    });
    sendMail = jest.fn().mockResolvedValue(undefined);

    const db = {
      insert: () => ({
        values: () => ({ returning: async () => [{ id: NOTIFICATION_ID }] }),
      }),
      select: () => ({
        from: () => ({ where: async () => (row ? [row] : []) }),
      }),
    } as unknown as DrizzleDb;

    const fcm = { isConfigured: false } as unknown as FcmService;
    const sms = { isConfigured: smsConfigured, send } as unknown as SmsService;
    const mail = {
      isConfigured: true,
      send: sendMail,
    } as unknown as MailService;

    return new NotificationService(db, fcm, sms, mail);
  }

  function notify(service: NotificationService) {
    return service.sendToUser('user-1', {
      title: 'Low meter balance',
      body: 'Home has ৳80 left.',
    });
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('sends nothing when the user has not enabled the channel', async () => {
    // The default. Push is what the user consented to by installing the app; a
    // text to their handset is a separate ask.
    const outcome = await notify(
      serviceFor({ mobile: '01700000000', settings: {} }),
    );

    expect(send).not.toHaveBeenCalled();
    expect(outcome.sms).toEqual({
      status: 'skipped',
      reason: 'channel-disabled',
    });
  });

  it('texts the profile number when the channel is on', async () => {
    const outcome = await notify(
      serviceFor({ mobile: '01700000000', settings: { smsAlerts: true } }),
    );

    // Already dialling-normalised: this layer has to resolve the number anyway
    // to tell "no number on file" from "send it", so it passes on what it
    // resolved rather than making SmsService redo the work.
    expect(send).toHaveBeenCalledWith({
      to: '8801700000000',
      // Title and body joined: SMS has no subject line, and "Low meter
      // balance" alone does not say which meter.
      message: 'Low meter balance: Home has ৳80 left.',
    });
    expect(outcome.sms).toEqual({
      status: 'sent',
      to: '8801700000000',
      segments: 1,
    });
  });

  it('prefers the settings override over the profile number', async () => {
    await notify(
      serviceFor({
        mobile: '01700000000',
        settings: { smsAlerts: true, smsNumber: '01811111111' },
      }),
    );

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: '8801811111111' }),
    );
  });

  it('falls back to the profile number when the override is null', async () => {
    // Null means "no override", not "send nowhere" — which is why the fallback
    // is `??` and not `||`.
    await notify(
      serviceFor({
        mobile: '01700000000',
        settings: { smsAlerts: true, smsNumber: null },
      }),
    );

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: '8801700000000' }),
    );
  });

  it('skips, and says why, when there is no usable number', async () => {
    const outcome = await notify(
      serviceFor({ mobile: null, settings: { smsAlerts: true } }),
    );

    expect(send).not.toHaveBeenCalled();
    expect(outcome.sms).toEqual({
      status: 'skipped',
      reason: 'no-usable-number',
    });
  });

  it('skips a number that cannot be dialled', async () => {
    const outcome = await notify(
      serviceFor({ mobile: '0212345678', settings: { smsAlerts: true } }),
    );

    expect(send).not.toHaveBeenCalled();
    expect(outcome.sms).toEqual({
      status: 'skipped',
      reason: 'no-usable-number',
    });
  });

  it('reports the gateway, not the user, when there are no credentials', async () => {
    // Checked ahead of the user's settings: with no gateway credentials the
    // answer is the same for every user, and "we never had a gateway" is a
    // different problem from "you turned this off" for whoever reads it.
    const outcome = await notify(serviceFor(undefined, false));

    expect(outcome.sms).toEqual({
      status: 'skipped',
      reason: 'provider-not-configured',
    });
  });

  it('still records and reports the notification when the gateway fails', async () => {
    // The load-bearing case. The row is committed and push has been attempted
    // by this point, so a gateway outage must not abort a delivered
    // notification — nor, inside the sweep's batch, the alerts behind it.
    const service = serviceFor({
      mobile: '01700000000',
      settings: { smsAlerts: true },
    });
    send.mockRejectedValue(new Error('Balance Insufficient'));

    const outcome = await notify(service);

    expect(outcome.notificationId).toBe(NOTIFICATION_ID);
    expect(outcome.sms).toEqual({
      status: 'failed',
      reason: 'Balance Insufficient',
    });
  });

  /**
   * The requirement this whole channel exists to satisfy: a user who turned on
   * both switches gets both messages. Nested here rather than in its own
   * describe because it is asserting the *interaction* between the two
   * channels, which needs the same harness.
   */
  it('delivers on every channel the user enabled, independently', async () => {
    const service = serviceFor({
      mobile: '01700000000',
      email: 'user@example.com',
      settings: { smsAlerts: true, emailAlerts: true },
    });

    const outcome = await notify(service);

    expect(send).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(outcome.sms.status).toBe('sent');
    expect(outcome.email.status).toBe('sent');
  });

  it('still emails when the SMS gateway fails', async () => {
    // Channels are siblings, not a chain: one gateway being down must not cost
    // the user the alert on the other.
    const service = serviceFor({
      mobile: '01700000000',
      email: 'user@example.com',
      settings: { smsAlerts: true, emailAlerts: true },
    });
    send.mockRejectedValue(new Error('Balance Insufficient'));

    const outcome = await notify(service);

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(outcome.email.status).toBe('sent');
    expect(outcome.sms.status).toBe('failed');
  });
});

/**
 * Pins which notifications become an email and which do not.
 *
 * Mirrors the SMS suite deliberately — the two channels are meant to make the
 * same decisions from the same settings, and keeping the cases parallel is what
 * makes a divergence between them show up as a missing test rather than as a
 * user who stopped getting one of them.
 */
describe('NotificationService email fan-out', () => {
  const NOTIFICATION_ID = 'notification-1';

  interface UserRow {
    mobile: string | null;
    email: string | null;
    settings: UserSettings | null;
  }

  let sendMail: jest.Mock;

  function serviceFor(row: UserRow | undefined, mailConfigured = true) {
    sendMail = jest.fn().mockResolvedValue(undefined);

    const db = {
      insert: () => ({
        values: () => ({ returning: async () => [{ id: NOTIFICATION_ID }] }),
      }),
      select: () => ({
        from: () => ({ where: async () => (row ? [row] : []) }),
      }),
    } as unknown as DrizzleDb;

    const fcm = { isConfigured: false } as unknown as FcmService;
    const sms = { isConfigured: false } as unknown as SmsService;
    const mail = {
      isConfigured: mailConfigured,
      send: sendMail,
    } as unknown as MailService;

    return new NotificationService(db, fcm, sms, mail);
  }

  function notify(service: NotificationService) {
    return service.sendToUser('user-1', {
      title: 'Low meter balance',
      body: 'Home has ৳80 left.',
    });
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('sends nothing when the user has not enabled the channel', async () => {
    const outcome = await notify(
      serviceFor({ mobile: null, email: 'user@example.com', settings: {} }),
    );

    expect(sendMail).not.toHaveBeenCalled();
    expect(outcome.email).toEqual({
      status: 'skipped',
      reason: 'channel-disabled',
    });
  });

  it('emails the account address when the channel is on', async () => {
    const outcome = await notify(
      serviceFor({
        mobile: null,
        email: 'user@example.com',
        settings: { emailAlerts: true },
      }),
    );

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        // The title carries the subject line email actually has, so unlike SMS
        // the two parts are not crushed together.
        subject: 'Low meter balance',
      }),
    );
    expect(outcome.email).toEqual({
      status: 'sent',
      to: 'user@example.com',
    });
  });

  it('writes the body into both the text and HTML parts', async () => {
    // Some clients render text by preference. An alert that arrives blank is
    // worse than one that arrives unstyled.
    await notify(
      serviceFor({
        mobile: null,
        email: 'user@example.com',
        settings: { emailAlerts: true },
      }),
    );

    const mail = sendMail.mock.calls[0][0];
    expect(mail.text).toContain('Home has ৳80 left.');
    expect(mail.html).toContain('Home has ৳80 left.');
  });

  it('writes the email in the language the user chose', async () => {
    await notify(
      serviceFor({
        mobile: null,
        email: 'user@example.com',
        settings: { emailAlerts: true, language: 'bn' },
      }),
    );

    const mail = sendMail.mock.calls[0][0];
    expect(mail.html).toContain('lang="bn"');
    expect(mail.text).toContain('ইলেক্ট্রোসিঙ্ক');
  });

  it('reports that nothing was delivered when SMTP is unconfigured', async () => {
    // MailService logs the body instead of throwing, so the send "succeeds".
    // Reporting that as `sent` would be a lie the caller acts on.
    const outcome = await notify(
      serviceFor(
        {
          mobile: null,
          email: 'user@example.com',
          settings: { emailAlerts: true },
        },
        false,
      ),
    );

    expect(outcome.email).toEqual({
      status: 'skipped',
      reason: 'provider-not-configured',
    });
  });

  it('skips, and says why, when the account has no address', async () => {
    const outcome = await notify(
      serviceFor({
        mobile: null,
        email: null,
        settings: { emailAlerts: true },
      }),
    );

    expect(sendMail).not.toHaveBeenCalled();
    expect(outcome.email).toEqual({
      status: 'skipped',
      reason: 'no-usable-address',
    });
  });

  it('still records and reports the notification when SMTP fails', async () => {
    const service = serviceFor({
      mobile: null,
      email: 'user@example.com',
      settings: { emailAlerts: true },
    });
    sendMail.mockRejectedValue(new Error('Invalid login: 535 Bad credentials'));

    const outcome = await notify(service);

    expect(outcome.notificationId).toBe(NOTIFICATION_ID);
    expect(outcome.email).toEqual({
      status: 'failed',
      reason: 'Invalid login: 535 Bad credentials',
    });
  });
});
