import { renderBaseTemplate } from './base.template.js';

export interface ContactLeadReplyEmailOptions {
  toEmail: string;
  recipientName: string;
  companyName: string;
  subject: string;
  message: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderContactLeadReplyEmail(
  options: ContactLeadReplyEmailOptions,
): {
  subject: string;
  html: string;
} {
  const safeRecipient = escapeHtml(options.recipientName);
  const safeCompany = escapeHtml(options.companyName);
  const safeSubject = escapeHtml(options.subject);
  const formattedMessage = escapeHtml(options.message).replace(/\r?\n/g, '<br />');

  const contentHtml = `
    <h2 class="email-title" style="margin: 0 0 12px 0; font-size: 18px; color: #09090b; font-weight: 700;">
      ${safeSubject}
    </h2>
    <p class="email-text" style="margin: 0 0 16px 0; color: #3f3f46; font-size: 14px; line-height: 1.6;">
      Xin chào <strong>${safeRecipient}</strong> (${safeCompany}),
    </p>
    <div class="email-text" style="margin: 0 0 20px 0; padding: 16px; border-radius: 10px; background-color: #f8fafc; border: 1px solid #e2e8f0; color: #18181b; font-size: 14px; line-height: 1.65;">
      ${formattedMessage}
    </div>
    <p class="email-subtext" style="margin: 20px 0 0 0; padding-top: 16px; border-top: 1px solid #f4f4f5; font-size: 12px; color: #71717a; line-height: 1.5;">
      Thư này được gửi từ đội ngũ Tư vấn &amp; Quản trị Nền tảng <strong>LogiX</strong> theo yêu cầu đặt lịch demo của doanh nghiệp bạn.
    </p>
  `;

  const html = renderBaseTemplate({
    previewText: options.subject,
    title: options.subject,
    contentHtml,
  });

  return {
    subject: options.subject,
    html,
  };
}

