/**
 * Every string the NESCO prepaid customer portal renders is Bengali, and the
 * portal gives us no stable ids or data attributes to key off. Labels and
 * column headings ARE the contract, so they live here rather than being
 * inlined at their use sites — when the portal changes wording, this is the
 * single file to edit.
 */

/** Value of the form's `submit` field, which selects the report to render. */
export const SUBMIT_TYPE = {
  RECHARGE_HISTORY: 'রিচার্জ হিস্ট্রি',
  MONTHLY_CONSUMPTION: 'মাসিক ব্যবহার',
} as const;

export type SubmitType = (typeof SUBMIT_TYPE)[keyof typeof SUBMIT_TYPE];

/** `<label>` texts in the customer detail form. Matched by prefix. */
export const LABEL = {
  NAME: 'গ্রাহকের নাম',
  ADDRESS: 'ঠিকানা',
  OFFICE: 'সংশ্লিষ্ট বিদ্যুৎ অফিস',
  FEEDER: 'ফিডারের নাম',
  METER_NO: 'মিটার নম্বর',
  METER_TYPE: 'মিটারের ধরণ',
  METER_STATUS: 'মিটার স্ট্যাটাস',
  METER_INSTALLED_AT: 'মিটার স্থাপনের তারিখ',
  APPROVED_LOAD: 'অনুমোদিত লোড (কি.ও)',
  BALANCE: 'অবশিষ্ট ব্যালেন্স',
  MIN_RECHARGE: 'মিনিমাম রিচার্জের পরিমাণ (টাকা)',
} as const;

/** `<thead>` cell texts of the recharge history table. */
export const RECHARGE_COLUMN = {
  SN: 'ক্র নং',
  TOKEN: 'টোকেন নম্বর',
  METER_RENT: 'মিটার রেন্ট (টাকা)',
  DEMAND_CHARGE: 'ডিমান্ড চার্জ (টাকা)',
  VAT: 'ভ্যাট (টাকা)',
  CONCESSION: 'রেয়াত (টাকা)',
  USABLE: 'বিদ্যুৎ (টাকা)',
  RECHARGE_AMOUNT: 'রিচার্জের পরিমাণ (টাকা)',
  RECHARGE_METHOD: 'রিচার্জের মাধ্যম',
  RECHARGE_DATE: 'রিচার্জের তারিখ',
  RECHARGE_STATUS: 'রিমোট রিচার্জ স্ট্যাটাস',
} as const;

/** `<thead>` cell texts of the monthly consumption table. */
export const CONSUMPTION_COLUMN = {
  YEAR: 'বছর',
  MONTH: 'মাস',
  RECHARGE_AMOUNT: 'সর্বমোট রিচার্জ (টাকা)',
  CONCESSION: 'রেয়াত (টাকা)',
  ELECTRICITY_CHARGE: 'ব্যবহৃত বিদ্যুৎ (টাকা)',
  METER_RENT: 'মিটার রেন্ট (টাকা)',
  DEMAND_CHARGE: 'ডিমান্ড চার্জ (টাকা)',
  VAT: 'ভ্যাট (টাকা)',
  USAGE_AMOUNT: 'সর্বমোট ব্যবহার/কর্তন (টাকা)',
  REMAIN_BALANCE: 'মাস শেষে মিটার ব্যালেন্স (টাকা)',
  USAGE_KWH: 'ব্যবহৃত বিদ্যুৎ (কি.ও.আ.)',
} as const;

/** CSS selectors the portal's markup happens to expose. */
export const SELECTOR = {
  CSRF_META: 'meta[name="csrf-token"]',
  DETAIL_FORM_LABEL: 'form.bfont_post label',
  REPORT_TABLE: 'table.bfont_post',
} as const;

export const NESCO_BASE_URL = 'https://customer.nesco.gov.bd/pre/panel';

/** The portal is slow; but an unbounded wait would pin a Node worker forever. */
export const NESCO_REQUEST_TIMEOUT_MS = 15_000;

export const NESCO_USER_AGENT = 'Mozilla/5.0';

/**
 * The portal renders timestamps in Bangladesh local time with no offset marker.
 * Bangladesh Standard Time is a fixed UTC+06:00 and observes no DST, so a
 * constant is correct and keeps timestamp conversion independent of whatever
 * timezone the server happens to run in.
 */
export const DHAKA_UTC_OFFSET_MINUTES = 360;
