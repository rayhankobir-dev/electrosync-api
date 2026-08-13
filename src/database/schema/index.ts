import { ObjectId } from 'bson';
import { relations } from 'drizzle-orm';

import { ALERT_SEVERITY, type AlertSeverity } from '../types/alert.type';
import {
  DEFAULT_METER_PROVIDER,
  DEFAULT_METER_TYPE,
  MeterProvider,
  MeterType,
} from '../types/meter.type';
import type { UserSettings } from '../types/user-settings.type';
import type { UsageAnomaly } from '../types/usage.type';
import {
  pgTable,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Short-lived one-time codes, keyed by whatever they were issued to.
 *
 * Currently only password reset (`type = 'password_reset'`, `identifier` = the
 * normalised email), but the shape is deliberately generic so email
 * verification can share it rather than growing a near-identical table.
 *
 * `value` holds an argon2 hash of the code, never the code itself. A read-only
 * leak of this table must not hand the reader a working reset code for every
 * pending request.
 */
export const verification = pgTable(
  'verification',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => new ObjectId().toHexString()),
    identifier: text('identifier').notNull(),
    type: text('type').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    /**
     * Failed verify attempts against this row.
     *
     * Load-bearing for a 6-digit code: a million-value keyspace falls to brute
     * force quickly without a ceiling, and expiry alone does not provide one —
     * an attacker inside the 15-minute window otherwise has as many guesses as
     * the network allows.
     */
    attempts: integer('attempts').notNull().default(0),
    /**
     * When the code was redeemed. Set once, and checked on every lookup, which
     * is what makes a code single-use — without it a code stays live for the
     * remainder of its window *after* the password has already been changed.
     */
    consumedAt: timestamp('consumed_at'),
    createdAt: timestamp('created_at')
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: timestamp('updated_at')
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    // Every read filters on this pair: the newest live code for an identifier,
    // and the count of recent rows for it that drives rate limiting.
    index('verification_identifier_type_idx').on(table.identifier, table.type),
  ],
);

export const VERIFICATION_TYPE = {
  PASSWORD_RESET: 'password_reset',
} as const;

export type VerificationType =
  (typeof VERIFICATION_TYPE)[keyof typeof VERIFICATION_TYPE];

export const user = pgTable('user', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => new ObjectId().toHexString()),
  name: text('first_name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false),
  mobile: text('mobile'),
  settings: jsonb().$type<UserSettings>(),
  createdAt: timestamp('created_at')
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: timestamp('updated_at')
    .$defaultFn(() => new Date())
    .notNull(),
});

export const account = pgTable(
  'account',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => new ObjectId().toHexString()),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    scope: text('scope'),
    idToken: text('id_token'),
    password: text('password'),
    createdAt: timestamp('created_at')
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: timestamp('updated_at')
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('account_user_id_provider_idx').on(table.userId, table.providerId),
  ],
);

export const meter = pgTable(
  'meter',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => new ObjectId().toHexString()),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    customerNo: text('customer_no').notNull(),
    label: text('label'),
    type: text('type').$type<MeterType>().notNull().default(DEFAULT_METER_TYPE),
    provider: text('provider')
      .$type<MeterProvider>()
      .notNull()
      .default(DEFAULT_METER_PROVIDER),
    isPrimary: boolean('is_primary').default(false).notNull(),
    createdAt: timestamp('created_at')
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: timestamp('updated_at')
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    // All three columns, not just user_id: the same customer number can be
    // held at two different providers, and a user is expected to have several
    // meters. Narrowing this to user_id would cap every account at one meter.
    uniqueIndex('meter_user_id_provider_customer_no_idx').on(
      table.userId,
      table.provider,
      table.customerNo,
    ),
  ],
);

export const deviceToken = pgTable(
  'device_token',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => new ObjectId().toHexString()),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    platform: text('platform').notNull(),
    deviceId: text('device_id'),
    isActive: boolean('is_active').default(true),
    lastUsedAt: timestamp('last_used_at'),
    createdAt: timestamp('created_at')
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: timestamp('updated_at')
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('device_token_user_id_active_idx').on(table.userId, table.isActive),
  ],
);

export const notification = pgTable(
  'notification',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => new ObjectId().toHexString()),
    title: text('title').notNull(),
    body: text('body').notNull(),
    data: jsonb('data').$type<Record<string, any>>(),
    readAt: timestamp('read_at'),
    archivedAt: timestamp('archived_at'),
    sentAt: timestamp('sent_at')
      .$defaultFn(() => new Date())
      .notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at')
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('notification_user_id_sent_at_idx').on(table.userId, table.sentAt),
  ],
);

