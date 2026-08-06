import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { eq, sql } from 'drizzle-orm';

import {
  AdvisoryLockService,
  LOCK_NOT_ACQUIRED,
} from '@/database/advisory-lock.service';
import { DRIZZLE } from '@/database/constants/database.constants';
import {
  meter,
  meterAlertState,
  meterUsageSample,
  user,
} from '@/database/schema';
import { type AlertKind } from '@/database/types/alert.type';
import { MeterProvider } from '@/database/types/meter.type';
import { type DrizzleDb } from '@/database/types/drizzle';
import {
  DEFAULT_USER_SETTINGS,
  type UserSettings,
} from '@/database/types/user-settings.type';
import { NescoService, type NescoSnapshot } from '@/modules/nesco/nesco.service';
import { NotificationService } from '@/modules/notification/notification.service';

import {
  DEFAULT_MAX_COST_PER_HOUR,
  DEFAULT_MAX_WINDOW_HOURS,
  DEFAULT_SWEEP_CONCURRENCY,
  DEFAULT_SWEEP_CRON,
  SWEEP_JOB_NAME,
  SWEEP_LOCK_KEY,
} from './alerts.constants';
import { buildUsageSample, type UsageSample } from './usage-sampling';
import { composeAlert } from './alert-messages';
import {
  INITIAL_STATE,
  evaluate,
  type PreviousState,
} from './alert-evaluation';

interface MonitoredMeter {
  readonly meterId: string;
  readonly userId: string;
  readonly customerNo: string;
  readonly label: string | null;
  readonly settings: UserSettings | null;
  readonly severity: string | null;
  readonly lastRechargeToken: string | null;
  /** Opening balance for the next usage sample. Null until the first poll. */
  readonly lastBalance: number | null;
  /** Start of the next usage window. Advances only on a successful poll. */
  readonly lastBalanceAt: Date | null;
}

export interface SweepSummary {
  readonly checked: number;
  readonly failed: number;
  readonly alertsSent: number;
  readonly skipped: boolean;
}

/**
 * Polls every monitored meter on a schedule and pushes balance alerts.
 *
 * The job owns no alerting policy of its own — `alert-evaluation.ts` decides
 * what to send and `NotificationService` decides how to deliver it. What lives
 * here is the part that needs the outside world: scheduling, the advisory
 * lock, concurrency, and turning a scrape failure into a logged row rather
 * than a crashed job.
 */
@Injectable()
export class BalanceSweepService implements OnModuleInit {
  private readonly logger = new Logger(BalanceSweepService.name);
  private running = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly locks: AdvisoryLockService,
    private readonly config: ConfigService,
    private readonly nesco: NescoService,
    private readonly notifications: NotificationService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  /**
   * Registers the job at runtime rather than with a `@Cron()` decorator.
   *
   * Decorator arguments are evaluated when the class is defined, which is
   * before `ConfigService` exists — so a decorator could not read the schedule
   * from the environment. Registering here is what makes `ALERTS_CRON` and
   * `ALERTS_ENABLED` actually configurable per deployment.
   */
  onModuleInit(): void {
    if (!this.config.get<boolean>('ALERTS_ENABLED')) {
      this.logger.log('Meter balance sweep is disabled (ALERTS_ENABLED=false)');
      return;
    }

    const expression =
      this.config.get<string>('ALERTS_CRON') ?? DEFAULT_SWEEP_CRON;

    const job = new CronJob(expression, () => {
      void this.runSweep();
    });

    this.scheduler.addCronJob(SWEEP_JOB_NAME, job as never);
    job.start();

    this.logger.log(`Meter balance sweep scheduled (${expression})`);
  }

