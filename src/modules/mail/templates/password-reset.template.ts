import type { OutboundMail } from '../mail.service';

/**
 * Bilingual because the app is. A user who set the interface to Bangla and then
 * receives an English-only email has been handed the one screen we could not
 * translate, at the moment they are already locked out and least able to guess.
 *
 * Two strings per language is small enough to live here rather than pulling a
 * server-side i18n framework in for it. If a third email ever needs
 * translating, that calculation changes.
 */
const COPY = {
  en: {
    subject: 'Your ElectroSync password reset code',
    heading: 'Reset your password',
    intro: (name: string) =>
      `Hi ${name}, use this code in the ElectroSync app to set a new password.`,
    expiry: (minutes: number) =>
      `The code expires in ${minutes} minutes and works once.`,
    ignore:
      "If you didn't ask for this, you can ignore this email — your password has not changed.",
    footer: 'ElectroSync · Prepaid meter tracking',
  },
  bn: {
    subject: 'আপনার ইলেক্ট্রোসিঙ্ক পাসওয়ার্ড রিসেট কোড',
    heading: 'পাসওয়ার্ড রিসেট করুন',
    intro: (name: string) =>
      `${name}, নতুন পাসওয়ার্ড দিতে ইলেক্ট্রোসিঙ্ক অ্যাপে এই কোডটি ব্যবহার করুন।`,
    expiry: (minutes: number) =>
      `কোডটি ${minutes} মিনিট পরে বাতিল হয়ে যাবে এবং একবারই ব্যবহার করা যাবে।`,
    ignore:
      'আপনি যদি এটি না চেয়ে থাকেন, এই ইমেইলটি উপেক্ষা করতে পারেন — আপনার পাসওয়ার্ড বদলায়নি।',
    footer: 'ইলেক্ট্রোসিঙ্ক · প্রিপেইড মিটার ট্র্যাকিং',
  },
} as const;

export type MailLocale = keyof typeof COPY;

export function isMailLocale(value: unknown): value is MailLocale {
  return value === 'en' || value === 'bn';
}

export interface PasswordResetMailInput {
  to: string;
  name: string;
  code: string;
  expiresInMinutes: number;
  locale: MailLocale;
}

/**
 * A plain-text part is sent alongside the HTML, not as an afterthought: some
 * clients render it by preference, and a code-bearing email that arrives blank
 * is worse than one that arrives unstyled.
 */
export function passwordResetMail(input: PasswordResetMailInput): OutboundMail {
  const copy = COPY[input.locale];
  const { code, expiresInMinutes: minutes } = input;

  const text = [
    copy.heading,
    '',
    copy.intro(input.name),
    '',
    code,
    '',
    copy.expiry(minutes),
    copy.ignore,
    '',
    copy.footer,
  ].join('\n');

  return {
    to: input.to,
    subject: copy.subject,
    text,
    // Inline styles and a table-free single column: every rule below survives
    // Gmail and Outlook stripping <style> blocks, which is the whole reason not
    // to reach for a stylesheet here.
    html: `<!doctype html>
<html lang="${input.locale}">
  <body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#111827;">
        ${copy.heading}
      </h1>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#374151;">
        ${escapeHtml(copy.intro(input.name))}
      </p>
      <div style="margin:0 0 24px;padding:16px;background:#f4f5f7;border-radius:8px;text-align:center;font-size:32px;font-weight:700;letter-spacing:8px;color:#111827;font-family:'SF Mono',Menlo,Consolas,monospace;">
        ${code}
      </div>
      <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#6b7280;">
        ${escapeHtml(copy.expiry(minutes))}
      </p>
      <p style="margin:0;font-size:13px;line-height:1.6;color:#6b7280;">
        ${escapeHtml(copy.ignore)}
      </p>
      <hr style="margin:24px 0 0;border:none;border-top:1px solid #e5e7eb;" />
      <p style="margin:16px 0 0;font-size:12px;color:#9ca3af;">
        ${escapeHtml(copy.footer)}
      </p>
    </div>
  </body>
</html>`,
  };
}

/**
 * The user's own name is interpolated into the HTML, and names are free text
 * they typed. Escaping it costs nothing and keeps a display name containing
 * `<` from breaking the layout of every email it appears in.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
