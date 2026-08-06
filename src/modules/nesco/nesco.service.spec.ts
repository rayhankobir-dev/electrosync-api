import {
  BadGatewayException,
  GatewayTimeoutException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import {
  MONTHLY_CONSUMPTION_PAGE,
  RECHARGE_HISTORY_PAGE,
} from './portal/__fixtures__/nesco-pages';
import { NescoPortalClient } from './portal/nesco-portal.client';
import { SUBMIT_TYPE } from './portal/nesco.constants';
import { NescoFailureReason, NescoPortalError } from './portal/nesco.errors';
import { NescoService } from './nesco.service';

const CUSTOMER_NO = '33009605';

function serviceWith(fetchReport: jest.Mock): NescoService {
  return new NescoService({ fetchReport } as unknown as NescoPortalClient);
}

describe('NescoService', () => {
  it('fetches the portal once for customer info, balance included', async () => {
    const fetchReport = jest.fn().mockResolvedValue(RECHARGE_HISTORY_PAGE);

    const info = await serviceWith(fetchReport).getCustomerInfo(CUSTOMER_NO);

    // The original script issued a second full round trip just to read the
    // balance that the same page already carries.
    expect(fetchReport).toHaveBeenCalledTimes(1);
    expect(fetchReport).toHaveBeenCalledWith(
      CUSTOMER_NO,
      SUBMIT_TYPE.RECHARGE_HISTORY,
    );
    expect(info.currentBalance).toBe(1523.45);
  });

  it('requests the consumption report for consumption lookups', async () => {
    const fetchReport = jest.fn().mockResolvedValue(MONTHLY_CONSUMPTION_PAGE);

    const months =
      await serviceWith(fetchReport).getMonthlyConsumption(CUSTOMER_NO);

    expect(fetchReport).toHaveBeenCalledWith(
      CUSTOMER_NO,
      SUBMIT_TYPE.MONTHLY_CONSUMPTION,
    );
    expect(months).toHaveLength(1);
  });

  describe('failure mapping', () => {
    let warn: jest.SpyInstance;

    beforeEach(() => {
      // Every case here drives the failure path on purpose, and that path logs.
      // Capturing the logger keeps a passing run quiet — alarming output on a
      // green suite is how people learn to ignore their logs — and lets the
      // warning itself be asserted rather than merely tolerated.
      warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
    });

    afterEach(() => {
      warn.mockRestore();
    });

    const cases: ReadonlyArray<[NescoFailureReason, unknown, number]> = [
      ['CUSTOMER_NOT_FOUND', NotFoundException, 404],
      ['LAYOUT_CHANGED', BadGatewayException, 502],
      ['UPSTREAM_ERROR', BadGatewayException, 502],
      ['UPSTREAM_TIMEOUT', GatewayTimeoutException, 504],
      ['UPSTREAM_UNREACHABLE', ServiceUnavailableException, 503],
    ];

    it.each(cases)('maps %s to HTTP %s', async (reason, exception, status) => {
      const fetchReport = jest
        .fn()
        .mockRejectedValue(new NescoPortalError(reason, 'upstream failed'));

      await expect(
        serviceWith(fetchReport).getBalance(CUSTOMER_NO),
      ).rejects.toBeInstanceOf(exception as never);

      await expect(
        serviceWith(fetchReport).getBalance(CUSTOMER_NO),
      ).rejects.toMatchObject({ status });

      // The client-facing message is deliberately vague, so the log is the only
      // place the real cause survives for triage.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`[${reason}]`));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(CUSTOMER_NO));
    });

    it('lets non-portal errors through untouched, so real bugs stay visible', async () => {
      const bug = new TypeError('someObject.reduce is not a function');
      const fetchReport = jest.fn().mockRejectedValue(bug);

      await expect(
        serviceWith(fetchReport).getBalance(CUSTOMER_NO),
      ).rejects.toBe(bug);
    });
  });
});
