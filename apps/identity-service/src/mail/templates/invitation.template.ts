import { renderBaseTemplate } from './base.template.js';

export interface InvitationEmailOptions {
  toEmail: string;
  inviterName: string;
  tenantName: string;
  roles: Array<{ name: string; code: string }>;
  inviteLink: string;
  expiresAt: Date;
}

export function renderInvitationEmail(options: InvitationEmailOptions): {
  subject: string;
  html: string;
} {
  const rolesBadges = options.roles
    .map(
      (r) =>
        `<span style="display:inline-block;padding:3px 10px;font-size:12px;font-weight:600;border-radius:6px;background:linear-gradient(#ecfdf5,#ecfdf5);background-color:#ecfdf5;color:#059669;-webkit-text-fill-color:#059669;border:1px solid #a7f3d0;margin-right:4px;">${r.name}</span>`
    )
    .join('');

  const contentHtml = `
    <h2 class="email-title" style="margin: 0 0 12px 0; font-size: 18px; color: #09090b; font-weight: 700;">
      Lời mời tham gia tổ chức
    </h2>
    <p class="email-text" style="margin: 0 0 16px 0; color: #3f3f46; font-size: 14px; line-height: 1.6;">
      <strong>${options.inviterName}</strong> đã mời bạn gia nhập tổ chức <strong>${options.tenantName}</strong> với vai trò:
    </p>

    <div style="margin: 0 0 24px 0;">
      ${rolesBadges || '<span style="color:#71717a;">Thành viên</span>'}
    </div>

    <!-- System Theme CTA Button (Chống đảo màu chữ trên mobile dark mode) -->
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin: 24px auto;">
      <tr>
        <td align="center" style="border-radius: 10px; background-color: #10b981; background: linear-gradient(180deg, #10b981 0%, #059669 100%); box-shadow: 0 4px 10px rgba(16, 185, 129, 0.3);">
          <a href="${options.inviteLink}" target="_blank" style="display: inline-block; padding: 13px 34px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; font-weight: 600; color: #ffffff !important; -webkit-text-fill-color: #ffffff !important; text-decoration: none; border-radius: 10px; letter-spacing: 0.2px;">
            <span style="color: #ffffff !important; -webkit-text-fill-color: #ffffff !important; font-weight: 600;">Chấp nhận lời mời</span>
          </a>
        </td>
      </tr>
    </table>

    <!-- Fallback Link -->
    <p class="email-subtext" style="margin: 24px 0 0 0; padding-top: 16px; border-top: 1px solid #f4f4f5; font-size: 12px; color: #71717a; word-break: break-all; line-height: 1.5;">
      Hoặc truy cập: <a href="${options.inviteLink}" style="color: #10b981; -webkit-text-fill-color: #10b981; font-weight: 600; text-decoration: underline;">${options.inviteLink}</a>
    </p>
  `;

  const html = renderBaseTemplate({
    previewText: `Lời mời tham gia tổ chức ${options.tenantName} trên LogiX`,
    title: `Lời mời tham gia ${options.tenantName}`,
    contentHtml,
  });

  return {
    subject: `[LogiX] Lời mời tham gia tổ chức ${options.tenantName}`,
    html,
  };
}
