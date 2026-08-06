import {
  ALERT_KIND,
  ALERT_SEVERITY,
  type AlertKind,
  type AlertSeverity,
  severityRank,
} from '@/database/types/alert.type';
import {
  DEFAULT_USER_SETTINGS,
  type UserSettings,
} from '@/database/types/user-settings.type';
import type { NescoRechargeDto } from '@/modules/nesco/dto/nesco-response.dto';

/** What the sweep knew about a meter before this poll. */
export interface PreviousState {
  readonly severity: AlertSeverity;
  readonly lastRechargeToken: string | null;
}

export interface Reading {
  readonly balance: number;
  readonly recharges: readonly NescoRechargeDto[];
}

export interface Evaluation {
  /** Severity to persist, whether or not anything was sent. */
  readonly severity: AlertSeverity;
  /** Recharge token to persist, whether or not anything was sent. */
  readonly lastRechargeToken: string | null;
  /** Alerts the user should actually receive, in the order to send them. */
  readonly alerts: readonly AlertKind[];
  /** The recharge that triggered RECHARGE_DETECTED, when one did. */
  readonly newRecharge: NescoRechargeDto | null;
}

/**
 * A meter that has never been polled.
 *
 * Starting at OK rather than at "unknown" is what makes a meter that is
 * *already* low when it is first added produce an alert on the very first
 * sweep — the OK -> LOW transition is real from the user's point of view even
 * though we have no history.
 */
export const INITIAL_STATE: PreviousState = {
  severity: ALERT_SEVERITY.OK,
  lastRechargeToken: null,
};

export function severityFor(balance: number, threshold: number): AlertSeverity {
  if (balance <= 0) return ALERT_SEVERITY.DEPLETED;
  if (balance < threshold) return ALERT_SEVERITY.LOW;
  return ALERT_SEVERITY.OK;
}

/**
 * The most recent *successful* recharge, or null.
 *
 * Sorted by date rather than trusting row order: the report's `sn` column is a
 * serial within the report, and nothing in the portal's contract promises the
 * newest row comes first. Pending/failed rows are skipped so a recharge that
 * never landed cannot mask the one that did.
 */
export function latestRecharge(
  recharges: readonly NescoRechargeDto[],
): NescoRechargeDto | null {
  let newest: NescoRechargeDto | null = null;

  for (const recharge of recharges) {
    if (recharge.rechargeStatus !== 'success') continue;
    if (newest === null || recharge.rechargedDate > newest.rechargedDate) {
      newest = recharge;
    }
  }

  return newest;
}

function resolve(settings: UserSettings | null): Required<UserSettings> {
  return { ...DEFAULT_USER_SETTINGS, ...(settings ?? {}) };
}

/**
 * Decides what to persist and what to send for one meter.
 *
 * Two rules carry the whole design:
 *
 * 1. **Alert on worsening only.** A notification goes out when severity moves
 *    up the rank (OK -> LOW, LOW -> DEPLETED, OK -> DEPLETED). Sitting at LOW
 *    across a hundred sweeps sends nothing more; recovering to OK silently
 *    re-arms the alert. No hysteresis band is needed because a prepaid balance
 *    only rises on a recharge and only falls on consumption — it cannot
 *    oscillate around the threshold on its own.
 *
 * 2. **State is recorded even when alerts are muted.** The returned severity
 *    and token reflect reality regardless of the user's settings, so turning
 *    an alert back on does not replay a crossing that happened while it was
 *    off.
 */
export function evaluate(
  previous: PreviousState,
  reading: Reading,
  rawSettings: UserSettings | null,
): Evaluation {
  const settings = resolve(rawSettings);
  const severity = severityFor(reading.balance, settings.lowBalanceThreshold);
  const newest = latestRecharge(reading.recharges);
  const lastRechargeToken = newest?.token ?? previous.lastRechargeToken;

  const alerts: AlertKind[] = [];

  // A first sight of a meter is not a recharge event. Without this, adding a
  // meter would immediately push "you recharged!" for a top-up that may be
  // months old.
  const isNewRecharge =
    newest !== null &&
    previous.lastRechargeToken !== null &&
    newest.token !== previous.lastRechargeToken;

  const newRecharge = isNewRecharge ? newest : null;

  if (!settings.pushEnabled) {
    return { severity, lastRechargeToken, alerts, newRecharge: null };
  }

  if (isNewRecharge && settings.rechargeAlerts) {
    alerts.push(ALERT_KIND.RECHARGE_DETECTED);
  }

  const worsened =
    severityRank(severity) > severityRank(previous.severity) &&
    settings.lowBalanceAlerts;

  if (worsened) {
    alerts.push(
      severity === ALERT_SEVERITY.DEPLETED
        ? ALERT_KIND.BALANCE_DEPLETED
        : ALERT_KIND.LOW_BALANCE,
    );
  }

  return {
    severity,
    lastRechargeToken,
    alerts,
    newRecharge: alerts.includes(ALERT_KIND.RECHARGE_DETECTED)
      ? newRecharge
      : null,
  };
}
