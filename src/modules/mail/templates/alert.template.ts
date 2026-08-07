import type { OutboundMail } from '../mail.service';
import { type MailLocale } from './password-reset.template';

/**
 * Only the chrome is translated here, unlike `password-reset.template.ts` which
 * owns its whole message.
 *
 * The subject and body arrive already localised — `composeAlert` in the alerts
 * module wrote them from the same `settings.language` this template reads, and
 * it is the one place that knows how to say "your balance is low" about a
 * specific meter. Duplicating that here would mean two files to keep in step
 * every time an alert kind is added, and they would drift.
 */
const COPY = {
  en: {
    intro: 'Here is an update on your prepaid meter.',
    settings:
      'You are receiving this because email alerts are on for your account. You can turn them off in the app under Settings → Notifications.',
    footer: 'ElectroSync · Prepaid meter tracking',
  },
  bn: {
    intro: 'আপনার প্রিপেইড মিটারের সর্বশেষ খবর।',
    settings:
      'আপনার অ্যাকাউন্টে ইমেইল সতর্কতা চালু থাকায় এই বার্তাটি পাঠানো হয়েছে। অ্যাপের সেটিংস → নোটিফিকেশন থেকে এটি বন্ধ করতে পারেন।',
    footer: 'ইলেক্ট্রোসিঙ্ক · প্রিপেইড মিটার ট্র্যাকিং',
  },
} as const;

export interface AlertMailInput {
  to: string;
  /** Already-localised alert title. Becomes the subject line verbatim. */
  title: string;
  /** Already-localised alert body. */
  body: string;
  locale: MailLocale;
}

/**
 * Turns one alert into a message.
 *
 * The title becomes the subject rather than being folded into the body the way
 * `deliverSms` has to fold it: email has a subject line, and "Low meter
 * balance" in the inbox list is what makes the alert scannable without opening
 * it.
 */
export function alertMail(input: AlertMailInput): OutboundMail {
  const copy = COPY[input.locale];

  const text = [
    input.title,
    '',
    input.body,
    '',
    copy.settings,
    '',
    copy.footer,
  ].join('\n');

  return {
    to: input.to,
    subject: input.title,
    text,
    // Inline styles and a single column, for the same reason as the reset
    // email: Gmail and Outlook strip <style> blocks, so anything that has to
    // survive them cannot live in a stylesheet.
    html: `<!doctype html>
<html lang="${input.locale}">
  <body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">
        ${escapeHtml(copy.intro)}
      </p>
      <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#111827;">
        ${escapeHtml(input.title)}
      </h1>
      <p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:#111827;">
        ${escapeHtml(input.body)}
      </p>
      <hr style="margin:0;border:none;border-top:1px solid #e5e7eb;" />
      <p style="margin:16px 0 0;font-size:12px;line-height:1.6;color:#9ca3af;">
        ${escapeHtml(copy.settings)}
      </p>
      <p style="margin:12px 0 0;font-size:12px;color:#9ca3af;">
        ${escapeHtml(copy.footer)}
      </p>
    </div>
  </body>
</html>`,
  };
}

/**
 * Alert copy interpolates a meter label, and labels are free text the user
 * typed. Escaping keeps a meter called `Shop <main>` from breaking the layout
 * of every alert email it appears in.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
