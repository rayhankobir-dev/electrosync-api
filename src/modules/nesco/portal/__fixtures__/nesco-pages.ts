/**
 * Portal markup fixtures.
 *
 * These are hand-built to the selectors and headings the parser targets rather
 * than captured from a live session — a live capture would carry a real
 * customer's name, address and meter number into the repository. They exercise
 * the structure (label/input pairing, column order, Bengali headings) which is
 * what the parser actually depends on.
 *
 * Column order here is deliberately chosen so every numeric column's value
 * differs from its index. That is what makes the recharge-history test able to
 * catch an index-for-value mix-up.
 */

function labelledField(label: string, value: string): string {
  return `
    <div class="form-group">
      <label>${label}</label>
      <div class="col-sm-8"><input type="text" value="${value}" readonly></div>
    </div>`;
}

/** The customer detail form, as rendered above every report. */
const CUSTOMER_FORM = `
  <form class="bfont_post" method="post">
    ${labelledField('গ্রাহকের নাম', 'MD. RAJU AHMED')}
    ${labelledField('ঠিকানা', 'HOLDING 12, WARD 5, RAJSHAHI')}
    ${labelledField('সংশ্লিষ্ট বিদ্যুৎ অফিস', 'RAJSHAHI SALES & DIST. DIVISION-1')}
    ${labelledField('ফিডারের নাম', 'GREATER ROAD 11KV')}
    ${labelledField('মিটার নম্বর', '000012345678')}
    ${labelledField('মিটারের ধরণ', 'SINGLE PHASE')}
    ${labelledField('মিটার স্ট্যাটাস', 'ACTIVE')}
    ${labelledField('মিটার স্থাপনের তারিখ', '15/03/2021 14:22:31')}
    ${labelledField('অনুমোদিত লোড (কি.ও)', '2')}
    ${labelledField('মিনিমাম রিচার্জের পরিমাণ (টাকা)', '200')}
    ${labelledField('অবশিষ্ট ব্যালেন্স (৩১/০১/২০২৫ ১০:০০)', '1,523.45')}
  </form>`;

const RECHARGE_TABLE = `
  <table class="bfont_post">
    <thead>
      <tr>
        <th>ক্র নং</th>
        <th>টোকেন নম্বর</th>
        <th>মিটার রেন্ট (টাকা)</th>
        <th>ডিমান্ড চার্জ (টাকা)</th>
        <th>ভ্যাট (টাকা)</th>
        <th>রেয়াত (টাকা)</th>
        <th>বিদ্যুৎ (টাকা)</th>
        <th>রিচার্জের পরিমাণ (টাকা)</th>
        <th>রিচার্জের মাধ্যম</th>
        <th>রিচার্জের তারিখ</th>
        <th>রিমোট রিচার্জ স্ট্যাটাস</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>1</td>
        <td>1234-5678-9012-3456-7890</td>
        <td>40</td>
        <td>35</td>
        <td>25.50</td>
        <td>12.50</td>
        <td>399.50</td>
        <td>500</td>
        <td>bKash</td>
        <td>05-FEB-2025 02:30 PM</td>
        <td>SUCCESS</td>
      </tr>
      <tr>
        <td>2</td>
        <td>9876-5432-1098-7654-3210</td>
        <td>40</td>
        <td>35</td>
        <td>12.75</td>
        <td></td>
        <td>162.25</td>
        <td>250</td>
        <td>Nagad</td>
        <td>01-JAN-2025 12:05 AM</td>
        <td>Pending</td>
      </tr>
    </tbody>
  </table>`;

const CONSUMPTION_TABLE = `
  <table class="bfont_post">
    <thead>
      <tr>
        <th>বছর</th>
        <th>মাস</th>
        <th>সর্বমোট রিচার্জ (টাকা)</th>
        <th>রেয়াত (টাকা)</th>
        <th>ব্যবহৃত বিদ্যুৎ (টাকা)</th>
        <th>মিটার রেন্ট (টাকা)</th>
        <th>ডিমান্ড চার্জ (টাকা)</th>
        <th>ভ্যাট (টাকা)</th>
        <th>সর্বমোট ব্যবহার/কর্তন (টাকা)</th>
        <th>মাস শেষে মিটার ব্যালেন্স (টাকা)</th>
        <th>ব্যবহৃত বিদ্যুৎ (কি.ও.আ.)</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>2025</td>
        <td>জানুয়ারি</td>
        <td>1,500</td>
        <td>0</td>
        <td>1,180.25</td>
        <td>40</td>
        <td>35</td>
        <td>62.75</td>
        <td>1,318</td>
        <td>182</td>
        <td>210.50</td>
      </tr>
    </tbody>
  </table>`;

function page(...sections: string[]): string {
  return `<!DOCTYPE html>
<html lang="bn">
  <head>
    <meta name="csrf-token" content="test-csrf-token-value">
  </head>
  <body>${sections.join('\n')}</body>
</html>`;
}

export const RECHARGE_HISTORY_PAGE = page(CUSTOMER_FORM, RECHARGE_TABLE);

export const MONTHLY_CONSUMPTION_PAGE = page(CUSTOMER_FORM, CONSUMPTION_TABLE);

/** What the portal renders for a customer number it does not know. */
export const UNKNOWN_CUSTOMER_PAGE = page(
  '<div class="alert">দুঃখিত, তথ্য পাওয়া যায়নি।</div>',
);

/** A recharge report whose demand-charge column has been renamed upstream. */
export const RENAMED_COLUMN_PAGE = page(
  CUSTOMER_FORM,
  RECHARGE_TABLE.replace('ডিমান্ড চার্জ (টাকা)', 'ডিমান্ড ফি (টাকা)'),
);

/**
 * The same recharge report, but with `য়` spelled as the precomposed U+09DF —
 * which is how the live portal writes it. Visually identical to the heading in
 * `RECHARGE_TABLE`, and a different string. Header matching must survive this.
 */
export const PRECOMPOSED_HEADING_PAGE = page(
  CUSTOMER_FORM,
  // Built from codepoints, not typed literals: the two spellings are
  // indistinguishable in an editor, so hand-typing them would prove nothing.
  // U+09AF U+09BC (ya + nukta)  ->  U+09DF (yya).
  RECHARGE_TABLE.normalize('NFC').replace(/\u09AF\u09BC/g, '\u09DF'),
);

/** A detail form whose balance field now holds prose instead of a number. */
export const NON_NUMERIC_BALANCE_PAGE = page(
  CUSTOMER_FORM.replace('value="1,523.45"', 'value="প্রযোজ্য নয়"'),
);

/**
 * A detail form whose balance label carries no "as of" stamp.
 *
 * The stamp is the only evidence of which period a balance settles, so its
 * absence has to be survivable rather than fatal — the balance itself is still
 * a usable reading.
 */
export const UNSTAMPED_BALANCE_PAGE = page(
  CUSTOMER_FORM.replace(
    'অবশিষ্ট ব্যালেন্স (৩১/০১/২০২৫ ১০:০০)',
    'অবশিষ্ট ব্যালেন্স',
  ),
);

/** A detail form whose "as of" stamp has stopped being a date. */
export const UNREADABLE_STAMP_PAGE = page(
  CUSTOMER_FORM.replace('৩১/০১/২০২৫ ১০:০০', 'হালনাগাদ হয়নি'),
);
