# KẾ HOẠCH TRIỂN KHAI TÍCH HỢP GỬI EMAIL QUA GMAIL SMTP (LOGIX ENTERPRISE)

Tài liệu này quy định kiến trúc, tiêu chuẩn bảo mật, các bước triển khai chi tiết và kịch bản kiểm thử tích hợp hệ thống gửi email qua giao thức Gmail SMTP cho nền tảng **LogiX**.

---

## 1. Mục Tiêu & Phạm Vi Triển Khai

1. **Giao thức & Dịch vụ**: Gmail SMTP (SSL Port 465, App Password bảo mật).
2. **Tài khoản gửi (Sender)**: `khainq205@gmail.com`
3. **Mã xác thực ứng dụng (App Password)**: `dfivahzzaldamdti` (định dạng liền mạch chuẩn nodemailer).
4. **Các tính năng bắt buộc tích hợp email**:
   - **Tính năng 1: Gửi Lời mời Tham gia Tổ chức (Organization Invitation)**:
     - Gửi email kèm link kích hoạt chứa token (`/invite?token=...`).
     - Hiển thị tên người mời, tên tổ chức, các vai trò phân công trước, thời hạn 7 ngày.
     - Hỗ trợ khi tạo lời mời mới và khi Quản trị viên bấm "Gửi lại lời mời" (Resend).
   - **Tính năng 2: Quên Mật khẩu & Đặt lại Mật khẩu (Forgot / Reset Password)**:
     - Gửi email kèm liên kết đặt lại mật khẩu (`/reset-password?token=...`).
     - Hạn sử dụng bảo mật trong vòng 15 phút.
5. **Tiêu chuẩn Giao diện Email (Email Templates)**:
   - 100% HTML/CSS responsive tương thích trên Gmail Desktop, Gmail Mobile, Apple Mail, Outlook.
   - Nhận diện thương hiệu LogiX: Logo, màu chủ đạo Emerald (`#059669`), typography rõ ràng, nút CTA nổi bật.
   - Ngôn ngữ: Hỗ trợ linh hoạt Tiếng Việt (chuẩn) và Tiếng Anh.

---

## 2. Thiết Kế Kiến Trúc & Cấu Hình Môi Trường

### 2.1. Cấu hình Biến Môi trường (`apps/identity-service/.env`)

```env
# Mail Configuration (Gmail SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=khainq205@gmail.com
SMTP_PASS=dfivahzzaldamdti
MAIL_FROM_NAME="LogiX Platform"
MAIL_FROM_ADDRESS=khainq205@gmail.com
```

### 2.2. Cấu trúc Thư mục Module Email trong `apps/identity-service`

```
apps/identity-service/src/
├── mail/
│   ├── mail.module.ts              # NestJS Module đăng ký Mailer
│   ├── services/
│   │   └── mail.service.ts          # Core service quản lý transporter & gửi mail
│   └── templates/
│       ├── base.template.ts         # Khung HTML chuẩn (Header logo, Container, Footer bản quyền)
│       ├── invitation.template.ts   # Mẫu thư mời tham gia tổ chức & vai trò
│       └── reset-password.template.ts # Mẫu thư khôi phục mật khẩu bảo mật
```

---

## 3. Quy Trình Triển Khai Từng Bước (Implementation Steps)

### Bước 1: Cài đặt Thư viện Phụ thuộc
Cài đặt `nodemailer` và các types tương ứng trong `apps/identity-service`:
```bash
pnpm --dir apps/identity-service add nodemailer
pnpm --dir apps/identity-service add -D @types/nodemailer
```

### Bước 2: Xây dựng Base Email Layout & Templates
- **Logo & Header**: Hiển thị logo LogiX, tiêu đề hệ thống.
- **Lời mời (`invitation.template.ts`)**:
  - Tên người mời: `Trần Văn A` (hoặc email người mời).
  - Tên tổ chức: `Công ty TNHH Vận tải LogiX`.
  - Danh sách vai trò: `[Điều phối viên, Kế toán kho]`.
  - Nút bấm chính: `Chấp nhận lời mời & Gia nhập`.
  - Link dự phòng hiển thị dưới dạng văn bản nếu nút không bấm được.
  - Cảnh báo thời hạn: `Liên kết có hiệu lực trong 7 ngày`.
- **Quên mật khẩu (`reset-password.template.ts`)**:
  - Nút bấm chính: `Đặt lại mật khẩu`.
  - Cảnh báo thời hạn: `Liên kết chỉ có hiệu lực trong 15 phút`.
  - Cảnh báo bảo mật: `Nếu bạn không yêu cầu hành động này, vui lòng bỏ qua email`.

