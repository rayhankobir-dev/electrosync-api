import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { NescoPortalClient } from './portal/nesco-portal.client';
import { SUBMIT_TYPE } from './portal/nesco.constants';
import { NescoPortalError, isNescoPortalError } from './portal/nesco.errors';
import {
  parseBalance,
  parseCustomerInfo,
  parseMonthlyConsumption,
  parseRechargeHistory,
} from './portal/nesco.parsing';
import {
  NescoBalanceDto,
  NescoCustomerInfoDto,
  NescoMonthlyConsumptionDto,
  NescoRechargeDto,
} from './dto/nesco-response.dto';

/** Balance plus recharge history, read from one fetch of the same page. */
export interface NescoSnapshot {
  readonly balance: number;
  readonly recharges: NescoRechargeDto[];
}

/**
 * Composes the portal client with the parsers and translates the module's
 * failure vocabulary into HTTP semantics.
 *
 * This is the only place that knows both about scraping and about status
 * codes, which keeps the client and parsers reusable outside a web context.
 */
@Injectable()
export class NescoService {
  private readonly logger = new Logger(NescoService.name);

  constructor(private readonly portal: NescoPortalClient) {}

  async getBalance(customerNo: string): Promise<NescoBalanceDto> {
    return this.guard(customerNo, async () => {
      const html = await this.portal.fetchReport(
        customerNo,
        SUBMIT_TYPE.RECHARGE_HISTORY,
      );

      return {
        consumerNo: customerNo,
        balance: parseBalance(html, customerNo),
      };
    });
  }

  /**
   * Balance is part of the same detail form as the rest of the customer data,
   * so this deliberately fetches once. The original script requested the portal
   * twice here — a second full round trip for a value already in hand.
   */
  async getCustomerInfo(customerNo: string): Promise<NescoCustomerInfoDto> {
    return this.guard(customerNo, async () => {
      const html = await this.portal.fetchReport(
        customerNo,
        SUBMIT_TYPE.RECHARGE_HISTORY,
      );

      return parseCustomerInfo(html, customerNo);
    });
  }

  /**
   * Balance and recharge history from a single portal round trip.
   *
   * Both values are parsed out of the same `RECHARGE_HISTORY` page, so calling
   * `getBalance()` and `getRechargeHistory()` back to back would scrape it
   * twice. Irrelevant for one interactive request; not irrelevant for the
   * scheduled sweep, which does this for every meter in the system and is the
   * reason this method exists.
   */
  async getRechargeSnapshot(customerNo: string): Promise<NescoSnapshot> {
    return this.guard(customerNo, async () => {
      const html = await this.portal.fetchReport(
        customerNo,
        SUBMIT_TYPE.RECHARGE_HISTORY,
      );

      return {
        balance: parseBalance(html, customerNo),
        recharges: parseRechargeHistory(html),
      };
    });
  }

  async getRechargeHistory(customerNo: string): Promise<NescoRechargeDto[]> {
    return this.guard(customerNo, async () => {
      const html = await this.portal.fetchReport(
        customerNo,
        SUBMIT_TYPE.RECHARGE_HISTORY,
      );

      return parseRechargeHistory(html);
    });
  }

  async getMonthlyConsumption(
    customerNo: string,
  ): Promise<NescoMonthlyConsumptionDto[]> {
    return this.guard(customerNo, async () => {
      const html = await this.portal.fetchReport(
        customerNo,
        SUBMIT_TYPE.MONTHLY_CONSUMPTION,
      );

      return parseMonthlyConsumption(html);
    });
  }

  private async guard<T>(
    customerNo: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (isNescoPortalError(error)) {
        this.logger.warn(
          `NESCO lookup failed for ${customerNo} [${error.reason}]: ${error.message}`,
        );
        throw this.toHttpException(error);
      }
      throw error;
    }
  }

  /**
   * Maps every portal failure to a status code.
   *
   * The `never` assignment in the default branch is load-bearing: adding a new
   * `NescoFailureReason` without handling it here fails the build instead of
   * degrading into an opaque 500 at runtime.
   */
  private toHttpException(error: NescoPortalError): HttpException {
    switch (error.reason) {
      case 'CUSTOMER_NOT_FOUND':
        return new NotFoundException(
          'No NESCO prepaid customer matches that customer number.',
        );

      case 'LAYOUT_CHANGED':
        return new BadGatewayException(
          'The NESCO portal returned a page this service no longer recognises.',
        );

      case 'UPSTREAM_ERROR':
        return new BadGatewayException(
          'The NESCO portal rejected the request.',
        );

      case 'UPSTREAM_TIMEOUT':
        return new GatewayTimeoutException(
          'The NESCO portal took too long to respond.',
        );

      case 'UPSTREAM_UNREACHABLE':
        return new ServiceUnavailableException(
          'The NESCO portal is currently unreachable.',
        );

      default: {
        const unhandled: never = error.reason;
        throw new Error(`Unhandled NESCO failure reason: ${String(unhandled)}`);
      }
    }
  }
}