export const meterAlertState = pgTable('meter_alert_state', {
  meterId: text('meter_id')
    .primaryKey()
    .references(() => meter.id, { onDelete: 'cascade' }),
  severity: text('severity')
    .$type<AlertSeverity>()
    .notNull()
    .default(ALERT_SEVERITY.OK),
  lastBalance: doublePrecision('last_balance'),
  /**
   * The instant `lastBalance` describes — the portal's own settlement stamp,
   * not when we fetched it. Advanced only by a *successful* poll, unlike
   * `lastCheckedAt`, which moves on every attempt including failures.
   *
   * Two clocks are in play and confusing them is what made daily costs
   * fictional: NESCO settles balances in a batch and prints the covered instant
   * beside the figure, so consecutive stamps bound exactly one settlement
   * period while consecutive poll times bound nothing but our cron schedule.
   * Usage sampling chains each window off this column, which is why it holds
   * validity time; `lastCheckedAt` holds observation time and the two are
   * routinely hours apart.
   */
  lastBalanceAt: timestamp('last_balance_at', { withTimezone: true }),
  lastRechargeToken: text('last_recharge_token'),
  /**
   * Asia/Dhaka calendar day the last usage-anomaly alert was *about*, as
   * `YYYY-MM-DD`. Null until one fires.
   *
   * The dedup key for anomaly alerts, and it has to record the subject day
   * rather than a "last sent at" instant: the sweep runs four times a day and
   * every one of those passes re-evaluates the same completed yesterday. Keyed
   * on the day being reported, passes two through four recognise their own
   * earlier work and stay quiet. A timestamp would need a "was that within the
   * same Dhaka day?" comparison to reach the same answer, and would get it
   * wrong across the midnight boundary the alert is defined by.
   */
  lastAnomalyOn: text('last_anomaly_on'),
  lastCheckedAt: timestamp('last_checked_at'),
  lastFailureReason: text('last_failure_reason'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  createdAt: timestamp('created_at')
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: timestamp('updated_at')
    .$defaultFn(() => new Date())
    .notNull(),
});

/**
 * What one meter consumed between two consecutive successful polls.
 *
 * The NESCO portal reports a balance, never a cost, so consumption is derived:
 * whatever the balance fell by, plus whatever was credited into it meanwhile.
 * Each row is one such window, written by the balance sweep at no extra cost —
 * the sweep already holds both numbers when it checks for a low balance.
 *
 * Windows chain off `meter_alert_state.last_balance_at`, so consecutive rows
 * tile the timeline with no gap and no overlap. That also makes the composite
 * primary key a true natural key: a meter plus a window start *is* the
 * measurement, so a replayed sweep collides instead of double-counting. This
 * is the whole duplicate-protection strategy — enforced by Postgres rather
 * than by remembering to check.
 *
 * Deliberately stored raw, one row per window, rather than accumulated into
 * daily totals. Day boundaries, timezone, and pro-rata splitting are read-time
 * concerns; baking them in would make every one of those decisions permanent.
 */
export const meterUsageSample = pgTable(
  'meter_usage_sample',
  {
    meterId: text('meter_id')
      .notNull()
      .references(() => meter.id, { onDelete: 'cascade' }),
    /** Previous successful reading. Exclusive bound: `(start, end]`. */
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    /** This reading. */
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    openingBalance: doublePrecision('opening_balance').notNull(),
    closingBalance: doublePrecision('closing_balance').notNull(),
    /**
     * Recharge `usableAmount` credited during the window — what the balance
     * actually rose by, after meter rent, demand charge and VAT.
     *
     * This is the figure the cost arithmetic needs. Using the gross amount
     * paid would over-credit the balance and understate consumption by the
     * difference, which on a ৳500 top-up is around ৳100.
     */
    rechargeCredited: doublePrecision('recharge_credited').notNull().default(0),
    /** Gross `rechargeAmount` paid — what the user reports as "spent". */
    rechargePaid: doublePrecision('recharge_paid').notNull().default(0),
    /** Never negative. Zeroed when `anomaly` says the reading was unusable. */
    consumedCost: doublePrecision('consumed_cost').notNull(),
    /**
     * The unclamped result. Kept so a suppressed reading stays inspectable —
     * without it, "we ignored something" and "nothing happened" look
     * identical.
     */
    rawDelta: doublePrecision('raw_delta').notNull(),
    anomaly: text('anomaly').$type<UsageAnomaly>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: 'meter_usage_sample_pk',
      columns: [table.meterId, table.windowStart],
    }),
    // Analytics selects windows *overlapping* a range, so it filters on
    // window_end as well. The primary key's leading columns already serve
    // `meter_id = ? AND window_start < ?`; this covers the other side.
    index('meter_usage_sample_meter_id_window_end_idx').on(
      table.meterId,
      table.windowEnd,
    ),
  ],
);

export const userRelations = relations(user, ({ many }) => ({
  accounts: many(account),
  meters: many(meter),
  deviceTokens: many(deviceToken),
  notifications: many(notification),
}));

export const meterRelations = relations(meter, ({ one, many }) => ({
  user: one(user, {
    fields: [meter.userId],
    references: [user.id],
  }),
  alertState: one(meterAlertState, {
    fields: [meter.id],
    references: [meterAlertState.meterId],
  }),
  usageSamples: many(meterUsageSample),
}));

export const meterUsageSampleRelations = relations(
  meterUsageSample,
  ({ one }) => ({
    meter: one(meter, {
      fields: [meterUsageSample.meterId],
      references: [meter.id],
    }),
  }),
);

export const meterAlertStateRelations = relations(
  meterAlertState,
  ({ one }) => ({
    meter: one(meter, {
      fields: [meterAlertState.meterId],
      references: [meter.id],
    }),
  }),
);

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const deviceTokenRelations = relations(deviceToken, ({ one }) => ({
  user: one(user, {
    fields: [deviceToken.userId],
    references: [user.id],
  }),
}));

export const notificationRelations = relations(notification, ({ one }) => ({
  user: one(user, {
    fields: [notification.userId],
    references: [user.id],
  }),
}));
