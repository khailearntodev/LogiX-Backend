/**
 * Khung HTML chuẩn cho email LogiX.
 * Đồng bộ chuẩn Theme hệ thống LogiX (Unified Card + Emerald Gradient CTA).
 * Tối ưu hóa chống đảo màu lỗi trên Dark Mode di động (Gmail/iOS).
 */
export function renderBaseTemplate(options: {
  previewText: string;
  title: string;
  contentHtml: string;
}): string {
  const currentYear = new Date().getFullYear();

  return `
<!DOCTYPE html>
<html lang="vi" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${options.title}</title>
  <style>
    :root {
      color-scheme: light dark;
      supported-color-schemes: light dark;
    }
    body {
      margin: 0;
      padding: 0;
      background-color: #f4f4f5;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    table {
      border-collapse: collapse;
    }
    /* Dark mode text preservation */
    @media (prefers-color-scheme: dark) {
      .card-container {
        background-color: #18181b !important;
        border-color: #27272a !important;
      }
      .email-title {
        color: #ffffff !important;
      }
      .email-text {
        color: #d4d4d8 !important;
      }
      .email-subtext {
        color: #a1a1aa !important;
      }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  <!-- Preview Text -->
  <div style="display:none;font-size:1px;color:#f4f4f5;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
    ${options.previewText}
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f5; padding: 32px 12px;">
    <tr>
      <td align="center">
        <!-- Main Unified Card -->
        <table role="presentation" class="card-container" width="100%" cellpadding="0" cellspacing="0" style="max-width: 480px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e4e4e7; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
          
          <!-- Unified Header: Logo chính thức LogiX -->
          <tr>
            <td align="center" style="padding: 28px 24px 18px 24px;">
              <img src="cid:logix-logo" alt="LogiX Platform" width="100" height="100" style="width: 100px; height: 100px; display: block; border: 0; margin: 0 auto;" />
            </td>
          </tr>

          <!-- Subtle Accent Line -->
          <tr>
            <td align="center" style="padding: 0 24px;">
              <div style="height: 2px; background: linear-gradient(90deg, rgba(16,185,129,0.1) 0%, #10b981 50%, rgba(16,185,129,0.1) 100%); width: 100%;"></div>
            </td>
          </tr>

          <!-- Content Body -->
          <tr>
            <td style="padding: 24px 28px 28px 28px; font-size: 14px; line-height: 1.6;">
              ${options.contentHtml}
            </td>
          </tr>

        </table>

        <!-- Minimal Clean Footer -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 480px; margin: 0 auto;">
          <tr>
            <td style="padding: 16px 12px; text-align: center; font-size: 11px; color: #a1a1aa;">
              © ${currentYear} LogiX Platform
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}
