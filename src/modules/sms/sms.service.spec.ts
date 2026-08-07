import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

import { DEFAULT_SMS_ENDPOINT } from './sms.constants';
import { SmsService } from './sms.service';

/**
 * The gateway reports application failures — bad key, no balance, disabled
 * sender — as HTTP 200 with a code in the body. These tests pin that a
 * rejection is treated as a rejection, and that nothing reaches the wire
 * hand-concatenated into a URL, which is what corrupts the Bengali alert copy.
 */
describe('SmsService', () => {
  let post: jest.SpyInstance;

  const ENV: Record<string, string> = {
    SMS_PROVIDER_API_KEY: 'test-key',
    SMS_PROVIDER_SENDER_ID: '8809648906389',
  };

  function service(
    overrides: Record<string, string | undefined> = {},
  ): SmsService {
    const values = { ...ENV, ...overrides };

    return new SmsService({
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService);
  }

  /** The request config axios was handed, so the query params can be asserted. */
  function sentParams(): Record<string, string> {
    expect(post).toHaveBeenCalledTimes(1);
    const config = post.mock.calls[0][2] as { params: Record<string, string> };
    return config.params;
  }

  function accept() {
    post.mockResolvedValue({
      data: {
        response_code: 202,
        success_message: 'SMS Submitted Successfully',
      },
    });
  }

  beforeEach(() => {
    post = jest.spyOn(axios, 'post');
    // The constructor and a successful send both announce themselves; keep a
    // green run quiet without hiding the error paths the tests care about.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('configuration', () => {
    it('is configured when both the key and the sender id are present', () => {
      expect(service().isConfigured).toBe(true);
    });

    it.each(['SMS_PROVIDER_API_KEY', 'SMS_PROVIDER_SENDER_ID'])(
      'is unconfigured without %s',
      (missing) => {
        // Both, not either: a key with no sender id is rejected on every send,
        // so arming the channel would burn a round trip per alert to learn what
        // boot already knew.
        expect(service({ [missing]: undefined }).isConfigured).toBe(false);
      },
    );

    it('refuses to send when unconfigured rather than failing at the gateway', async () => {
      await expect(
        service({ SMS_PROVIDER_API_KEY: undefined }).send({
          to: '01700000000',
          message: 'hello',
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(post).not.toHaveBeenCalled();
    });

    it('defaults to the HTTPS endpoint, and honours an override', async () => {
      accept();

      await service().send({ to: '01700000000', message: 'hello' });
      expect(post.mock.calls[0][0]).toBe(DEFAULT_SMS_ENDPOINT);

      post.mockClear();
      await service({ SMS_PROVIDER_URL: 'http://mock.test/api' }).send({
        to: '01700000000',
        message: 'hello',
      });
      expect(post.mock.calls[0][0]).toBe('http://mock.test/api');
    });
  });

  describe('the request', () => {
    beforeEach(accept);

    it('passes every field as a param rather than an interpolated URL', async () => {
      // Interpolation is what the provider's own example does, and it corrupts
      // the copy this app sends: & and spaces break the query string outright,
      // and Bengali arrives mangled.
      await service().send({
        to: '01700000000',
        message: 'Low balance: ৳80 left & falling',
      });

      expect(sentParams()).toEqual({
        api_key: 'test-key',
        type: 'unicode',
        number: '8801700000000',
        senderid: '8809648906389',
        message: 'Low balance: ৳80 left & falling',
      });

      // Null body: everything travels in the query string, as this endpoint
      // expects.
      expect(post.mock.calls[0][1]).toBeNull();
    });

    it('normalises the number before the gateway sees it', async () => {
      await service().send({ to: '+880 1700-000 000', message: 'hi' });
      expect(sentParams().number).toBe('8801700000000');
    });

    it('sends ASCII as type=text', async () => {
      await service().send({
        to: '01700000000',
        message: 'Recharge confirmed',
      });
      expect(sentParams().type).toBe('text');
    });

    it('sends Bengali as type=unicode', async () => {
      await service().send({ to: '01700000000', message: 'রিচার্জ সম্পন্ন' });
      expect(sentParams().type).toBe('unicode');
    });

    it('lets a caller override the detected alphabet', async () => {
      await service().send({
        to: '01700000000',
        message: 'plain ascii',
        encoding: 'unicode',
      });
      expect(sentParams().type).toBe('unicode');
    });

    it('does not treat a 4xx as a transport fault', async () => {
      await service().send({ to: '01700000000', message: 'hi' });

      // validateStatus lets 4xx through so the provider's own error text is
      // parsed and logged, instead of being lost inside an axios throw.
      const validateStatus = (
        post.mock.calls[0][2] as { validateStatus: (s: number) => boolean }
      ).validateStatus;

      expect(validateStatus(200)).toBe(true);
      expect(validateStatus(404)).toBe(true);
      expect(validateStatus(500)).toBe(false);
    });
  });

  describe('the response', () => {
    it('reports what it sent on a 202', async () => {
      accept();

      await expect(
        service().send({ to: '01700000000', message: 'Recharge confirmed' }),
      ).resolves.toEqual({
        to: '8801700000000',
        encoding: 'text',
        segments: 1,
      });
    });

    it('fails on a non-202 code delivered over HTTP 200', async () => {
      // The shape below is the live endpoint's, verbatim.
      post.mockResolvedValue({
        status: 200,
        data: {
          response_code: 1011,
          success_message: '',
          error_message: 'user id not found in this INVALID key',
        },
      });

      await expect(
        service().send({ to: '01700000000', message: 'hi' }),
      ).rejects.toThrow('user id not found in this INVALID key');
    });

    it('quotes the code when the provider sends no error text', async () => {
      post.mockResolvedValue({ status: 200, data: { response_code: 1007 } });

      await expect(
        service().send({ to: '01700000000', message: 'hi' }),
      ).rejects.toThrow('response_code 1007');
    });

    it('parses a JSON body served with the wrong content type', async () => {
      post.mockResolvedValue({ status: 200, data: '{"response_code":202}' });

      await expect(
        service().send({ to: '01700000000', message: 'hi' }),
      ).resolves.toMatchObject({ to: '8801700000000' });
    });

    it('fails on an HTML body from a proxy or captive portal', async () => {
      // Without this, `Number(undefined)` is NaN, NaN !== 202, and the failure
      // would surface as a confusing "response_code NaN" instead of naming the
      // real problem.
      post.mockResolvedValue({
        status: 200,
        data: '<html>Gateway Timeout</html>',
      });

      await expect(
        service().send({ to: '01700000000', message: 'hi' }),
      ).rejects.toThrow('unrecognised response');
    });

    it('turns a transport fault into a service-unavailable, not a raw axios error', async () => {
      post.mockRejectedValue(new Error('ETIMEDOUT'));

      await expect(
        service().send({ to: '01700000000', message: 'hi' }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  it('rejects an unusable number without calling the gateway', async () => {
    await expect(
      service().send({ to: '0212345678', message: 'hi' }),
    ).rejects.toThrow('Not a usable Bangladeshi mobile number');

    expect(post).not.toHaveBeenCalled();
  });
});
