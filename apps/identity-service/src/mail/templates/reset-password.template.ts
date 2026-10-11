import { renderBaseTemplate } from './base.template.js';

export interface ResetPasswordEmailOptions {
  toEmail: string;
  displayName: string;
  resetLink: string;
  expiresAt: Date;
}

export function renderResetPasswordEmail(options: ResetPasswordEmailOptions): {
  subject: string;
  html: string;
} {
  const contentHtml = `
    <h2 class="email-title" style="margin: 0 0 12px 0; font-size: 18px; color: #09090b; font-weight: 700;">
      Đặt lại mật khẩu
    </h2>
    <p class="email-text" style="margin: 0 0 8px 0; color: #3f3f46; font-size: 14px; line-height: 1.6;">
      Yêu cầu đặt lại mật khẩu cho tài khoản <strong>${options.toEmail}</strong> trên LogiX.
    </p>
    <p class="email-subtext" style="margin: 0 0 20px 0; color: #71717a; font-size: 13px;">
      Liên kết có hiệu lực trong vòng <strong>15 phút</strong>.
    </p>

    <!-- System Theme CTA Button (Chống đảo màu chữ trên mobile dark mode) -->
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin: 24px auto;">
      <tr>
        <td align="center" style="border-radius: 10px; background-color: #10b981; background: linear-gradient(180deg, #10b981 0%, #059669 100%); box-shadow: 0 4px 10px rgba(16, 185, 129, 0.3);">
          <a href="${options.resetLink}" target="_blank" style="display: inline-block; padding: 13px 34px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; font-weight: 600; color: #ffffff !important; -webkit-text-fill-color: #ffffff !important; text-decoration: none; border-radius: 10px; letter-spacing: 0.2px;">
            <span style="color: #ffffff !important; -webkit-text-fill-color: #ffffff !important; font-weight: 600;">Đặt lại mật khẩu</span>
          </a>
        </td>
      </tr>
    </table>

    <!-- Fallback Link -->
    <p class="email-subtext" style="margin: 24px 0 0 0; padding-top: 16px; border-top: 1px solid #f4f4f5; font-size: 12px; color: #71717a; word-break: break-all; line-height: 1.5;">
      Hoặc truy cập: <a href="${options.resetLink}" style="color: #10b981; -webkit-text-fill-color: #10b981; font-weight: 600; text-decoration: underline;">${options.resetLink}</a>
    </p>
  `;

  const html = renderBaseTemplate({
    previewText: 'Đặt lại mật khẩu tài khoản LogiX của bạn',
    title: 'Đặt lại mật khẩu LogiX',
    contentHtml,
  });

  return {
    subject: '[LogiX] Yêu cầu khôi phục mật khẩu tài khoản',
    html,
  };
}