  /**
   * Runs one full pass. Safe to call directly — the API surface a manual
   * "check now" endpoint or a test would use.
   */
  async runSweep(): Promise<SweepSummary> {
    const idle: SweepSummary = {
      checked: 0,
      failed: 0,
      alertsSent: 0,
      skipped: true,
    };

    // Guards against a sweep that outlives its own interval — with hundreds of
    // meters and a slow portal, a six-hour window is generous but not
    // infinite, and overlapping passes would double-poll every meter.
    if (this.running) {
      this.logger.warn('Skipping sweep: the previous one is still running');
      return idle;
    }

    this.running = true;
    try {
      // Without the lock, two instances behind a load balancer both wake at
      // the top of the hour, both read `severity = 'OK'`, and both push the
      // same alert — the dedup state cannot help, because neither has written
      // it yet when the other reads.
      const result = await this.locks.runExclusively(SWEEP_LOCK_KEY, () =>
        this.sweep(),
      );

      if (result === LOCK_NOT_ACQUIRED) {
        this.logger.log('Another instance is already sweeping; standing down');
        return idle;
      }

      return result;
    } catch (error) {
      // A cron tick has no caller to catch for it: anything thrown here would
      // surface as an unhandled rejection and, depending on the Node flags,
      // take the process down.
      this.logger.error(
        `Meter balance sweep failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return idle;
    } finally {
      this.running = false;
    }
  }

  private async sweep(): Promise<SweepSummary> {
    const meters = await this.monitoredMeters();

    if (meters.length === 0) {
      return { checked: 0, failed: 0, alertsSent: 0, skipped: false };
    }

    const started = Date.now();
    let failed = 0;
    let alertsSent = 0;

    const concurrency =
      this.config.get<number>('ALERTS_CONCURRENCY') ??
      DEFAULT_SWEEP_CONCURRENCY;

    for (let i = 0; i < meters.length; i += concurrency) {
      const batch = meters.slice(i, i + concurrency);

      const outcomes = await Promise.all(
        batch.map((row) => this.pollMeter(row)),
      );

      for (const outcome of outcomes) {
        if (outcome === null) failed += 1;
        else alertsSent += outcome;
      }
    }

    const seconds = Math.round((Date.now() - started) / 1000);
    this.logger.log(
      `Sweep finished in ${seconds}s: ${meters.length} meter(s), ${failed} failure(s), ${alertsSent} alert(s) sent`,
    );

    return { checked: meters.length, failed, alertsSent, skipped: false };
  }

  /**
   * Polls one meter. Returns the number of alerts sent, or null if the scrape
   * failed.
   *
   * A failure here is deliberately not rethrown: one unreachable customer
   * number (or one portal hiccup) must not abort the pass for everybody else.
   * It is counted in `meter_alert_state` instead, so a meter that has been
   * failing for days is visible rather than merely absent from the logs.
   */
  private async pollMeter(row: MonitoredMeter): Promise<number | null> {
    try {
      const snapshot = await this.nesco.getRechargeSnapshot(row.customerNo);
      const now = new Date();

      const previous: PreviousState = row.severity
        ? {
            severity: row.severity as PreviousState['severity'],
            lastRechargeToken: row.lastRechargeToken,
          }
        : INITIAL_STATE;

      const result = evaluate(previous, snapshot, row.settings);

      // Persisted before sending: if the push fails we would rather drop an
      // alert than replay it on the next sweep, and a duplicate "your balance
      // is low" every six hours is the worse failure by far.
      await this.recordSuccess(
        row,
        result.severity,
        result.lastRechargeToken,
        snapshot,
        now,
      );

      for (const kind of result.alerts) {
        await this.push(
          row,
          kind,
          snapshot.balance,
          result.newRecharge?.rechargeAmount ?? 0,
        );
      }

      return result.alerts.length;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Balance check failed for meter ${row.meterId} (${row.customerNo}): ${reason}`,
      );
      await this.recordFailure(row.meterId, reason);
      return null;
    }
  }

  private async push(
    row: MonitoredMeter,
    kind: AlertKind,
    balance: number,
    rechargeAmount: number,
  ): Promise<void> {
    const settings = { ...DEFAULT_USER_SETTINGS, ...(row.settings ?? {}) };

    const copy = composeAlert(kind, settings.language, {
      meterName: row.label ?? row.customerNo,
      balance,
      threshold: settings.lowBalanceThreshold,
      rechargeAmount,
    });

    await this.notifications.sendToUser(row.userId, {
      title: copy.title,
      body: copy.body,
      // FCM data values must be strings — anything else is rejected by the
      // send call at runtime rather than at compile time.
      data: {
        kind,
        meterId: row.meterId,
        customerNo: row.customerNo,
        balance: String(balance),
      },
    });
  }

