import { ALERT_KIND, type AlertKind } from '@/database/types/alert.type';
import type { UserSettings } from '@/database/types/user-settings.type';

type Language = NonNullable<UserSettings['language']>;

export interface AlertContext {
  /** The meter's label, or its customer number when unlabelled. */
  readonly meterName: string;
  readonly balance: number;
  readonly threshold: number;
  /** Gross amount of the recharge, for RECHARGE_DETECTED only. */
  readonly rechargeAmount: number;
  /** What the flagged day cost, for USAGE_ANOMALY only. */
  readonly anomalyCost: number;
  /** The trailing baseline it was measured against, for USAGE_ANOMALY only. */
  readonly anomalyBaseline: number;
  /** Whole percent above baseline, for USAGE_ANOMALY only. */
  readonly anomalyPercent: number;
}

export interface AlertCopy {
  readonly title: string;
  readonly body: string;
}

/**
 * Push copy, in the user's language.
 *
 * The backend has no i18n framework, and a push notification is the one place
 * where the server — not the app — chooses the wording, because the phone may
 * render it while the app is not running. Three strings per language did not
 * justify pulling in `nestjs-i18n`; if a fourth surface needs translation this
 * should graduate to one.
 *
 * Amounts stay in Western digits in both languages: the NESCO portal reports
 * them that way, and the app's meter screens already display them unconverted,
 * so a Bengali-numeral push would not match what the user sees on tapping it.
 */
const COPY: Record<
  Language,
  Record<AlertKind, (c: AlertContext) => AlertCopy>
> = {
  en: {
    [ALERT_KIND.LOW_BALANCE]: (c) => ({
      title: 'Low meter balance',
      body: `${c.meterName} has ${money(c.balance)} left — below your ${money(c.threshold)} alert level. Recharge soon to avoid an interruption.`,
    }),
    [ALERT_KIND.BALANCE_DEPLETED]: (c) => ({
      title: 'Meter balance depleted',
      body: `${c.meterName} has run out of balance. Recharge now to avoid disconnection.`,
    }),
    [ALERT_KIND.RECHARGE_DETECTED]: (c) => ({
      title: 'Recharge confirmed',
      body: `${money(c.rechargeAmount)} was recharged on ${c.meterName}. The balance is now ${money(c.balance)}.`,
    }),
    /**
     * Leads with the percentage and then shows its working. "You used more
     * than usual" on its own invites the reply "how much is usual?", and the
     * user cannot check from a lock screen — so both numbers travel with it.
     */
    [ALERT_KIND.USAGE_ANOMALY]: (c) => ({
      title: 'Unusual usage',
      body: `${c.meterName} used ${money(c.anomalyCost)} yesterday — ${c.anomalyPercent}% above its recent average of ${money(c.anomalyBaseline)} a day.`,
    }),
  },
  bn: {
    [ALERT_KIND.LOW_BALANCE]: (c) => ({
      title: 'মিটারে কম ব্যালেন্স',
      body: `${c.meterName} মিটারে ${money(c.balance)} বাকি আছে — আপনার নির্ধারিত ${money(c.threshold)} সীমার নিচে। বিদ্যুৎ বিচ্ছিন্ন হওয়া এড়াতে শীঘ্রই রিচার্জ করুন।`,
    }),
    [ALERT_KIND.BALANCE_DEPLETED]: (c) => ({
      title: 'মিটারের ব্যালেন্স শেষ',
      body: `${c.meterName} মিটারের ব্যালেন্স শেষ হয়ে গেছে। সংযোগ বিচ্ছিন্ন হওয়া এড়াতে এখনই রিচার্জ করুন।`,
    }),
    [ALERT_KIND.RECHARGE_DETECTED]: (c) => ({
      title: 'রিচার্জ সম্পন্ন',
      body: `${c.meterName} মিটারে ${money(c.rechargeAmount)} রিচার্জ হয়েছে। বর্তমান ব্যালেন্স ${money(c.balance)}।`,
    }),
    [ALERT_KIND.USAGE_ANOMALY]: (c) => ({
      title: 'অস্বাভাবিক ব্যবহার',
      body: `${c.meterName} মিটারে গতকাল ${money(c.anomalyCost)} খরচ হয়েছে — সাম্প্রতিক দৈনিক গড় ${money(c.anomalyBaseline)} এর চেয়ে ${c.anomalyPercent}% বেশি।`,
    }),
  },
};

function money(amount: number): string {
  return `৳${new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2,
  }).format(amount)}`;
}

export function composeAlert(
  kind: AlertKind,
  language: Language,
  context: AlertContext,
): AlertCopy {
  return COPY[language][kind](context);
}
