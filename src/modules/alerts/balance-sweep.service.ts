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
import { ALERT_KIND, type AlertKind } from '@/database/types/alert.type';
import { MeterProvider } from '@/database/types/meter.type';
import { USAGE_GRANULARITY } from '@/database/types/usage.type';
import { type DrizzleDb } from '@/database/types/drizzle';
import {
  DEFAULT_USER_SETTINGS,
  type UserSettings,
} from '@/database/types/user-settings.type';
import { AnalyticsService } from '@/modules/analytics/analytics.service';
import {
  NescoService,
  type NescoSnapshot,
} from '@/modules/nesco/nesco.service';
import { NotificationService } from '@/modules/notification/notification.service';

import {
  ANOMALY_BASELINE_DAYS,
  DEFAULT_MAX_COST_PER_HOUR,
  DEFAULT_MAX_WINDOW_HOURS,
  DEFAULT_SWEEP_CONCURRENCY,
  DEFAULT_SWEEP_CRON,
  SWEEP_JOB_NAME,
  SWEEP_LOCK_KEY,
} from './alerts.constants';
import {
  buildUsageSample,
  resolveReadingInstant,
  type UsageSample,
} from './usage-sampling';
import { composeAlert } from './alert-messages';
import {
  INITIAL_STATE,
  evaluate,
  type PreviousState,
} from './alert-evaluation';
import { evaluateUsageAnomaly, type AnomalyFinding } from './usage-anomaly';

/**
 * Asia/Dhaka calendar helpers, as `YYYY-MM-DD`.
 *
 * Bangladesh is UTC+6 all year with no daylight saving, so shifting the instant
 * by a fixed six hours and reading the UTC date off it is exact rather than an
 * approximation — the same assumption `AnalyticsService` makes, and the reason
 * these are six lines instead of a date library.
 *
 * Local to this file because the analytics service keeps its own offset
 * private, and a shared date module for three functions used in one place would
 * be indirection without a second caller.
 */
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

