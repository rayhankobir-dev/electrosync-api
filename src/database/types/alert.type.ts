/**
 * How bad a meter's balance is, as of the last scheduled poll.
 *
 * Ordered deliberately: the numeric rank below is what lets the sweep decide
 * "did this get worse?" without a transition table. Alerts fire only on an
 * increase in rank, which is what makes a balance sitting below the threshold
 * for days produce one notification rather than one per sweep.
 */
export const ALERT_SEVERITY = {
  OK: 'OK',
  LOW: 'LOW',
  DEPLETED: 'DEPLETED',
} as const;

export type AlertSeverity =
  (typeof ALERT_SEVERITY)[keyof typeof ALERT_SEVERITY];

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  [ALERT_SEVERITY.OK]: 0,
  [ALERT_SEVERITY.LOW]: 1,
  [ALERT_SEVERITY.DEPLETED]: 2,
};

export function severityRank(severity: AlertSeverity): number {
  return SEVERITY_RANK[severity];
}

/** Kind of push the sweep produced, carried in the notification's `data`. */
export const ALERT_KIND = {
  LOW_BALANCE: 'LOW_BALANCE',
  BALANCE_DEPLETED: 'BALANCE_DEPLETED',
  RECHARGE_DETECTED: 'RECHARGE_DETECTED',
  /**
   * A day's consumption well above this meter's own recent normal.
   *
   * The odd one out: the other three are decided from the balance reading the
   * sweep just took, so they need no history and fire on the first poll. This
   * one reads back the usage samples the sweep has been accumulating and
   * therefore cannot fire until a meter has been watched for a week. See
   * `usage-anomaly.ts`.
   */
  USAGE_ANOMALY: 'USAGE_ANOMALY',
} as const;

export type AlertKind = (typeof ALERT_KIND)[keyof typeof ALERT_KIND];
