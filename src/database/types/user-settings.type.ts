export interface UserSettings {
  pushEnabled?: boolean;
  lowBalanceAlerts?: boolean;
  lowBalanceThreshold?: number;
  rechargeAlerts?: boolean;
  /** Alert when a day's usage jumps well above the meter's recent normal. */
  usageAnomalyAlerts?: boolean;
  /**
   * How far above the trailing baseline a day has to land before it counts as
   * an anomaly, as a **percentage**, not a multiplier — 40 means "40% above
   * normal", i.e. 1.4x.
   *
   * A percentage rather than a taka amount, unlike `lowBalanceThreshold`,
   * because the meaningful quantity is relative: ৳30 over normal is nothing on
   * an industrial connection and a doubling on a one-room flat.
   */
  usageAnomalyThreshold?: number;
  /**
   * Extra channels an alert is delivered on, alongside the push notification.
   *
   * All three default to off. Push is the channel the user already consented to
   * by installing the app; a message to their handset or inbox is a separate
   * ask, so it starts silent and the user turns it on.
   */
  whatsappAlerts?: boolean;
  smsAlerts?: boolean;
  emailAlerts?: boolean;
  /**
   * Where the two messaging channels deliver, when it is not the number on the
   * profile.
   *
   * Null is the normal state, not a missing value: it means "use `user.mobile`".
   * A string is an override, stored because the account has no mobile to fall
   * back on or because alerts should reach a different handset from the one used
   * to sign in. Email has no counterpart — it is the login identity, so there is
   * always exactly one address and it is always the right one.
   */
  whatsappNumber?: string | null;
  smsNumber?: string | null;
  language?: 'en' | 'bn';
  theme?: 'light' | 'dark' | 'system';
}

export const DEFAULT_USER_SETTINGS: Required<UserSettings> = {
  pushEnabled: true,
  lowBalanceAlerts: true,
  lowBalanceThreshold: 100,
  rechargeAlerts: true,
  /**
   * On by default, matching the other two alert *types* — the opt-in line in
   * this file runs between alert types (default on) and delivery channels
   * (default off), not between urgent and advisory alerts.
   *
   * Safe to default on because it cannot speak early: a meter needs a week of
   * samples before the baseline is trusted at all, so a new account hears
   * nothing from this until the app has proven it is watching.
   */
  usageAnomalyAlerts: true,
  usageAnomalyThreshold: 40,
  whatsappAlerts: false,
  smsAlerts: false,
  emailAlerts: false,
  whatsappNumber: null,
  smsNumber: null,
  language: 'en',
  theme: 'system',
};