  private async monitoredMeters(): Promise<MonitoredMeter[]> {
    return (
      this.db
        .select({
          meterId: meter.id,
          userId: meter.userId,
          customerNo: meter.customerNo,
          label: meter.label,
          settings: user.settings,
          severity: meterAlertState.severity,
          lastRechargeToken: meterAlertState.lastRechargeToken,
          lastBalance: meterAlertState.lastBalance,
          lastBalanceAt: meterAlertState.lastBalanceAt,
        })
        .from(meter)
        .innerJoin(user, eq(user.id, meter.userId))
        .leftJoin(meterAlertState, eq(meterAlertState.meterId, meter.id))
        // NESCO is the only provider with a portal client. DESCO and DPDC exist
        // as enum values with no scraper behind them, so including them would
        // guarantee a failure row per sweep.
        .where(eq(meter.provider, MeterProvider.NESCO))
    );
  }

  /**
   * Commits everything a successful poll learned: the alert state, and the
   * usage sample covering the ground since the previous reading.
   *
   * Both writes share one transaction, and that is load-bearing. The sample's
   * primary key is `(meter_id, window_start)`, so a replay of the same window
   * is silently ignored — exactly what protects against double-counting. But
   * if the sample committed and the state update did not, `last_balance_at`
   * would stay put, the next sweep would recompute the *same* window_start,
   * and the conflict rule would discard a genuine twelve hours of consumption.
   * Atomicity is what keeps the duplicate guard from turning into data loss.
   */
  private async recordSuccess(
    row: MonitoredMeter,
    severity: PreviousState['severity'],
    lastRechargeToken: string | null,
    snapshot: NescoSnapshot,
    now: Date,
  ): Promise<void> {
    const values = {
      severity,
      lastRechargeToken,
      lastBalance: snapshot.balance,
      lastBalanceAt: now,
      lastCheckedAt: now,
      lastFailureReason: null,
      consecutiveFailures: 0,
      updatedAt: now,
    };

    const sample = this.buildSample(row, snapshot, now);

    await this.db.transaction(async (tx) => {
      if (sample) {
        await tx
          .insert(meterUsageSample)
          .values({ meterId: row.meterId, ...sample })
          // The same window can only ever describe the same measurement, so a
          // collision is a replay and there is nothing to update.
          .onConflictDoNothing();
      }

      await tx
        .insert(meterAlertState)
        .values({ meterId: row.meterId, ...values })
        .onConflictDoUpdate({ target: meterAlertState.meterId, set: values });
    });
  }

  /**
   * Turns the previous reading and this one into a usage sample.
   *
   * Returns null on a meter's first successful poll: there is no earlier
   * balance to subtract from, so this pass only establishes the baseline and
   * the next sweep produces the first real window.
   */
  private buildSample(
    row: MonitoredMeter,
    snapshot: NescoSnapshot,
    now: Date,
  ): UsageSample | null {
    if (row.lastBalance === null || row.lastBalanceAt === null) return null;

    return buildUsageSample(
      {
        openingBalance: row.lastBalance,
        closingBalance: snapshot.balance,
        windowStart: row.lastBalanceAt,
        windowEnd: now,
        recharges: snapshot.recharges,
      },
      {
        maxCostPerHour:
          this.config.get<number>('USAGE_MAX_COST_PER_HOUR') ??
          DEFAULT_MAX_COST_PER_HOUR,
        maxWindowHours:
          this.config.get<number>('USAGE_MAX_WINDOW_HOURS') ??
          DEFAULT_MAX_WINDOW_HOURS,
      },
    );
  }

  private async recordFailure(meterId: string, reason: string): Promise<void> {
    const now = new Date();

    await this.db
      .insert(meterAlertState)
      .values({
        meterId,
        lastCheckedAt: now,
        lastFailureReason: reason,
        consecutiveFailures: 1,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: meterAlertState.meterId,
        set: {
          lastCheckedAt: now,
          lastFailureReason: reason,
          // Severity is intentionally left untouched: a failed scrape is not
          // evidence the balance changed, and resetting it would re-fire the
          // alert once the portal recovers.
          //
          // `lastBalanceAt` is likewise untouched, for the same reason in a
          // different currency: no balance was read, so the open usage window
          // is still open. The next success closes a twelve-hour window rather
          // than mislabelling it as six.
          consecutiveFailures: sql`${meterAlertState.consecutiveFailures} + 1`,
          updatedAt: now,
        },
      });
  }
}
