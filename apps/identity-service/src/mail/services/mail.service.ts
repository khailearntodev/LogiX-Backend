import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import {
  renderInvitationEmail,
  InvitationEmailOptions,
} from '../templates/invitation.template.js';
import {
  renderResetPasswordEmail,
  ResetPasswordEmailOptions,
} from '../templates/reset-password.template.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

@Injectable()
export class MailService implements OnModuleInit {
  private transporter: Transporter | null = null;
  private readonly logger = new Logger(MailService.name);

  async onModuleInit() {
    this.initTransporter();
  }

  /**
   * Khởi tạo nodemailer transporter với pool và SSL port 465 (Gmail SMTP)
   */
  private initTransporter() {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      dotenv.config();
      const candidates = [
        path.resolve(process.cwd(), '.env'),
        path.resolve(process.cwd(), 'apps/identity-service/.env'),
        path.resolve(__dirname, '../../../../.env'),
        path.resolve(__dirname, '../../../.env'),
        path.resolve(__dirname, '../../.env'),
        path.resolve(__dirname, '../.env'),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) {
          dotenv.config({ path: c });
        }
      }
    }

    const host = process.env.SMTP_HOST || 'smtp.gmail.com';
    const port = Number(process.env.SMTP_PORT) || 465;
    const secure = process.env.SMTP_SECURE === 'true' || port === 465;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (!user || !pass) {
      this.logger.warn(
        '⚠️ SMTP_USER hoặc SMTP_PASS chưa được cấu hình. Hệ thống sẽ tạm thời vô hiệu hóa gửi email thực tế.'
      );
      return;
    }

    try {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: {
          user,
          pass,
        },
        pool: true,
        maxConnections: 5,
        maxMessages: 100,
      });

      this.logger.log(`📧 Đã khởi tạo Gmail SMTP Transporter: host=${host}, port=${port}, user=${user}`);
    } catch (err) {
      this.logger.error('❌ Không thể khởi tạo SMTP transporter:', err);
    }
  }

  /**
   * Lấy logo chính thức để đính kèm inline (CID) vào email
   */
  private getLogoAttachment() {
    const candidatePaths = [
      path.resolve(process.cwd(), 'assets/logo_logix.png'),
      path.resolve(process.cwd(), 'apps/identity-service/assets/logo_logix.png'),
      path.resolve(__dirname, '../../../../apps/identity-service/assets/logo_logix.png'),
      path.resolve(__dirname, '../../../assets/logo_logix.png'),
      path.resolve(__dirname, '../../assets/logo_logix.png'),
      path.resolve(__dirname, '../assets/logo_logix.png'),
      path.resolve(process.cwd(), '../LogiX-Frontend/public/logo_logix.png'),
    ];

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        return [
          {
            filename: 'logo_logix.png',
            path: p,
            cid: 'logix-logo',
          },
        ];
      }
    }
    return [];
  }

  /**
   * Xác thực kết nối tới SMTP Server
   */
  async verifyConnection(): Promise<boolean> {
    if (!this.transporter) {
      this.initTransporter();
    }
    if (!this.transporter) return false;
    try {
      await this.transporter.verify();
      this.logger.log('✅ Xác thực kết nối tới Gmail SMTP server thành công!');
      return true;
    } catch (error) {
      this.logger.error('❌ Xác thực kết nối Gmail SMTP thất bại:', error);
      return false;
    }
  }

  /**
   * Gửi thư mời tham gia tổ chức
   */
  async sendInvitationEmail(options: InvitationEmailOptions): Promise<boolean> {
    if (!this.transporter) {
      this.initTransporter();
    }
    if (!this.transporter) {
      this.logger.error(
        `[MailService] Không thể gửi email mời tới ${options.toEmail}: SMTP chưa cấu hình.`
      );
      return false;
    }

    try {
      const fromName = process.env.MAIL_FROM_NAME || 'LogiX Platform';
      const fromAddress = process.env.MAIL_FROM_ADDRESS || process.env.SMTP_USER;

      const { subject, html } = renderInvitationEmail(options);
      const attachments = this.getLogoAttachment();

      const info = await this.transporter.sendMail({
        from: `"${fromName}" <${fromAddress}>`,
        to: options.toEmail,
        subject,
        html,
        attachments,
      });

      this.logger.log(`✉️ Đã gửi thư mời tham gia tổ chức tới [${options.toEmail}], messageId=${info.messageId}`);
      return true;
    } catch (err: any) {
      this.logger.error(`❌ Lỗi gửi thư mời tới [${options.toEmail}]:`, err?.message || err);
      return false;
    }
  }

  /**
   * Gửi thư khôi phục mật khẩu
   */
  async sendResetPasswordEmail(options: ResetPasswordEmailOptions): Promise<boolean> {
    if (!this.transporter) {
      this.initTransporter();
    }
    if (!this.transporter) {
      this.logger.error(
        `[MailService] Không thể gửi email reset password tới ${options.toEmail}: SMTP chưa cấu hình.`
      );
      return false;
    }

    try {
      const fromName = process.env.MAIL_FROM_NAME || 'LogiX Platform';
      const fromAddress = process.env.MAIL_FROM_ADDRESS || process.env.SMTP_USER;

      const { subject, html } = renderResetPasswordEmail(options);
      const attachments = this.getLogoAttachment();

      const info = await this.transporter.sendMail({
        from: `"${fromName}" <${fromAddress}>`,
        to: options.toEmail,
        subject,
        html,
        attachments,
      });

      this.logger.log(`✉️ Đã gửi thư khôi phục mật khẩu tới [${options.toEmail}], messageId=${info.messageId}`);
      return true;
    } catch (err: any) {
      this.logger.error(`❌ Lỗi gửi thư khôi phục mật khẩu tới [${options.toEmail}]:`, err?.message || err);
      return false;
    }
  }
}