function dhakaDay(instant: Date): string {
  return new Date(instant.getTime() + DHAKA_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

function dhakaToday(): string {
  return dhakaDay(new Date());
}

/** `day` shifted back by `count` days. Operates on the date, not the clock. */
function dhakaDaysBefore(day: string, count: number): string {
  const shifted = new Date(`${day}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() - count);
  return shifted.toISOString().slice(0, 10);
}

function dhakaDayBefore(day: string): string {
  return dhakaDaysBefore(day, 1);
}

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
  /** Dhaka day the last usage-anomaly alert covered. Null until one fires. */
  readonly lastAnomalyOn: string | null;
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
    private readonly analytics: AnalyticsService,
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

    // The expression alone is not reviewable — "* * 6 * *" looks like "every
    // six hours" and means "every minute on the 6th". Printing when it will
    // actually next run is what lets a human catch that on the first boot after
    // a config change, rather than a fortnight later when no sweep has run.
    this.logger.log(
      `Meter balance sweep scheduled (${expression}); next runs: ${job
        .nextDates(2)
        .map((next) => next.toISO())
        .join(', ')}`,
    );
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

      // After `recordSuccess`, so the sample this poll just wrote is part of
      // the series the baseline is built from. On its own error boundary: the
      // balance alerts above are the job this sweep exists to do, and an
      // advisory notice must not be able to mark the meter failed and have a
      // later pass redo work that already succeeded.
      const anomalies = await this.checkUsageAnomaly(row).catch(
        (anomalyError: unknown) => {
          this.logger.warn(
            `Usage-anomaly check failed for meter ${row.meterId}: ${
              anomalyError instanceof Error
                ? anomalyError.message
                : String(anomalyError)
            }`,
          );
          return 0;
        },
      );

      return result.alerts.length + anomalies;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Balance check failed for meter ${row.meterId} (${row.customerNo}): ${reason}`,
      );
      await this.recordFailure(row.meterId, reason);
      return null;
    }
  }

  /**
   * Compares the meter's last completed day against its own trailing baseline
   * and pushes at most one notice. Returns how many alerts were sent (0 or 1).
   *
   * The decision itself lives in `evaluateUsageAnomaly`, which is pure. What
   * this method owns is everything that needs the outside world: fetching the
   * series, and stamping the dedup marker so the next three sweeps today stay
   * quiet about the same day.
   */
  private async checkUsageAnomaly(row: MonitoredMeter): Promise<number> {
    const settings = { ...DEFAULT_USER_SETTINGS, ...(row.settings ?? {}) };

    // Cheapest possible exit, taken before any query: most accounts will have
    // this on, but the ones that do not should cost nothing per sweep.
    if (!settings.pushEnabled || !settings.usageAnomalyAlerts) return 0;

    const today = dhakaToday();
    const yesterday = dhakaDayBefore(today);

    // A day already reported cannot become newsworthy again, and this is the
    // branch three of every four daily sweeps take.
    if (row.lastAnomalyOn !== null && row.lastAnomalyOn >= yesterday) return 0;

    // `to: yesterday` is the load-bearing half of this range. Today is still
    // accumulating, and letting a part-finished day into the series would make
    // every morning look like a saving and the alert would never fire.
    const usage = await this.analytics.usage(row.userId, {
      granularity: USAGE_GRANULARITY.DAILY,
      from: dhakaDaysBefore(yesterday, ANOMALY_BASELINE_DAYS),
      to: yesterday,
      meterId: row.meterId,
    });

    const outcome = evaluateUsageAnomaly(
      usage.points.flatMap((point) =>
        // `date` is optional on the DTO because the `weekday` granularity has
        // no calendar date to report. Daily always sets it, so this filter
        // never drops a row in practice — it is how that invariant is stated
        // to the compiler rather than asserted past it with a `!`.
        point.date
          ? [{ day: point.date, consumedCost: point.consumedCost }]
          : [],
      ),
      row.settings,
      row.lastAnomalyOn,
    );

    if (outcome.kind !== 'anomaly') return 0;

    // Stamped before sending, matching how `recordSuccess` treats the balance
    // alerts: a dropped notification is better than one replayed every six
    // hours for a day the user has already been told about.
    await this.db
      .update(meterAlertState)
      .set({ lastAnomalyOn: outcome.finding.day, updatedAt: new Date() })
      .where(eq(meterAlertState.meterId, row.meterId));

    await this.push(row, ALERT_KIND.USAGE_ANOMALY, 0, 0, outcome.finding);

    return 1;
  }

  private async push(
    row: MonitoredMeter,
    kind: AlertKind,
    balance: number,
    rechargeAmount: number,
    anomaly: AnomalyFinding | null = null,
  ): Promise<void> {
    const settings = { ...DEFAULT_USER_SETTINGS, ...(row.settings ?? {}) };

    const copy = composeAlert(kind, settings.language, {
      meterName: row.label ?? row.customerNo,
      balance,
      threshold: settings.lowBalanceThreshold,
      rechargeAmount,
      anomalyCost: anomaly?.cost ?? 0,
      anomalyBaseline: anomaly?.baseline ?? 0,
      anomalyPercent: anomaly?.percentAbove ?? 0,
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
        // Only on the anomaly push. Spread rather than set to null because a
        // null would reach FCM as a value and be rejected on every other kind.
        ...(anomaly
          ? {
              anomalyDay: anomaly.day,
              anomalyPercent: String(anomaly.percentAbove),
            }
          : {}),
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
          lastAnomalyOn: meterAlertState.lastAnomalyOn,
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
    const reading = resolveReadingInstant(snapshot.balanceAsOf, now);

    if (reading.estimated) {
      // Not fatal, but it changes what the numbers mean: without a stamp the
      // window is bounded by our cron schedule instead of the portal's
      // settlement period, and daily costs go back to being interpolated.
      this.logger.warn(
        `Meter ${row.meterId} (${row.customerNo}) reported no usable balance stamp; falling back to poll time`,
      );
    }

    const values = {
      severity,
      lastRechargeToken,
      lastBalance: snapshot.balance,
      lastBalanceAt: reading.at,
      lastCheckedAt: now,
      lastFailureReason: null,
      consecutiveFailures: 0,
      updatedAt: now,
    };

    const sample = this.buildSample(row, snapshot, reading.at);

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
   * Both bounds are settlement instants, not poll times — see
   * `resolveReadingInstant`. That is what makes the window describe a period the
   * portal actually measured, and it is also the duplicate guard: between
   * publications the stamp repeats, the window collapses to zero length, and
   * `buildUsageSample` returns null. Polling more often therefore costs nothing
   * in accuracy and only shortens the delay before a new figure is noticed.
   *
   * Returns null on a meter's first successful poll: there is no earlier
   * balance to subtract from, so this pass only establishes the baseline and
   * the next published figure produces the first real window.
   */
  private buildSample(
    row: MonitoredMeter,
    snapshot: NescoSnapshot,
    readingAt: Date,
  ): UsageSample | null {
    if (row.lastBalance === null || row.lastBalanceAt === null) return null;

    return buildUsageSample(
      {
        openingBalance: row.lastBalance,
        closingBalance: snapshot.balance,
        windowStart: row.lastBalanceAt,
        windowEnd: readingAt,
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