### Bước 3: Xây dựng `MailService` & `MailModule`
- Khởi tạo `nodemailer.createTransport` với `pool: true`, kết nối an toàn qua cổng `465`.
- Hỗ trợ phương thức `verifyConnection()` để kiểm tra thông suốt kết nối SMTP khi service khởi động.
- Viết các methods nghiệp vụ:
  - `sendInvitationEmail(data: { to: string, inviterName: string, tenantName: string, roles: string[], inviteLink: string, expiresAt: Date })`
  - `sendPasswordResetEmail(data: { to: string, displayName: string, resetLink: string, expiresAt: Date })`
- Bọc logic `try/catch` có ghi log rõ ràng, không làm gián đoạn luồng API nếu dịch vụ mail gặp sự cố tạm thời (graceful degradation).

### Bước 4: Tích hợp vào Luồng Nghiệp vụ
1. **Trong `invitations.service.ts`**:
   - Method `createInvitation`: Sau khi lưu bản ghi vào database, gọi `mailService.sendInvitationEmail(...)`.
   - Method `resendInvitation`: Sau khi gia hạn token mới, gửi lại email cập nhật.
2. **Trong `auth.service.ts`**:
   - Method `forgotPassword`: Sau khi tạo `PasswordResetToken`, gọi `mailService.sendPasswordResetEmail(...)`.

---

## 4. Kịch Bản Kiểm Thử Toàn Diện (Testing & Verification)

| Mã test | Kịch bản | Thao tác | Kỳ vọng |
| :--- | :--- | :--- | :--- |
| **TEST-01** | Kết nối SMTP Server | Gọi `transporter.verify()` khi start NestJS | Trả về `true`, kết nối thành công tới `smtp.gmail.com:465`. |
| **TEST-02** | Gửi email mời thành viên mới | Gửi lời mời tới `khainq205@gmail.com` qua API `/iam/invitations` | Nhận được email từ `LogiX Platform <khainq205@gmail.com>` có nút gia nhập và link hợp lệ. |
| **TEST-03** | Gửi lại email lời mời (Resend) | Quản trị viên bấm gửi lại lời mời trên UI | Email mới được gửi với token mới, link mới kích hoạt thành công. |
| **TEST-04** | Gửi email khôi phục mật khẩu | Nhập email tại trang Quên mật khẩu `/forgot-password` | Nhận được email khôi phục kèm link đặt lại mật khẩu trong 15 phút. |
| **TEST-05** | Kiểm tra hiển thị Email (HTML Responsive) | Mở email trên cả Mobile và Webmail | Layout không bị vỡ, nút bấm CTA hoạt động tốt, không rơi vào Spam. |
| **TEST-06** | Dọn dẹp an toàn | Chạy script kiểm thử độc lập | Xóa sạch mọi file test tạm thời sau khi hoàn tất. |

---

## 5. Trạng Thái Hoàn Thành & Nghiệm Thu (Status: COMPLETED 100%)

- [x] **Bước 1: Cài đặt thư viện**: Đã cài đặt `nodemailer` và `@types/nodemailer`.
- [x] **Bước 2: Base layout & Templates**: Hoàn thiện 3 templates chuẩn Responsive, thương hiệu LogiX Emerald `#059669`.
- [x] **Bước 3: MailService & MailModule**: Khởi tạo Pool Transporter, cổng 465 SSL, hỗ trợ `verifyConnection()`, xử lý lỗi an toàn (graceful error handling).
- [x] **Bước 4: Tích hợp Invitations & Auth Services**: Đã inject vào `InvitationsService` (`createInvitation`, `resendInvitation`) và `AuthService` (`forgotPassword`).
- [x] **Kiểm thử máy chủ Gmail SMTP thực tế**: Đã kết nối thành công tới `smtp.gmail.com:465`, mã phản hồi `250 2.0.0 OK`, gửi thành công email mẫu đến `khainq205@gmail.com`.
- [x] **Kiểm thử tự động (Unit Test Suite)**: 78/78 tests đạt chuẩn 100% trên `identity-service`.
- [x] **Kiểm thử Typecheck & Build**: Monorepo đạt chuẩn TypeScript 100% trên 16 packages.
- [x] **Dọn dẹp mã nguồn**: Toàn bộ file script test tạm thời đã được xóa hoàn toàn.
