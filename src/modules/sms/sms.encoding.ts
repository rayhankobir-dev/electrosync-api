import {
  GSM7_CONCATENATED_LIMIT,
  GSM7_SINGLE_LIMIT,
  UCS2_CONCATENATED_LIMIT,
  UCS2_SINGLE_LIMIT,
} from './sms.constants';

/**
 * Which alphabet the provider should encode a message in.
 *
 * These are bulksmsbd's own `type` parameter values, not our abstraction —
 * `text` is GSM 03.38, `unicode` is UCS-2.
 */
export type SmsEncoding = 'text' | 'unicode';

export interface SmsShape {
  readonly encoding: SmsEncoding;
  /** Billable parts. The provider charges per part, not per message. */
  readonly segments: number;
}

/**
 * The GSM 03.38 basic alphabet — the 128 characters `type=text` can carry.
 *
 * Laid out one table row per line so it can be checked against the spec by eye.
 * The escape control at position 0x1B is omitted: this is a membership set, not
 * a positional table, and the escape is an encoder detail rather than a
 * character anyone writes.
 */
const GSM7_BASIC = new Set(
  [
    '@£$¥èéùìòÇ\nØø\rÅå',
    'Δ_ΦΓΛΩΠΨΣΘΞÆæßÉ',
    ' !"#¤%&\'()*+,-./',
    '0123456789:;<=>?',
    '¡ABCDEFGHIJKLMNO',
    'PQRSTUVWXYZÄÖÑÜ§',
    '¿abcdefghijklmno',
    'pqrstuvwxyzäöñüà',
  ].join(''),
);

/**
 * Characters GSM-7 can carry, but only as an escape pair — so each one costs
 * two septets rather than one. Easy to overlook when a message of exactly 160
 * characters unexpectedly bills as two parts.
 */
const GSM7_EXTENDED = new Set('^{}\\[~]|€\f');

/**
 * Picks the alphabet a message needs and counts what it will cost.
 *
 * Detection is by content rather than by the user's language setting, and that
 * distinction is load-bearing here. The alert copy formats every amount with
 * `৳`, so an *English* alert is already outside GSM-7 — keying off
 * `settings.language === 'bn'` would send those as `type=text` and deliver
 * mojibake to the handset.
 */
export function describeSms(message: string): SmsShape {
  return isGsm7(message)
    ? {
        encoding: 'text',
        segments: countSegments(
          gsm7Septets(message),
          GSM7_SINGLE_LIMIT,
          GSM7_CONCATENATED_LIMIT,
        ),
      }
    : {
        encoding: 'unicode',
        // `.length` is UTF-16 code units, which is exactly the unit UCS-2 bills
        // in — so an astral character (an emoji) correctly counts as two.
        segments: countSegments(
          message.length,
          UCS2_SINGLE_LIMIT,
          UCS2_CONCATENATED_LIMIT,
        ),
      };
}

function isGsm7(message: string): boolean {
  for (const character of message) {
    if (!GSM7_BASIC.has(character) && !GSM7_EXTENDED.has(character)) {
      return false;
    }
  }

  return true;
}

function gsm7Septets(message: string): number {
  let septets = 0;

  for (const character of message) {
    septets += GSM7_EXTENDED.has(character) ? 2 : 1;
  }

  return septets;
}

/**
 * Concatenated parts are smaller than a standalone message because the UDH
 * header that reassembles them eats into each part's payload — which is why a
 * 161-character message costs two parts of 153, not 160 plus 1.
 */
function countSegments(
  units: number,
  single: number,
  concatenated: number,
): number {
  if (units === 0) return 0;
  if (units <= single) return 1;

  return Math.ceil(units / concatenated);
}
