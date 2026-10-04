# Kế hoạch Triển khai Phân quyền Động Đa Tổ chức (Dynamic Multi-Tenant RBAC)

> **Dự án**: LogiX Enterprise Logistics Platform  
> **Mục tiêu**: Xây dựng hệ thống phân quyền động cấp quyền chính xác (Fine-grained Dynamic RBAC) theo từng tổ chức (Tenant/Organization), cung cấp UI quản lý vai trò và ma trận quyền hạn, nâng cấp các component Frontend hiện tại và đảm bảo đa ngôn ngữ VI/EN 100%.

---

## 1. Mô hình Phân quyền Hệ thống (2-Tier Authorization Model)

Hệ thống phân quyền của LogiX được phân tách mạch lạc thành **2 cấp độ quản trị**:

```
                  ┌────────────────────────────────────────────────────────┐
                  │              CẤP 1: TOÀN HỆ THỐNG (PLATFORM)           │
                  │   SUPER_ADMIN (Dev / Master System Administrator)     │
                  │  - Toàn quyền tối cao trên mọi Tenant & Microservice   │
                  │  - TUYỆT ĐỐI KHÔNG xuất hiện trong list role của org   │
                  └───────────────────────────┬────────────────────────────┘
                                              │ Quản trị & Giám sát
             ┌────────────────────────────────┴────────────────────────────────┐
             ▼                                                                 ▼
┌───────────────────────────────┐                             ┌───────────────────────────────┐
│     TỔ CHỨC A (TENANT A)      │                             │     TỔ CHỨC B (TENANT B)      │
├───────────────────────────────┤                             ├───────────────────────────────┤
│ 3 VAI TRÒ HỆ THỐNG MẶC ĐỊNH:  │                             │ 3 VAI TRÒ HỆ THỐNG MẶC ĐỊNH:  │
│  1. OWNER (Chủ sở hữu)        │                             │  1. OWNER (Chủ sở hữu)        │
│  2. ADMIN (Quản trị viên)     │                             │  2. ADMIN (Quản trị viên)     │
│  3. MEMBER (Thành viên cơ bản)│                             │  3. MEMBER (Thành viên cơ bản)│
├───────────────────────────────┤                             ├───────────────────────────────┤
│ CÁC VAI TRÒ TỰ TẠO (CUSTOM):  │                             │ CÁC VAI TRÒ TỰ TẠO (CUSTOM):  │
│  - Kế toán kho                │                             │  - Điều phối đội xe           │
│  - Thủ kho                    │                             │  - Tài xế                     │
│  - Nhân viên bốc xếp          │                             │  - Giám sát hành trình        │
└───────────────────────────────┘                             └───────────────────────────────┘
```

---

### 1.1. Cấp 1: Quyền Tối cao Toàn Hệ thống (`SUPER_ADMIN`)
* **Đối tượng**: Nhà phát triển hệ thống (Developer), Quản trị viên hạ tầng (System/DevOps Admin).
* **Đặc tính kỹ thuật**:
  * **Toàn quyền vượt cấp (Bypass Permission Gate)**: Có quyền đọc, ghi, cấu hình và xử lý dữ liệu của **tất cả** tổ chức/tenant mà không bị giới hạn bởi bất kỳ Guard nào.
  * **Ẩn danh hoàn toàn ở cấp Tenant (Tenant UI Invisible)**:
    > [!IMPORTANT]
    > Role `SUPER_ADMIN` **TUYỆT ĐỐI KHÔNG** được tạo như một Role thông thường trong bảng `roles` của bất kỳ Tenant nào, và **KHÔNG BAO GIỜ** xuất hiện trong danh sách vai trò (`GET /iam/roles`) hay giao diện Quản lý Phân quyền của bất kỳ tổ chức nào.
  * **Cơ chế lưu trữ**: Được quản lý trực tiếp qua cờ định danh `isSuperAdmin: Boolean` trong bảng `users` (hoặc bảng `platform_admins`), bảo đảm tách biệt hoàn toàn khỏi domain của Tenant.

---

### 1.2. Cấp 2: Quyền Phân cấp Nội bộ Tổ chức (Tenant-Level Roles)
Mỗi tổ chức khi được khởi tạo sẽ **tự động có sẵn 3 vai trò hệ thống (`isSystem = true`)**:

| Vai trò | Mã Code | Quyền hạn mặc định | Ràng buộc bảo mật |
| :--- | :--- | :--- | :--- |
| **Chủ sở hữu** | `OWNER` | Toàn quyền trên tổ chức (`*`). | Chỉ có duy nhất 1 OWNER tại một thời điểm (có thể chuyển giao quyền). Không thể xóa hoặc thu hồi bớt quyền. |
| **Quản trị viên** | `ADMIN` | Quản lý thành viên, cấu hình tổ chức, gán vai trò, toàn quyền trên các nghiệp vụ vận hành (Kho, Vận tải, Đơn hàng). | Không thể xóa vai trò này. Không có quyền xóa tổ chức hoặc giáng chức OWNER. |
| **Thành viên** | `MEMBER` | Quyền xem cơ bản (Read-only) các thông tin chung của tổ chức; là vai trò mặc định khi một user mới được mời vào tổ chức. | Không thể xóa vai trò này. Có thể tùy biến ma trận quyền xem/thao tác cơ bản. |

* **Các vai trò tùy biến (Custom Roles - `isSystem = false`)**:
  * Do `OWNER` hoặc `ADMIN` của tổ chức tự do tạo mới, đặt tên, mô tả và chọn tick các quyền trong Ma trận phân quyền.
  * Có thể xóa bỏ khi không còn thành viên nào giữ vai trò đó.

---

## 2. Thiết kế Cơ sở dữ liệu (Database Schema Enhancements)

Hệ thống đã có sẵn các bảng quan hệ N-N trong `apps/identity-service/prisma/schema.prisma`. Bổ sung cờ `isSuperAdmin` và mở rộng model `Permission`:

### 2.1. Cập nhật Model `User` (Hỗ trợ `SUPER_ADMIN`)
```prisma
model User {
  id           String   @id @default(uuid()) @db.Uuid
  email        String   @unique(map: "ux_users_email") @db.VarChar(320)
  passwordHash String   @map("password_hash") @db.Text
  displayName  String   @map("display_name") @db.VarChar(200)
  phoneNumber  String?  @map("phone_number") @db.VarChar(50)
  avatarUrl    String?  @map("avatar_url") @db.Text
  status       String   @db.VarChar(20) // ACTIVE, INACTIVE, SUSPENDED
  isSuperAdmin Boolean  @default(false) @map("is_super_admin") // 👑 CỜ QUYỀN TỐI CAO TOÀN HỆ THỐNG
  ...
}
```

### 2.2. Cải tiến Model `Permission`
```prisma
model Permission {
  id              String           @id @default(uuid()) @db.Uuid
  module          String           @db.VarChar(50)  // "INVENTORY", "ORDER", "TRANSPORT", "IAM", "REPORT"
  resource        String           @db.VarChar(50)  // "stock", "warehouse", "trip", "order", "role", "member"
  action          String           @db.VarChar(50)  // "read", "create", "update", "delete", "execute", "manage"
  code            String           @unique(map: "ux_permissions_code") @db.VarChar(100) // "module:resource:action"
  name            String           @db.VarChar(150) // Tên quyền hiển thị (Fallback)
  description     String?          @db.Text
  createdAt       DateTime         @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt       DateTime         @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)
  version         BigInt           @default(1)
  deletedAt       DateTime?        @map("deleted_at") @db.Timestamptz(6)

  rolePermissions RolePermission[]

  @@index([module, resource], map: "ix_permissions_module_resource")
  @@map("permissions")
  @@schema("identity")
}
```

### 2.3. Khởi tạo 3 Roles Hệ thống khi tạo mới Tenant
Khi một Tenant mới được tạo (qua đăng ký hoặc API `POST /auth/organizations`), hệ thống tự động sinh 3 bản ghi `Role` cho Tenant đó:
```typescript
await prisma.role.createMany({
  data: [
    { tenantId: tenant.id, code: 'OWNER', name: 'Chủ sở hữu', isSystem: true },
    { tenantId: tenant.id, code: 'ADMIN', name: 'Quản trị viên', isSystem: true },
    { tenantId: tenant.id, code: 'MEMBER', name: 'Thành viên', isSystem: true },
  ],
});
```

### 2.4. Quy tắc Bắt buộc khi Thay đổi Prisma Schema (Strict Migration Policy)

> [!CAUTION]
> **TUYỆT ĐỐI KHÔNG SỬ DỤNG `prisma db push`**:
> * `prisma db push` bỏ qua cơ chế ghi nhận lịch sử di trú (migration history), gây mất đồng bộ schema (schema drift), có nguy cơ làm mất dữ liệu và phá vỡ kiểm thử tự động trên CI/CD pipeline.
> * **BẮT BUỘC CHỈ SỬ DỤNG `prisma migrate dev`** để tạo migration file SQL có versioning kiểm soát mã nguồn:
>   ```bash
>   pnpm --dir apps/identity-service exec prisma migrate dev --name <ten_migration>
>   ```
> * Trên môi trường CI/CD hoặc Production, chỉ chạy lệnh:
>   ```bash
>   pnpm --dir apps/identity-service exec prisma migrate deploy
>   ```

---

## 3. Định chuẩn Danh mục Quyền Hệ thống (System Permissions Registry)

Mã quyền tuân theo cấu trúc 3 cấp: `<module>:<resource>:<action>`

```typescript
export const SYSTEM_PERMISSIONS = [
  // --- Phân hệ Kho & Tồn kho (INVENTORY) ---
  { code: 'inventory:warehouse:read', module: 'INVENTORY', resource: 'warehouse', action: 'read' },
  { code: 'inventory:warehouse:create', module: 'INVENTORY', resource: 'warehouse', action: 'create' },
  { code: 'inventory:warehouse:update', module: 'INVENTORY', resource: 'warehouse', action: 'update' },
  { code: 'inventory:warehouse:delete', module: 'INVENTORY', resource: 'warehouse', action: 'delete' },
  { code: 'inventory:stock:read', module: 'INVENTORY', resource: 'stock', action: 'read' },
  { code: 'inventory:stock:adjust', module: 'INVENTORY', resource: 'stock', action: 'update' },

  // --- Phân hệ Vận tải & Đội xe (TRANSPORT) ---
  { code: 'transport:trip:read', module: 'TRANSPORT', resource: 'trip', action: 'read' },
  { code: 'transport:trip:create', module: 'TRANSPORT', resource: 'trip', action: 'create' },
  { code: 'transport:trip:dispatch', module: 'TRANSPORT', resource: 'trip', action: 'execute' },
  { code: 'transport:vehicle:manage', module: 'TRANSPORT', resource: 'vehicle', action: 'manage' },

  // --- Phân hệ Quản lý Đơn hàng (ORDER) ---
  { code: 'order:sales-order:read', module: 'ORDER', resource: 'sales_order', action: 'read' },
  { code: 'order:sales-order:create', module: 'ORDER', resource: 'sales_order', action: 'create' },
  { code: 'order:sales-order:update', module: 'ORDER', resource: 'sales_order', action: 'update' },
  { code: 'order:sales-order:approve', module: 'ORDER', resource: 'sales_order', action: 'approve' },
  { code: 'order:sales-order:cancel', module: 'ORDER', resource: 'sales_order', action: 'delete' },

  // --- Phân hệ Quản trị Tổ chức & Phân quyền (IAM) ---
  { code: 'iam:role:read', module: 'IAM', resource: 'role', action: 'read' },
  { code: 'iam:role:manage', module: 'IAM', resource: 'role', action: 'manage' },
  { code: 'iam:member:read', module: 'IAM', resource: 'member', action: 'read' },
  { code: 'iam:member:invite', module: 'IAM', resource: 'member', action: 'create' },
  { code: 'iam:member:assign-role', module: 'IAM', resource: 'member', action: 'update' },
  { code: 'iam:member:remove', module: 'IAM', resource: 'member', action: 'delete' },
] as const;
```

---

## 4. Triển khai Backend (`identity-service` & Shared Libs)

### 4.1. Bộ API Quản lý Phân quyền (Identity Service)

| Method | Endpoint | Yêu cầu quyền | Chức năng & Ràng buộc bảo mật |
| :--- | :--- | :--- | :--- |
| `GET` | `/iam/permissions` | `iam:role:read` | Lấy danh mục tất cả quyền có trong hệ thống (nhóm theo module). |
| `GET` | `/iam/roles` | `iam:role:read` | Lấy danh sách vai trò của tổ chức (`OWNER`, `ADMIN`, `MEMBER` + Custom Roles). **Không trả về bất kỳ thông tin nào của SUPER_ADMIN**. |
| `POST` | `/iam/roles` | `iam:role:manage` | Tạo vai trò mới cho tổ chức. Không cho phép đặt code trùng với `OWNER`, `ADMIN`, `MEMBER`, `SUPER_ADMIN`. |
| `GET` | `/iam/roles/:id` | `iam:role:read` | Lấy chi tiết vai trò và danh sách `permissionIds` được cấp. |
| `PATCH` | `/iam/roles/:id` | `iam:role:manage` | Cập nhật thông tin vai trò (Không cho phép đổi `code` của 3 System Roles). |
| `DELETE` | `/iam/roles/:id` | `iam:role:manage` | Xóa vai trò tùy biến. **Chặn xóa 3 vai trò hệ thống** và role đang có user. |
| `PUT` | `/iam/roles/:id/permissions` | `iam:role:manage` | Cập nhật tập quyền cho vai trò (Ghi đè `RolePermission`). Không cho phép tước quyền của `OWNER`. |
| `GET` | `/iam/members` | `iam:member:read` | Danh sách thành viên tổ chức kèm danh sách roles được gán. |
| `POST` | `/iam/members/:userId/roles` | `iam:member:assign-role` | Gán danh sách vai trò cho một thành viên trong tổ chức. |
| `POST` | `/iam/invitations` | `iam:member:invite` + `iam:member:assign-role` | Gửi lời mời tham gia tổ chức kèm danh sách vai trò (`roleIds`) được chọn trước. Chặn tuyệt đối `SUPER_ADMIN`. Chỉ cho phép chọn `OWNER` nếu người mời là `SUPER_ADMIN` hoặc `OWNER` của tenant. |
| `GET` | `/iam/invitations` | `iam:member:read` | Lấy danh sách các lời mời của tổ chức (lọc theo trạng thái `PENDING`, `ACCEPTED`, `REVOKED`). |
| `POST` | `/iam/invitations/:id/resend` | `iam:member:invite` | Gửi lại lời mời: Gia hạn thời hạn thêm 7 ngày, sinh token bảo mật mới và đưa trạng thái về `PENDING`. |
| `POST` | `/iam/invitations/:id/revoke` | `iam:member:invite` | Thu hồi lời mời chưa được chấp nhận (chuyển trạng thái sang `REVOKED`, vô hiệu hóa link mời). |
| `DELETE` | `/iam/invitations/:id` | `iam:member:invite` | Xóa lời mời khỏi danh sách quản lý (Soft delete `deletedAt = now`, ẩn vĩnh viễn khỏi danh sách). |
| `GET` | `/auth/me/permissions` | Đã đăng nhập | Lấy danh sách mã quyền hiệu lực (`effectivePermissions`) của user tại tenant hiện tại. |
| `GET` | `/auth/invitations/:token` | Public | Lấy thông tin preview của lời mời (tên tổ chức, người mời, các vai trò sẽ được nhận). |
| `POST` | `/auth/invitations/:token/accept` | Public / Đã đăng nhập | Chấp nhận lời mời, tự động liên kết thành viên vào tổ chức và gán chính xác các vai trò được chọn trước. |

---

### 4.2. Cơ chế Guard Xác thực Phân quyền (`PermissionsGuard`)
Logic kiểm tra quyền hạn ưu tiên theo thứ tự:

```typescript
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()]
    );
    if (!requiredPermissions || requiredPermissions.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user) return false;

    // 1. SUPER_ADMIN luôn có toàn quyền trên toàn hệ thống
    if (user.isSuperAdmin === true) return true;

    // 2. OWNER của tổ chức có toàn quyền trong phạm vi tổ chức
    if (user.role === 'OWNER' || user.permissions?.includes('*')) return true;

    // 3. Kiểm tra user có ít nhất một quyền hợp lệ trong danh sách yêu cầu
    return requiredPermissions.some((perm) => user.permissions?.includes(perm));
  }
}
```

---

## 5. Triển khai Frontend (`LogiX-Frontend`)

### 5.1. Cập nhật `AuthContext`
Quản lý đồng thời quyền hạn và cờ `isSuperAdmin`:
```typescript
interface AuthContextType {
  user: AuthUser | null;
  activeTenant: ActiveTenant | null;
  tenants: TenantListItem[];
  permissions: string[];
  roles: string[];
  isSuperAdmin: boolean; // 👑 True nếu là Super Admin toàn hệ thống
  isOwner: boolean;      // True nếu là OWNER của tổ chức hiện tại
  isAdmin: boolean;      // True nếu là ADMIN của tổ chức hiện tại
  hasPermission: (permission: string) => boolean;
  hasAnyPermission: (permissions: string[]) => boolean;
  hasAllPermissions: (permissions: string[]) => boolean;
}
```

---

### 5.2. Component Kiểm soát Quyền (`<PermissionGuard>` hoặc `<Can>`)
Đặt tại `src/components/shared/permission-guard.tsx`:
```tsx
"use client";

import React from "react";
import { useAuth } from "@/lib/auth";

interface PermissionGuardProps {
  permission?: string;
  anyPermissions?: string[];
  allPermissions?: string[];
  requireSuperAdmin?: boolean;
  fallback?: React.ReactNode;
  children: React.ReactNode;
}

export function PermissionGuard({
  permission,
  anyPermissions,
  allPermissions,
  requireSuperAdmin = false,
  fallback = null,
  children,
}: PermissionGuardProps) {
  const { permissions, isSuperAdmin, isOwner } = useAuth();

  // Yêu cầu bắt buộc Super Admin (VD: Quản lý Tenant toàn sàn, Cấu hình hệ thống chung)
  if (requireSuperAdmin) {
    return isSuperAdmin ? <>{children}</> : <>{fallback}</>;
  }

  // Super Admin và Owner luôn vượt qua mọi kiểm tra quyền của Tenant
  if (isSuperAdmin || isOwner || permissions.includes("*")) {
    return <>{children}</>;
  }

  if (permission && !permissions.includes(permission)) {
    return <>{fallback}</>;
  }

  if (anyPermissions && !anyPermissions.some((p) => permissions.includes(p))) {
    return <>{fallback}</>;
  }

  if (allPermissions && !allPermissions.every((p) => permissions.includes(p))) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}
```

---

### 5.3. Nâng cấp `AppSidebar` (Menu phân quyền động)
Mở rộng `NavItem` và `NavGroup` trong [`app-sidebar.tsx`](file:///e:/GraduateProject/Logix/LogiX-Frontend/src/components/shared/app-sidebar.tsx):
```typescript
interface NavItem {
  title: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
  badgeVariant?: "default" | "warning" | "info";
  permission?: string;        // Quyền bắt buộc để hiển thị
  superAdminOnly?: boolean;   // Chỉ hiển thị cho Super Admin
}
```
* **Lọc Menu động**: Menu sẽ tự động ẩn các chức năng mà người dùng không có quyền trong tổ chức hiện tại. Mục dành riêng cho Super Admin (nếu có) sẽ chỉ hiển thị khi `isSuperAdmin === true`.

---

## 6. Giao diện Quản trị Vai trò & Phân quyền (Role Management UI)

Giao diện quản lý đặt trong **Cài đặt tổ chức** (`/organization/settings` hoặc qua `OrgSettingsDialog`):

```
┌────────────────────────────────────────────────────────────────────────┐
│ Cài đặt Tổ chức: CÔNG TY TNHH LOGIX VẬN TẢI QUỐC TẾ                   │
├──────────────┬─────────────────────────────────────────────────────────┤
│ [Thông tin]  │ Danh sách Vai trò                                      │
│ [Thành viên] │ ┌──────────────────┬──────────────┬────────┬──────────┐ │
│>[Phân quyền] │ │ Tên vai trò      │ Mã định danh │ Loại   │ Thao tác │ │
│              │ ├──────────────────┼──────────────┼────────┼──────────┤ │
│              │ │ Chủ sở hữu       │ OWNER        │[H.Thống]│ [Khóa]   │ │
│              │ │ Quản trị viên    │ ADMIN        │[H.Thống]│ [Xem/Sửa]│ │
│              │ │ Thành viên       │ MEMBER       │[H.Thống]│ [Xem/Sửa]│ │
│              │ │ Điều phối xe     │ DISPATCHER   │[Tùy biến]│ [Sửa][Xóa]││
│              │ │ Kế toán kho      │ ACC_WAREHOUSE│[Tùy biến]│ [Sửa][Xóa]││
│              │ └──────────────────┴──────────────┴────────┴──────────┘ │
│              │ [+ Tạo vai trò mới]                                     │
└──────────────┴─────────────────────────────────────────────────────────┘
* Ghi chú: Vai trò SUPER_ADMIN là quyền quản trị sàn, không xuất hiện tại đây.
```

### 6.1. Quy tắc hiển thị & thao tác trên UI:
1. **`OWNER`**: Luôn có Badge `"Hệ thống"`, nút thao tác hiển thị icon Khóa (không cho sửa hay xóa).
2. **`ADMIN` & `MEMBER`**: Có Badge `"Hệ thống"`, cho phép xem và điều chỉnh ma trận phân quyền, nhưng nút "Xóa" và ô sửa "Mã vai trò" bị vô hiệu hóa (Disabled).
3. **Custom Roles (Do tổ chức tự tạo)**: Có Badge `"Tùy biến"`, cho phép sửa tên, sửa mô tả, sửa ma trận quyền và xóa (kèm dialog xác nhận nếu không có user nào gắn kèm).

---

### 6.2. Giao diện Quản lý Lời mời & Modal Mời Thành viên (`InviteMemberDialog`)

Tab **"Lời mời"** được tích hợp cạnh Tab "Thành viên" trong Cài đặt Tổ chức:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Cài đặt Tổ chức: CÔNG TY TNHH LOGIX VẬN TẢI QUỐC TẾ                   │
├──────────────┬─────────────────────────────────────────────────────────┤
│ [Thông tin]  │ Danh sách Lời mời tham gia Tổ chức                      │
│ [Thành viên] │ ┌──────────────────┬──────────────┬────────┬──────────┐ │
│>[Lời mời]    │ │ Email người nhận │ Vai trò gán  │ Hạn SD │ Thao tác │ │
│ [Phân quyền] │ ├──────────────────┼──────────────┼────────┼──────────┤ │
│              │ │ ketoan@logix.vn  │[Kế toán kho] │ 6 ngày │ [Link][X]│ │
│              │ │ dieuphoi@logix.vn│[Điều phối xe]│ 2 ngày │ [Link][X]│ │
│              │ │ ceo@khachhang.vn │[Chủ sở hữu]  │ 7 ngày │ [Link][X]│ │
│              │ └──────────────────┴──────────────┴────────┴──────────┘ │
│              │ [+ Mời thành viên mới]                                  │
└──────────────┴─────────────────────────────────────────────────────────┘
```

1. **Modal "Mời thành viên mới" (`InviteMemberDialog`)**:
   - **Ô nhập Email**: Kiểm tra định dạng email hợp lệ.
   - **Danh sách Checkbox chọn trước Vai trò (`roleIds`)**:
     - Hiển thị danh sách tất cả các vai trò hiện có trong tổ chức (bao gồm System Roles và Custom Roles).
     - **Ràng buộc UI khi mời làm `OWNER`**: Nếu người dùng đang đăng nhập **không phải là `SUPER_ADMIN`** và **không phải là `OWNER`** của tổ chức hiện tại, tùy chọn `OWNER` sẽ bị vô hiệu hóa (disabled) kèm tooltip giải thích: *"Chỉ Chủ sở hữu hoặc Super Admin mới có quyền chỉ định vai trò Chủ sở hữu"*.
     - **Chặn tuyệt đối `SUPER_ADMIN`**: Vai trò `SUPER_ADMIN` không bao giờ xuất hiện trong danh sách lựa chọn.
   - **Nút hành động**:
     - "Gửi lời mời": Tạo lời mời trong CSDL và gửi link qua email.
     - "Sao chép link mời": Tự động sao chép link dạng `https://app.logix.vn/invite?token=...` vào clipboard để gửi nhanh qua Zalo/Slack/Teams.
2. **Thao tác trên Bảng Lời mời**:
   - Nút **"Sao chép link"**: Cho phép sao chép lại đường dẫn mời bất cứ lúc nào khi lời mời còn hiệu lực (`PENDING`).
   - Nút **"Gửi lại lời mời" (Icon Refresh/Send)**: Cho phép gia hạn và cấp token mới cho lời mời (áp dụng cho các lời mời `PENDING`, `EXPIRED`, `REVOKED`), tự động gia hạn thêm 7 ngày.
   - Nút **"Thu hồi" (Icon Khóa/Dừng)**: Vô hiệu hóa link mời (chuyển sang `REVOKED`), chỉ áp dụng cho lời mời `PENDING`.
   - Nút **"Xóa lời mời" (Icon Thùng rác đỏ)**: Xóa vĩnh viễn lời mời khỏi danh sách quản lý (Soft delete), mở modal xác nhận trước khi thực hiện.

---

### 6.3. Trang Tiếp nhận & Chấp nhận Lời mời Công khai (`/invite?token=...`)

Được thiết kế là một Landing Page chuyên biệt nằm ngoài Layout chính (không yêu cầu đăng nhập trước):

```
┌──────────────────────────────────────────────────────────┐
│                   [LOGO CỦA LOGIX]                       │
│                                                          │
│        Lời mời tham gia: CÔNG TY TNHH LOGIX VẬN TẢI       │
│      Người gửi: Nguyễn Văn A (Quản trị viên / Chủ sở hữu)│
│                                                          │
│  Các vai trò bạn sẽ đảm nhận khi gia nhập:               │
│  • [ĐIỀU PHỐI VIÊN] - Quản lý và duyệt lộ trình chuyến xe│
│  • [THỦ KHO] - Tra cứu và kiểm kê tồn kho               │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ [Trường hợp 1: Bạn đã có tài khoản LogiX]          │  │
│  │ Nhấn nút bên dưới để đăng nhập và tham gia ngay:   │  │
│  │                [ ĐĂNG NHẬP & GIA NHẬP ]            │  │
│  ├────────────────────────────────────────────────────┤  │
│  │ [Trường hợp 2: Bạn là thành viên mới]              │  │
│  │ Họ và tên: [...................................]   │  │
│  │ Mật khẩu:  [...................................]   │  │
│  │            [ TẠO TÀI KHOẢN & THAM GIA ]            │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

- **Xử lý trạng thái thông minh**:
  - Tự động gọi `GET /auth/invitations/:token` khi mở trang để kiểm tra tính hợp lệ và hiển thị thông tin preview.
  - Nếu token không hợp lệ hoặc đã hết hạn: Hiển thị thông báo thân thiện kèm nút "Quay về Trang chủ".
  - Sau khi người dùng nhấn "Tham gia": Backend tự động liên kết thành viên, gán chính xác các vai trò đã chọn trước, đăng nhập và điều hướng thẳng vào Bảng điều khiển của tổ chức vừa tham gia.

---

## 7. Từ điển Ngôn ngữ Đa quốc gia Toàn diện (i18n VI / EN)

Toàn bộ từ khóa UI, tên vai trò, danh mục module và hành động được đồng bộ chuẩn hóa trong `vi.json` và `en.json`:

### 7.1. Cấu trúc Locales Tiếng Việt (`vi.json`)
```json
{
  "iam": {
    "title": "Quản lý Vai trò & Phân quyền",
    "subtitle": "Tùy chỉnh vai trò và kiểm soát quyền hạn thành viên theo từng tổ chức",
    "superAdminBadge": "Quản trị viên Hệ thống",
    "roles": {
      "title": "Danh sách Vai trò",
      "createRole": "Tạo vai trò mới",
      "editRole": "Chỉnh sửa vai trò",
      "deleteRole": "Xóa vai trò",
      "roleName": "Tên vai trò",
      "roleNamePlaceholder": "Ví dụ: Điều phối viên, Thủ kho...",
      "roleCode": "Mã vai trò",
      "roleCodePlaceholder": "DISPATCHER, WAREHOUSE_KEEPER...",
      "description": "Mô tả",
      "descriptionPlaceholder": "Mô tả trách nhiệm và phạm vi của vai trò này",
      "memberCount": "{count} thành viên",
      "systemRoleBadge": "Hệ thống",
      "customRoleBadge": "Tùy biến",
      "ownerRole": "Chủ sở hữu",
      "adminRole": "Quản trị viên",
      "memberRole": "Thành viên",
      "deleteConfirmTitle": "Xác nhận xóa vai trò",
      "deleteConfirmDesc": "Bạn có chắc chắn muốn xóa vai trò \"{name}\"? Hành động này không thể hoàn tác.",
      "cannotDeleteSystemRole": "Không thể xóa 3 vai trò mặc định của hệ thống (OWNER, ADMIN, MEMBER).",
      "cannotDeleteRoleWithMembers": "Vai trò này đang được gán cho {count} thành viên. Vui lòng chuyển vai trò của họ trước khi xóa."
    },
    "matrix": {
      "title": "Ma trận Phân quyền",
      "module": "Phân hệ / Chức năng",
      "actions": {
        "read": "Xem",
        "create": "Thêm mới",
        "update": "Chỉnh sửa",
        "delete": "Xóa",
        "execute": "Thực thi / Duyệt",
        "manage": "Toàn quyền"
      },
      "selectAllModule": "Chọn toàn bộ phân hệ",
      "savePermissions": "Lưu phân quyền",
      "saveSuccess": "Cập nhật quyền hạn cho vai trò thành công!"
    },
    "modules": {
      "INVENTORY": "Quản lý Kho & Tồn kho",
      "TRANSPORT": "Điều phối Vận tải & Đội xe",
      "ORDER": "Quản lý Đơn hàng & Hợp đồng",
      "IAM": "Quản trị Tổ chức & Phân quyền",
      "REPORT": "Báo cáo & Thống kê"
    },
    "resources": {
      "warehouse": "Kho bãi & Vị trí",
      "stock": "Tồn kho & Kiểm kê",
      "trip": "Chuyến xe & Hành trình",
      "vehicle": "Phương tiện & Tài xế",
      "sales_order": "Đơn hàng bán hàng",
      "role": "Vai trò & Phân quyền",
      "member": "Thành viên tổ chức"
    },
    "invitations": {
      "title": "Lời mời Tham gia Tổ chức",
      "subtitle": "Quản lý và gửi lời mời gia nhập tổ chức kèm chỉ định trước vai trò thành viên",
      "inviteButton": "Mời thành viên mới",
      "dialogTitle": "Mời Thành viên Mới",
      "dialogDesc": "Gửi liên kết mời tham gia tổ chức qua email và chỉ định trước các vai trò sẽ được cấp khi thành viên chấp nhận.",
      "emailLabel": "Địa chỉ Email",
      "emailPlaceholder": "nhanvien@congty.com",
      "rolesLabel": "Chỉ định trước vai trò",
      "rolesHint": "Thành viên sẽ tự động nhận các vai trò này ngay sau khi kích hoạt lời mời.",
      "roleOwnerNotice": "Chỉ Chủ sở hữu (Owner) hoặc Super Admin mới có quyền chỉ định vai trò Chủ sở hữu cho lời mời.",
      "sendInvite": "Gửi lời mời",
      "sending": "Đang gửi...",
      "sendSuccess": "Đã tạo và gửi lời mời thành công đến {email}",
      "copyLink": "Sao chép liên kết mời",
      "copied": "Đã sao chép liên kết mời vào bộ nhớ tạm!",
      "table": {
        "email": "Email người nhận",
        "roles": "Vai trò chỉ định trước",
        "inviter": "Người gửi lời mời",
        "status": "Trạng thái",
        "expiresAt": "Thời hạn",
        "createdAt": "Ngày gửi",
        "actions": "Thao tác"
      },
      "status": {
        "pending": "Chờ kích hoạt",
        "accepted": "Đã tham gia",
        "revoked": "Đã thu hồi",
        "expired": "Hết hạn"
      },
      "revokeConfirmTitle": "Xác nhận thu hồi lời mời",
      "revokeConfirmDesc": "Bạn có chắc chắn muốn thu hồi lời mời gửi đến \"{email}\"? Sau khi thu hồi, liên kết mời sẽ bị vô hiệu hóa ngay lập tức.",
      "revokeSuccess": "Đã thu hồi lời mời thành công.",
      "resend": "Gửi lại lời mời",
      "resendSuccess": "Đã gia hạn và gửi lại lời mời thành công đến {email}",
      "delete": "Xóa lời mời",
      "deleteConfirmTitle": "Xác nhận xóa lời mời",
      "deleteConfirmDesc": "Bạn có chắc chắn muốn xóa lời mời gửi đến \"{email}\"? Lời mời sẽ bị xóa khỏi danh sách quản lý.",
      "deleteSuccess": "Đã xóa lời mời thành công.",
      "publicPage": {
        "title": "Lời mời Tham gia Tổ chức",
        "subtitle": "Bạn được mời gia nhập tổ chức {tenantName}",
        "invitedBy": "Người mời",
        "assignedRoles": "Các vai trò bạn sẽ đảm nhiệm",
        "acceptButton": "Chấp nhận lời mời & Tiếp tục",
        "accepting": "Đang xử lý kích hoạt...",
        "newAccountTitle": "Kích hoạt Tài khoản Thành viên",
        "newAccountDesc": "Bạn chưa có tài khoản trên hệ thống LogiX. Vui lòng thiết lập họ tên và mật khẩu để hoàn tất gia nhập.",
        "displayNameLabel": "Họ và tên",
        "displayNamePlaceholder": "Nguyễn Văn A",
        "passwordLabel": "Mật khẩu",
        "passwordPlaceholder": "Tối thiểu 8 ký tự",
        "expiredError": "Liên kết lời mời đã hết hạn hoặc không còn hiệu lực.",
        "revokedError": "Liên kết lời mời này đã bị người quản trị thu hồi.",
        "acceptedError": "Lời mời này đã được chấp nhận trước đó. Vui lòng đăng nhập vào hệ thống.",
        "successMessage": "Chào mừng bạn đến với {tenantName}! Đang chuyển hướng..."
      }
    }
  }
}
```

### 7.2. Cấu trúc Locales Tiếng Anh (`en.json`)
```json
{
  "iam": {
    "title": "Roles & Permissions Management",
    "subtitle": "Customize roles and control access rights per organization",
    "superAdminBadge": "System Super Admin",
    "roles": {
      "title": "Role List",
      "createRole": "Create New Role",
      "editRole": "Edit Role",
      "deleteRole": "Delete Role",
      "roleName": "Role Name",
      "roleNamePlaceholder": "E.g., Fleet Dispatcher, Warehouse Keeper...",
      "roleCode": "Role Code",
      "roleCodePlaceholder": "DISPATCHER, WAREHOUSE_KEEPER...",
      "description": "Description",
      "descriptionPlaceholder": "Describe duties and scope of this role",
      "memberCount": "{count} members",
      "systemRoleBadge": "System",
      "customRoleBadge": "Custom",
      "ownerRole": "Owner",
      "adminRole": "Administrator",
      "memberRole": "Member",
      "deleteConfirmTitle": "Confirm Role Deletion",
      "deleteConfirmDesc": "Are you sure you want to delete role \"{name}\"? This action cannot be undone.",
      "cannotDeleteSystemRole": "Default system roles (OWNER, ADMIN, MEMBER) cannot be deleted.",
      "cannotDeleteRoleWithMembers": "This role is currently assigned to {count} members. Please reassign them before deleting."
    },
    "matrix": {
      "title": "Permission Matrix",
      "module": "Module / Feature",
      "actions": {
        "read": "View",
        "create": "Create",
        "update": "Edit",
        "delete": "Delete",
        "execute": "Execute / Approve",
        "manage": "Full Access"
      },
      "selectAllModule": "Select all in module",
      "savePermissions": "Save Permissions",
      "saveSuccess": "Role permissions updated successfully!"
    },
    "modules": {
      "INVENTORY": "Warehouse & Inventory",
      "TRANSPORT": "Transportation & Fleet",
      "ORDER": "Orders & Contracts",
      "IAM": "Organization & Access Control",
      "REPORT": "Analytics & Reports"
    },
    "resources": {
      "warehouse": "Warehouses & Locations",
      "stock": "Stock & Cycle Count",
      "trip": "Trips & Routes",
      "vehicle": "Vehicles & Drivers",
      "sales_order": "Sales Orders",
      "role": "Roles & Permissions",
      "member": "Organization Members"
    },
    "invitations": {
      "title": "Organization Invitations",
      "subtitle": "Manage and send organization invitations with pre-assigned roles",
      "inviteButton": "Invite Member",
      "dialogTitle": "Invite New Member",
      "dialogDesc": "Send an invitation link via email and pre-assign roles to be granted upon acceptance.",
      "emailLabel": "Email Address",
      "emailPlaceholder": "employee@company.com",
      "rolesLabel": "Pre-assigned Roles",
      "rolesHint": "Member will automatically receive these roles immediately upon activation.",
      "roleOwnerNotice": "Only Organization Owner or Super Admin can assign the Owner role.",
      "sendInvite": "Send Invitation",
      "sending": "Sending...",
      "sendSuccess": "Invitation successfully created and sent to {email}",
      "copyLink": "Copy Invite Link",
      "copied": "Invite link copied to clipboard!",
      "table": {
        "email": "Recipient Email",
        "roles": "Pre-assigned Roles",
        "inviter": "Invited By",
        "status": "Status",
        "expiresAt": "Expires",
        "createdAt": "Sent At",
        "actions": "Actions"
      },
      "status": {
        "pending": "Pending",
        "accepted": "Accepted",
        "revoked": "Revoked",
        "expired": "Expired"
      },
      "revokeConfirmTitle": "Confirm Invitation Revocation",
      "revokeConfirmDesc": "Are you sure you want to revoke the invitation sent to \"{email}\"? The invitation link will be invalidated immediately.",
      "revokeSuccess": "Invitation revoked successfully.",
      "resend": "Resend Invitation",
      "resendSuccess": "Invitation renewed and resent successfully to {email}",
      "delete": "Delete Invitation",
      "deleteConfirmTitle": "Confirm Invitation Deletion",
      "deleteConfirmDesc": "Are you sure you want to delete the invitation sent to \"{email}\"? It will be removed from the management list.",
      "deleteSuccess": "Invitation deleted successfully.",
      "publicPage": {
        "title": "Organization Invitation",
        "subtitle": "You have been invited to join {tenantName}",
        "invitedBy": "Invited by",
        "assignedRoles": "Roles you will assume",
        "acceptButton": "Accept Invitation & Continue",
        "accepting": "Activating membership...",
        "newAccountTitle": "Activate Member Account",
        "newAccountDesc": "You don't have an account on LogiX yet. Please set your display name and password to complete activation.",
        "displayNameLabel": "Full Name",
        "displayNamePlaceholder": "John Doe",
        "passwordLabel": "Password",
        "passwordPlaceholder": "Minimum 8 characters",
        "expiredError": "This invitation link has expired or is invalid.",
        "revokedError": "This invitation has been revoked by the administrator.",
        "acceptedError": "This invitation has already been accepted. Please log in.",
        "successMessage": "Welcome to {tenantName}! Redirecting to workspace..."
      }
    }
  }
}
```

---

## 8. Kế hoạch & Quy trình Triển khai Chi tiết (Step-by-Step Implementation Roadmap)

Quy trình triển khai được chuẩn hóa thành 8 giai đoạn tuần tự, gắn liền với các file cụ thể, câu lệnh thực thi, ràng buộc bảo mật và tiêu chuẩn nghiệm thu (Acceptance Criteria):

---

### Giai đoạn 1: Database Migration & Seeding Dữ liệu Cốt lõi (Identity Service)

#### Task 1.1: Cập nhật Prisma Schema (`apps/identity-service/prisma/schema.prisma`)
* **Mục tiêu**: Bổ sung trường định danh cấp cao cho User và mở rộng metadata phân nhóm cho Permission.
* **Thay đổi chi tiết**:
  * `model User`: Thêm trường `isSuperAdmin Boolean @default(false) @map("is_super_admin")`.
  * `model Permission`: Bổ sung các trường `module String @db.VarChar(50)`, `resource String @db.VarChar(50)`, `action String @db.VarChar(50)`, `name String @db.VarChar(150)`.
  * Thêm index: `@@index([module, resource], map: "ix_permissions_module_resource")`.
* **Ràng buộc**: Giữ nguyên toàn bộ quan hệ và constraints hiện tại của `UserRole`, `RolePermission`, `UserTenant`.

#### Task 1.2: Tạo Migration SQL Chuẩn hóa (Strict Migration Policy)
* **Quy tắc bắt buộc**: **TUYỆT ĐỐI KHÔNG SỬ DỤNG `prisma db push`**.
* **Lệnh thực thi**:
  ```bash
  # Di chuyển vào thư mục identity-service và tạo migration
  pnpm --dir apps/identity-service exec prisma migrate dev --name add_super_admin_and_permission_fields
  ```
* **Kiểm tra đầu ra**:
  * Xuất hiện thư mục `apps/identity-service/prisma/migrations/<timestamp>_add_super_admin_and_permission_fields/migration.sql`.
  * Kiểm tra nội dung file SQL đảm bảo các câu lệnh `ALTER TABLE "users" ADD COLUMN "is_super_admin" BOOLEAN NOT NULL DEFAULT false;` và `ALTER TABLE "permissions" ADD COLUMN ...` chạy chuẩn xác trên PostgreSQL.
  * Tự động sinh Prisma Client mới tại `apps/identity-service/src/generated/prisma`.

#### Task 1.3: Xây dựng Script Seed Danh mục Quyền Hệ thống (`apps/identity-service/prisma/seed.ts`)
* **Mục tiêu**: Khởi tạo danh mục ~20 quyền nghiệp vụ tĩnh chuẩn xác theo format `module:resource:action` vào bảng `permissions`.
* **Cơ chế**: Dùng `prisma.permission.upsert` theo `code` để script có thể chạy lặp lại an toàn (idempotent):
  ```typescript
  for (const perm of SYSTEM_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: perm.code },
      update: { module: perm.module, resource: perm.resource, action: perm.action, name: perm.name },
      create: perm,
    });
  }
  ```

#### Task 1.4: Tự động khởi tạo 3 Roles Hệ thống khi tạo Tenant mới
* **File chỉnh sửa**:
  * `apps/identity-service/src/auth/services/auth.service.ts` (trong method `register` và `createOrganization`).
  * `apps/identity-service/src/organizations/tenants.service.ts` (nếu có).
* **Nghiệp vụ**:
  * Khi 1 Tenant mới được tạo, tự động tạo 3 bản ghi `Role`:
    1. `code: 'OWNER'`, `name: 'Chủ sở hữu'`, `isSystem: true`.
    2. `code: 'ADMIN'`, `name: 'Quản trị viên'`, `isSystem: true`.
    3. `code: 'MEMBER'`, `name: 'Thành viên'`, `isSystem: true`.
  * Gán toàn bộ permissions của hệ thống cho `OWNER` qua bảng `RolePermission`.
  * Gán các quyền quản lý vận hành cơ bản cho `ADMIN`.
  * Gán các quyền xem (`*:*:read`) cơ bản cho `MEMBER`.
  * User tạo tenant sẽ được gán vai trò `OWNER` trong `UserTenant` và `UserRole`.

#### Task 1.5: Seed Tài khoản SUPER_ADMIN Khởi thủy
* **Thực hiện trong `prisma/seed.ts`**:
  * Tạo một tài khoản root developer (VD: `superadmin@logix.vn`) với `isSuperAdmin = true`, `status = 'ACTIVE'`.
  * **Lưu ý**: Tài khoản này không bắt buộc phải thuộc vào bất kỳ Tenant nào trong `user_tenants` để chứng minh quyền hạn độc lập ở cấp Platform.

---

### Giai đoạn 2: Phát triển Bộ IAM API & Business Logic (Identity Service)

#### Task 2.1: Xây dựng Bộ DTOs Xác thực Dữ liệu
* **Thư mục tạo mới**: `apps/identity-service/src/iam/dto/`
  * `create-role.dto.ts`:
    * `name`: string, min 2, max 100, không được để trống.
    * `code`: string, regex uppercase chữ và số `^[A-Z0-9_]{2,50}$`, không được trùng với `['OWNER', 'ADMIN', 'MEMBER', 'SUPER_ADMIN']`.
    * `description`: string, optional.
    * `permissionIds`: string[] (UUIDs), optional.
  * `update-role.dto.ts`:
    * `name?`: string, min 2, max 100.
    * `description?`: string.
  * `assign-role-permissions.dto.ts`:
    * `permissionIds`: string[] (UUIDs), bắt buộc là mảng các UUID hợp lệ.
  * `assign-member-roles.dto.ts`:
    * `roleIds`: string[] (UUIDs), bắt buộc.

#### Task 2.2: Xây dựng `RolesService` (`apps/identity-service/src/iam/services/roles.service.ts`)
* **Các phương thức nghiệp vụ chi tiết**:
  1. `getRoles(tenantId: string)`:
     * Lấy tất cả roles có `tenantId = tenantId` và `deletedAt = null`.
     * **Bảo mật tuyệt đối**: Không bao giờ trả về thông tin của `SUPER_ADMIN`.
     * Đính kèm `_count: { userRoles: true, rolePermissions: true }` để tính số thành viên và số quyền được gán.
     * Sắp xếp: Ưu tiên 3 role hệ thống lên đầu (`OWNER` -> `ADMIN` -> `MEMBER`), sau đó đến các custom role theo `createdAt ASC`.
  2. `getRoleById(tenantId: string, roleId: string)`:
     * Tìm role theo `id = roleId` và `tenantId = tenantId`. Trả về chi tiết kèm danh sách `permissionIds`.
  3. `createRole(tenantId: string, dto: CreateRoleDto, creatorId: string)`:
     * Kiểm tra trùng mã `code` trong cùng tenant.
     * Kiểm tra `code` không thuộc blacklist (`OWNER`, `ADMIN`, `MEMBER`, `SUPER_ADMIN`).
     * Tạo role với `isSystem: false`. Nếu có `permissionIds`, tạo đồng thời các bản ghi trong `RolePermission` bằng transaction.
  4. `updateRole(tenantId: string, roleId: string, dto: UpdateRoleDto)`:
     * Kiểm tra role tồn tại trong tenant.
     * Cho phép đổi tên và mô tả. **Không cho phép sửa `code` nếu `role.isSystem === true`**.
  5. `deleteRole(tenantId: string, roleId: string)`:
     * **Chặn xóa vai trò hệ thống**: Nếu `role.isSystem === true` $\rightarrow$ Ném lỗi `BadRequestException('Không thể xóa 3 vai trò mặc định của hệ thống')`.
     * **Kiểm tra thành viên đang gán**: Đếm `userRoles` đang hoạt động. Nếu `count > 0` $\rightarrow$ Ném lỗi `BadRequestException('Vai trò đang có X thành viên, vui lòng điều chuyển trước khi xóa')`.
     * Thực hiện Soft-delete: Cập nhật `deletedAt = new Date()`.
  6. `updateRolePermissions(tenantId: string, roleId: string, permissionIds: string[], updaterId: string)`:
     * Nếu role là `OWNER` $\rightarrow$ Ném lỗi `ForbiddenException('Không thể thay đổi quyền hạn của Chủ sở hữu')`.
     * Dùng `prisma.$transaction`: Xóa các `RolePermission` cũ của `roleId` và tạo các bản ghi mới.
  7. `getEffectivePermissions(userId: string, tenantId: string)`:
     * Kiểm tra `user.isSuperAdmin === true` $\rightarrow$ Trả về `['*']`, `isSuperAdmin: true`.
     * Kiểm tra user có role `OWNER` trong tenant $\rightarrow$ Trả về `['*']`, `isOwner: true`.
     * Ngược lại: Query toàn bộ permissions từ tất cả roles của user trong tenant $\rightarrow$ Gom nhóm lấy danh sách mã quyền duy nhất (Set).

#### Task 2.3: Xây dựng `RolesController` (`apps/identity-service/src/iam/controllers/roles.controller.ts`)
* Định tuyến tại tiền tố `/iam/roles` và `/iam/permissions`.
* Mọi endpoint đều được bảo vệ bởi `@UseGuards(JwtAuthGuard, PermissionsGuard)`.
* Gán các metadata tương ứng:
  * `GET /iam/permissions` $\rightarrow$ `@RequirePermissions('iam:role:read')`
  * `GET /iam/roles` $\rightarrow$ `@RequirePermissions('iam:role:read')`
  * `POST /iam/roles` $\rightarrow$ `@RequirePermissions('iam:role:manage')`
  * `GET /iam/roles/:id` $\rightarrow$ `@RequirePermissions('iam:role:read')`
  * `PATCH /iam/roles/:id` $\rightarrow$ `@RequirePermissions('iam:role:manage')`
  * `DELETE /iam/roles/:id` $\rightarrow$ `@RequirePermissions('iam:role:manage')`
  * `PUT /iam/roles/:id/permissions` $\rightarrow$ `@RequirePermissions('iam:role:manage')`

#### Task 2.4: Bổ sung Endpoint Quyền Bản thân (`GET /auth/me/permissions`)
* **Controller**: `apps/identity-service/src/auth/auth.controller.ts`
* Trả về payload cho Frontend:
  ```json
  {
    "isSuperAdmin": false,
    "isOwner": true,
    "isAdmin": false,
    "roles": ["OWNER"],
    "permissions": ["*"]
  }
  ```

#### Task 2.5: Cập nhật Token Payload & Login/Switch Tenant Service
* File: `apps/identity-service/src/auth/services/token.service.ts` & `auth.service.ts`.
* Nhúng `isSuperAdmin` và `role` vào JWT Access Token Payload để API Gateway và các Microservices đọc nhanh mà không cần query lại database mỗi request.

---

### Giai đoạn 2.x: Mở rộng Tính năng Mời Thành viên kèm Chọn trước Vai trò (Pre-assigned Role Invitations)

#### 1. Bối cảnh & Nghiệp vụ Cốt lõi
* **Vấn đề cần giải quyết**:
  - Thông thường, khi nhân sự mới gia nhập tổ chức, họ được gán vai trò cơ bản `MEMBER` rồi sau đó Quản trị viên mới vào đổi role thủ công. Điều này gây bất tiện và tốn thời gian vận hành.
  - Cần cơ chế cho phép Quản trị viên khi gửi lời mời có thể **tích chọn trước 1 hoặc nhiều vai trò cụ thể** (`roleIds`) như `Điều phối viên`, `Kế toán`, `Thủ kho`... Khi người được mời click vào link đăng ký/chấp nhận, họ sẽ lập tức được sở hữu đúng các vai trò đó.
* **Use-case Đặc biệt (Chuyển giao quyền OWNER từ SUPER_ADMIN)**:
  - `SUPER_ADMIN` (Developer / Platform Root) tự mình tạo sẵn và cấu hình hoàn chỉnh một Tổ chức (Tenant) cho khách hàng doanh nghiệp mới (nhập thông tin kho bãi ban đầu, thiết lập phân hệ).
  - Sau khi hoàn tất cấu hình, `SUPER_ADMIN` gửi một lời mời với vai trò được chọn trước là `OWNER` đến email của đại diện doanh nghiệp.
  - Người đại diện nhận link, chỉ cần đăng ký hoặc đăng nhập là trở thành `OWNER` hợp pháp của tổ chức mà không cần phải tự cấu hình lại từ đầu.

#### 2. Ràng buộc Bảo mật & Phân quyền Phê duyệt (Strict Authorization Invariants)
1. **TUYỆT ĐỐI CHẶN mời làm `SUPER_ADMIN`**:
   - `SUPER_ADMIN` là tài khoản quản trị tối cao cấp toàn nền tảng, không phải là vai trò của bất kỳ tổ chức nào.
   - Hệ thống chặn tuyệt đối việc truyền mã hoặc role liên quan đến `SUPER_ADMIN` trong lời mời (ném `BadRequestException`).
2. **Kiểm tra quyền của người gửi lời mời**:
   - Người gửi lời mời bắt buộc phải vượt qua `PermissionsGuard` với 2 quyền:
     - `iam:member:invite`: Quyền gửi lời mời thành viên.
     - `iam:member:assign-role`: Quyền gán vai trò.
3. **Quy tắc phân cấp khi mời làm `OWNER`**:
   - Chỉ có `SUPER_ADMIN` (Platform root) HOẶC tài khoản hiện tại đang giữ vai trò `OWNER` của tenant đó mới được phép chọn vai trò `OWNER` trong danh sách `roleIds` của lời mời.
   - Nếu người gửi lời mời chỉ là `ADMIN` hoặc các vai trò tùy biến khác mà cố tình chọn gán `OWNER` $\rightarrow$ Ném lỗi `ForbiddenException('Chỉ Chủ sở hữu hoặc Super Admin mới có quyền chỉ định vai trò Chủ sở hữu cho thành viên mới')`.
4. **Kiểm tra tính hợp lệ của danh sách vai trò (`roleIds`)**:
   - Mọi `roleId` được chọn đều phải tồn tại, thuộc quyền sở hữu của chính `tenantId` đó và chưa bị xóa mềm (`deletedAt = null`).
5. **Tính an toàn và vòng đời của Token lời mời**:
   - Mã token được sinh bằng chuỗi ngẫu nhiên bảo mật 32 bytes hex (`crypto.randomBytes(32).toString('hex')`).
   - Thời hạn hiệu lực mặc định là 7 ngày (`expiresAt`).
   - Mỗi token chỉ được sử dụng thành công đúng 1 lần (chuyển sang trạng thái `ACCEPTED`).
   - Khi có lời mời mới gửi đến cùng 1 email trong cùng 1 tenant, lời mời `PENDING` cũ sẽ tự động bị thu hồi (`REVOKED`).

#### 3. Mô hình CSDL Lời mời (`TenantInvitation`)
* **Bảng cơ sở dữ liệu `tenant_invitations`**:
  ```prisma
  model TenantInvitation {
    id          String    @id @default(uuid()) @db.Uuid
    tenantId    String    @map("tenant_id") @db.Uuid
    email       String    @db.VarChar(255)
    roleIds     String[]  @map("role_ids") @db.Uuid
    inviterId   String    @map("inviter_id") @db.Uuid
    token       String    @unique @db.VarChar(255)
    status      String    @default("PENDING") @db.VarChar(50) // PENDING, ACCEPTED, REVOKED, EXPIRED
    expiresAt   DateTime  @map("expires_at")
    acceptedAt  DateTime? @map("accepted_at")
    createdAt   DateTime  @default(now()) @map("created_at")
    updatedAt   DateTime  @updatedAt @map("updated_at")
    deletedAt   DateTime? @map("deleted_at")

    tenant      Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
    inviter     User      @relation(fields: [inviterId], references: [id], onDelete: Cascade)

    @@index([token])
    @@index([tenantId, status])
    @@index([email])
    @@map("tenant_invitations")
  }
  ```
* **Quy tắc di trú CSDL**:
  - **TUYỆT ĐỐI KHÔNG SỬ DỤNG `prisma db push`**.
  - Bắt buộc tạo migration bằng lệnh:
    ```bash
    pnpm --dir apps/identity-service exec prisma migrate dev --name add_tenant_invitations_table
    ```

#### 4. Luồng Hoạt động Tuần tự Chi tiết (End-to-End Activity Flow)

* **Bước 1: Quản trị viên/Super Admin gửi lời mời (`POST /iam/invitations`)**:
  - Người dùng truy cập tab "Thành viên & Lời mời" trong giao diện Quản lý Phân quyền.
  - Bấm nút "Mời thành viên", nhập email và tích chọn các vai trò mong muốn (VD: `Điều phối viên`, `Kế toán`, hoặc `OWNER`).
  - Hệ thống kiểm tra:
    1. Người mời có quyền `iam:member:invite` và `iam:member:assign-role`.
    2. Nếu `roleIds` chứa vai trò `OWNER`: Kiểm tra người mời phải là `SUPER_ADMIN` hoặc là `OWNER` của tenant. Nếu không thỏa mãn $\rightarrow$ Ném lỗi `ForbiddenException`.
    3. Kiểm tra email chưa là thành viên hoạt động (`ACTIVE`) trong tenant.
    4. Sinh token ngẫu nhiên bảo mật thời hạn 7 ngày, lưu vào bảng `tenant_invitations`.
    5. Gửi email chứa đường dẫn kích hoạt: `https://app.logix.vn/invite?token=<token>`.

* **Bước 2: Người nhận truy cập liên kết lời mời (`GET /auth/invitations/:token`)**:
  - Người nhận nhấp vào link trong email.
  - Frontend gọi API công khai `GET /auth/invitations/:token`.
  - Backend kiểm tra tính hợp lệ: Token có tồn tại không, trạng thái có phải là `PENDING` không, đã quá hạn `expiresAt` chưa.
  - Trả về thông tin tóm tắt để hiển thị trên giao diện:
    - Tên tổ chức, mã tổ chức, logo tổ chức.
    - Tên người gửi lời mời và email người nhận.
    - Danh sách các vai trò sẽ được nhận khi chấp nhận lời mời (kèm mô tả của từng vai trò).

* **Bước 3: Người nhận chấp nhận lời mời (`POST /auth/invitations/:token/accept`)**:
  - **Trường hợp A (Người nhận chưa có tài khoản trên LogiX)**:
    - Điền họ tên (`displayName`) và mật khẩu (`password`).
    - Backend tạo mới tài khoản `User` với email đã được mời, mã hóa bcrypt mật khẩu.
  - **Trường hợp B (Người nhận đã có tài khoản trên LogiX)**:
    - Đăng nhập xác thực tài khoản.
  - **Thực thi Prisma Transaction an toàn**:
    1. Thêm bản ghi vào `user_tenants` với `status: 'ACTIVE'`.
    2. Xác định `primaryRole` trên `user_tenants`:
       - Nếu `roleIds` có chứa vai trò `OWNER` $\rightarrow$ Gán `role: 'OWNER'`.
       - Nếu có `ADMIN` $\rightarrow$ Gán `role: 'ADMIN'`.
       - Nếu là custom role $\rightarrow$ Gán mã custom role đầu tiên.
       - Mặc định $\rightarrow$ Gán `role: 'MEMBER'`.
    3. Thêm các bản ghi tương ứng vào bảng `user_roles` cho tất cả các `roleIds` được lưu trong lời mời.
    4. Cập nhật bản ghi `tenant_invitations`: `status: 'ACCEPTED'`, `acceptedAt = new Date()`.
  - Sinh cặp JWT Access Token và Refresh Token cho người dùng với `tenantId` vừa chấp nhận và trả về profile đầy đủ.

#### 5. Chi tiết các Task triển khai kỹ thuật

* **Task 2.x.1: Định nghĩa Model Prisma & Chạy Migration SQL**:
  - Bổ sung model `TenantInvitation` vào `apps/identity-service/prisma/schema.prisma`.
  - Thiết lập quan hệ với `Tenant` và `User` (inviter).
  - Chạy `pnpm --dir apps/identity-service exec prisma migrate dev --name add_tenant_invitations_table`.
* **Task 2.x.2: Xây dựng Bộ DTOs Xác thực**:
  - `apps/identity-service/src/iam/dto/create-invitation.dto.ts`:
    - `email`: string, định dạng email chuẩn.
    - `roleIds`: string[], mảng UUIDs không trùng lặp, tối thiểu 1 vai trò.
  - `apps/identity-service/src/auth/dto/accept-invitation.dto.ts`:
    - `password?`: string, tối thiểu 8 ký tự (nếu đăng ký mới).
    - `displayName?`: string, từ 2 đến 100 ký tự (nếu đăng ký mới).
* **Task 2.x.3: Xây dựng `InvitationsService` (`apps/identity-service/src/iam/services/invitations.service.ts`)**:
  - `createInvitation(tenantId, inviterId, isSuperAdmin, inviterRole, dto)`: Xử lý logic nghiệp vụ, phân cấp quyền mời `OWNER`, tạo token và lưu DB.
  - `getInvitations(tenantId)`: Lấy danh sách lời mời của tenant kèm thông tin inviter và roles.
  - `resendInvitation(tenantId, invitationId)`: Gia hạn thời hạn 7 ngày, sinh token bảo mật mới và chuyển trạng thái về `PENDING`.
  - `revokeInvitation(tenantId, invitationId)`: Thu hồi lời mời chưa sử dụng (chuyển sang `REVOKED`).
  - `deleteInvitation(tenantId, invitationId)`: Xóa lời mời khỏi danh sách quản lý (Soft delete: `deletedAt = new Date()`).
  - `getInvitationByToken(token)`: Public endpoint preview thông tin lời mời.
  - `acceptInvitation(token, dto, meta)`: Chấp nhận lời mời, tạo user (nếu cần), gán roles trong transaction và sinh JWT tokens.
* **Task 2.x.4: Xây dựng `InvitationsController` (`apps/identity-service/src/iam/controllers/invitations.controller.ts`)**:
  - `@Post('invitations')` $\rightarrow$ `@RequirePermissions('iam:member:invite', 'iam:member:assign-role')`
  - `@Get('invitations')` $\rightarrow$ `@RequirePermissions('iam:member:read')`
  - `@Post('invitations/:id/resend')` $\rightarrow$ `@RequirePermissions('iam:member:invite')`
  - `@Post('invitations/:id/revoke')` $\rightarrow$ `@RequirePermissions('iam:member:invite')`
  - `@Delete('invitations/:id')` $\rightarrow$ `@RequirePermissions('iam:member:invite')`
* **Task 2.x.5: Thêm Endpoint Chấp nhận Lời mời vào `AuthController`**:
  - `GET /auth/invitations/:token` $\rightarrow$ Public.
  - `POST /auth/invitations/:token/accept` $\rightarrow$ Public.
* **Task 2.x.6: Kiểm thử Chuyên sâu (Unit Tests & Integration Tests)**:
  - Test chặn chọn `SUPER_ADMIN`.
  - Test chặn `ADMIN` thường mời làm `OWNER`.
  - Test cho phép `SUPER_ADMIN` và `OWNER` mời làm `OWNER`.
  - Test chấp nhận lời mời gán đúng danh sách `roleIds` vào `user_roles`.
  - Xóa file test tạm sau khi hoàn thành.

---

### Giai đoạn 3: Xây dựng Shared Security Library & Microservice Enforcement

#### Task 3.1: Xây dựng Decorators & Guards Dùng chung
* **Vị trí**: Tạo thư viện dùng chung `libs/auth` hoặc module common trong workspace backend.
* **Tạo file `permissions.decorator.ts`**:
  ```typescript
  import { SetMetadata } from '@nestjs/common';
  export const PERMISSIONS_KEY = 'permissions';
  export const RequirePermissions = (...permissions: string[]) =>
    SetMetadata(PERMISSIONS_KEY, permissions);
  ```
* **Tạo file `permissions.guard.ts`**:
  * Kiểm tra tuần tự 3 lớp:
    1. `user.isSuperAdmin === true` $\rightarrow$ Cho phép ngay lập tức (Bypass).
    2. `user.role === 'OWNER'` hoặc `user.permissions?.includes('*')` $\rightarrow$ Cho phép ngay lập tức.
    3. `requiredPermissions.some(p => user.permissions?.includes(p))` $\rightarrow$ Cho phép nếu thỏa mãn ít nhất 1 quyền.
    4. Không thỏa mãn $\rightarrow$ Ném lỗi `ForbiddenException('Bạn không có quyền thực hiện hành động này')`.

#### Task 3.2: Áp dụng Guard lên các Microservices Nghiệp vụ
* Đăng ký `PermissionsGuard` trên các Controller của:
  * `order-service`: Bảo vệ `POST /orders`, `DELETE /orders/:id`, `POST /orders/:id/approve`.
  * `inventory-service`: Bảo vệ `POST /inventory/adjustments`, `POST /warehouses`.
  * `transport-service`: Bảo vệ `POST /trips`, `PATCH /trips/:id/dispatch`.

---

### Giai đoạn 4: Cập nhật Tầng State & Xác thực Frontend (`LogiX-Frontend`)

#### Task 4.1: Cập nhật Zod Schemas (`src/features/identity/schemas/auth.schema.ts`)
* Mở rộng `authUserSchema` thêm:
  * `isSuperAdmin: z.boolean().default(false)`
* Tạo schema mới `effectivePermissionsSchema`:
  ```typescript
  export const effectivePermissionsSchema = z.object({
    isSuperAdmin: z.boolean().default(false),
    isOwner: z.boolean().default(false),
    isAdmin: z.boolean().default(false),
    roles: z.array(z.string()).default([]),
    permissions: z.array(z.string()).default([]),
  });
  export type EffectivePermissions = z.infer<typeof effectivePermissionsSchema>;
  ```

#### Task 4.2: Nâng cấp `AuthContext` (`src/lib/auth/auth-context.tsx`)
* Mở rộng state của Provider:
  * `permissions: string[]`
  * `roles: string[]`
  * `isSuperAdmin: boolean`
  * `isOwner: boolean`
  * `isAdmin: boolean`
* Bổ sung các helper functions tiện ích:
  * `hasPermission(permission: string): boolean`
  * `hasAnyPermission(permissions: string[]): boolean`
  * `hasAllPermissions(permissions: string[]): boolean`

#### Task 4.3: Tích hợp Đồng bộ Quyền khi Chuyển đổi Tổ chức (`switchTenant`)
* Trong hàm `switchTenant(tenantId)`:
  * Gọi API `switchTenantApi(tenantId)` nhận access token mới.
  * Gọi song song `getEffectivePermissionsApi()` để lấy tập quyền chính xác của tổ chức mới.
  * Cập nhật đồng bộ vào React state để toàn bộ UI (Sidebar, Nút bấm) re-render tức thì theo quyền của tổ chức mới.

#### Task 4.4: Xây dựng Zod Schemas cho Lời mời & Chấp nhận Lời mời (`src/features/identity/schemas/invitation.schema.ts`)
* **Mục tiêu**: Định nghĩa các schemas xác thực dữ liệu chặt chẽ cho form mời thành viên, danh sách lời mời và trang kích hoạt công khai:
  ```typescript
  import { z } from "zod";

  // Schema form gửi lời mời mới kèm danh sách vai trò
  export const createInvitationSchema = z.object({
    email: z.string().email("Địa chỉ email không hợp lệ"),
    roleIds: z.array(z.string().uuid("ID vai trò không hợp lệ")).min(1, "Vui lòng chọn ít nhất một vai trò"),
  });
  export type CreateInvitationFormValues = z.infer<typeof createInvitationSchema>;

  // Schema chi tiết lời mời hiển thị trên bảng quản lý
  export const invitationItemSchema = z.object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    email: z.string().email(),
    roleIds: z.array(z.string().uuid()),
    roles: z.array(
      z.object({
        id: z.string().uuid(),
        name: z.string(),
        code: z.string(),
      })
    ),
    inviter: z.object({
      id: z.string().uuid(),
      displayName: z.string().nullable(),
      email: z.string(),
    }),
    status: z.enum(["PENDING", "ACCEPTED", "REVOKED", "EXPIRED"]),
    expiresAt: z.string(),
    createdAt: z.string(),
    acceptedAt: z.string().nullable().optional(),
  });
  export type InvitationItem = z.infer<typeof invitationItemSchema>;

  // Schema thông tin preview công khai khi mở liên kết mời
  export const invitationPreviewSchema = z.object({
    valid: z.boolean(),
    email: z.string().email(),
    tenant: z.object({
      id: z.string().uuid(),
      name: z.string(),
      code: z.string(),
      logoUrl: z.string().nullable().optional(),
    }),
    inviter: z.object({
      displayName: z.string().nullable(),
      email: z.string(),
    }),
    roles: z.array(
      z.object({
        id: z.string().uuid(),
        name: z.string(),
        code: z.string(),
        description: z.string().nullable().optional(),
      })
    ),
    expiresAt: z.string(),
    requiresRegistration: z.boolean(),
  });
  export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;

  // Schema form chấp nhận lời mời (cho tài khoản mới)
  export const acceptInvitationSchema = z.object({
    displayName: z.string().min(2, "Họ tên phải có ít nhất 2 ký tự").max(100).optional(),
    password: z.string().min(8, "Mật khẩu phải có ít nhất 8 ký tự").optional(),
  });
  export type AcceptInvitationFormValues = z.infer<typeof acceptInvitationSchema>;
  ```

---

### Giai đoạn 5: Nâng cấp Component Phân quyền Hiện tại & Route Protection

#### Task 5.1: Xây dựng Component `<PermissionGuard>` (`src/components/shared/permission-guard.tsx`)
* Tạo component bọc thông minh:
  * Nhận các props: `permission?`, `anyPermissions?`, `allPermissions?`, `requireSuperAdmin?`, `fallback?`, `children`.
  * Hỗ trợ ẩn hoàn toàn phần tử hoặc render component `fallback` (ví dụ: nút bấm bị disabled kèm tooltip giải thích).

#### Task 5.2: Nâng cấp `AppSidebar` (`src/components/shared/app-sidebar.tsx`)
* Mở rộng interface `NavItem`:
  ```typescript
  interface NavItem {
    title: string;
    href: string;
    icon: React.ComponentType<{ className?: string }>;
    badge?: string;
    badgeVariant?: "default" | "warning" | "info";
    permission?: string;        // Quyền bắt buộc để hiển thị
    anyPermissions?: string[];  // Một trong các quyền để hiển thị
    superAdminOnly?: boolean;   // Chỉ hiển thị cho Super Admin
  }
  ```
* Thêm logic lọc `navGroups`: Tự động ẩn các menu hoặc nhóm chức năng mà user không sở hữu quyền tại tổ chức hiện tại.

#### Task 5.3: Nâng cấp `WorkspaceGuard` & Xây dựng Màn hình 403 (`src/components/shared/workspace-guard.tsx`)
* Bổ sung tính năng kiểm tra quyền truy cập theo đường dẫn trang:
  * Nếu người dùng cố tình nhập URL vào khu vực không có quyền (VD: `/settings/roles` mà không có quyền `iam:role:read`), hiển thị giao diện **403 Không có quyền truy cập (Access Denied)** kèm nút "Quay lại Bảng điều khiển".

---

### Giai đoạn 6: Xây dựng Giao diện Quản trị Phân quyền (Role Management UI)

#### Task 6.1: Tạo Tầng Gọi API Client (`src/features/identity/api/roles.api.ts`)
* Viết các hàm: `getRolesApi`, `getRoleByIdApi`, `createRoleApi`, `updateRoleApi`, `deleteRoleApi`, `updateRolePermissionsApi`, `getAllPermissionsApi`.

#### Task 6.2: Xây dựng View Danh sách Vai trò (`src/features/identity/components/roles/role-list-view.tsx`)
* Bảng danh sách vai trò:
  * Cột: **Tên vai trò**, **Mã định danh (Code)**, **Phân loại**, **Số thành viên**, **Số quyền cấp**, **Thao tác**.
  * Badge hiển thị:
    * `Hệ thống` (xanh navy) cho `OWNER`, `ADMIN`, `MEMBER`.
    * `Tùy biến` (tím / xám) cho các vai trò do tổ chức tự tạo.
  * Trạng thái nút thao tác:
    * `OWNER`: Nút hành động bị khóa (icon Khóa).
    * `ADMIN` & `MEMBER`: Nút "Chỉnh sửa quyền" mở Ma trận phân quyền; nút "Xóa" bị ẩn/disable.
    * Custom Roles: Có đủ nút "Sửa thông tin", "Phân quyền ma trận", "Xóa vai trò".

#### Task 6.3: Xây dựng Modal Ma trận Phân quyền (`src/features/identity/components/roles/role-permission-matrix-dialog.tsx`)
* Giao diện ma trận chuyên nghiệp:
  * Header: Tên vai trò, mô tả, nút "Lưu thay đổi".
  * Thân modal: Chia thành các Card/Accordion theo từng Phân hệ (`Kho`, `Vận tải`, `Đơn hàng`, `Quản trị IAM`, `Báo cáo`).
  * Trong mỗi phân hệ: Các hàng là Tài nguyên, các cột là Checkbox hành động (`Xem`, `Tạo mới`, `Chỉnh sửa`, `Xóa`, `Duyệt/Thực thi`).
  * Nút thao tác nhanh:
    * "Chọn toàn bộ phân hệ" (Toggle all trong 1 module).
    * "Chỉ cấp quyền Xem" (Chỉ tích cột Read).
    * "Bỏ chọn tất cả".
  * Xử lý trạng thái lưu: Hiển thị spinner và toast thông báo thành công.

#### Task 6.4: Xây dựng Dialog Tạo & Chỉnh sửa Vai trò (`src/features/identity/components/roles/create-edit-role-dialog.tsx`)
* Form nhập liệu với `react-hook-form` + `zod`:
  * Tên vai trò: Bắt buộc, tối thiểu 2 ký tự.
  * Mã vai trò: Tự động format UPPERCASE và thay dấu cách bằng dấu gạch dưới (`_`), khóa ô này nếu đang ở chế độ chỉnh sửa.
  * Mô tả: Tùy chọn.

#### Task 6.5: Dialog Xác nhận Xóa Vai trò (`src/features/identity/components/roles/delete-role-dialog.tsx`)
* Hiển thị cảnh báo bảo mật màu đỏ: "Hành động này không thể hoàn tác".
* Hiển thị cảnh báo và disable nút xác nhận nếu vai trò đang có thành viên giữ quyền.

#### Task 6.6: Xây dựng API Client cho Quản lý Lời mời (`src/features/identity/api/invitations.api.ts`)
* **Mục tiêu**: Cung cấp các hàm gọi API chuẩn RESTful cho cả khu vực quản trị và trang tiếp nhận công khai:
  ```typescript
  import { apiClient } from "@/lib/api/client";
  import {
    CreateInvitationFormValues,
    InvitationItem,
    InvitationPreview,
    AcceptInvitationFormValues,
  } from "../schemas/invitation.schema";

  // 1. Lấy danh sách lời mời của tổ chức hiện tại
  export const getInvitationsApi = async (): Promise<InvitationItem[]> => {
    const res = await apiClient.get<InvitationItem[]>("/iam/invitations");
    return res.data;
  };

  // 2. Gửi lời mời mới kèm vai trò chọn trước
  export const createInvitationApi = async (
    dto: CreateInvitationFormValues
  ): Promise<{ id: string; token: string; inviteLink: string; expiresAt: string }> => {
    const res = await apiClient.post("/iam/invitations", dto);
    return res.data;
  };

  // 3. Gửi lại lời mời (Gia hạn thêm 7 ngày và cấp token mới)
  export const resendInvitationApi = async (
    invitationId: string
  ): Promise<{ id: string; token: string; inviteLink: string; expiresAt: string }> => {
    const res = await apiClient.post(`/iam/invitations/${invitationId}/resend`);
    return res.data;
  };

  // 4. Thu hồi lời mời (Vô hiệu hóa token)
  export const revokeInvitationApi = async (invitationId: string): Promise<void> => {
    await apiClient.post(`/iam/invitations/${invitationId}/revoke`);
  };

  // 5. Xóa lời mời khỏi danh sách quản lý
  export const deleteInvitationApi = async (invitationId: string): Promise<void> => {
    await apiClient.delete(`/iam/invitations/${invitationId}`);
  };

  // 6. Lấy thông tin preview lời mời công khai (không cần token đăng nhập)
  export const getPublicInvitationPreviewApi = async (
    token: string
  ): Promise<InvitationPreview> => {
    const res = await apiClient.get<InvitationPreview>(`/auth/invitations/${token}`);
    return res.data;
  };

  // 7. Chấp nhận lời mời công khai
  export const acceptPublicInvitationApi = async (
    token: string,
    dto: AcceptInvitationFormValues
  ): Promise<{ accessToken: string; refreshToken: string; user: any; activeTenant: any }> => {
    const res = await apiClient.post(`/auth/invitations/${token}/accept`, dto);
    return res.data;
  };
  ```

#### Task 6.7: Xây dựng Dialog Mời Thành viên kèm Chọn trước Vai trò (`src/features/identity/components/members/invite-member-dialog.tsx`)
* **Mục tiêu**: Dialog cho phép Quản trị viên nhập email và tích chọn các vai trò sẽ cấp cho thành viên:
* **Giao diện & Logic kiểm soát**:
  * Sử dụng `react-hook-form` tích hợp `zodResolver(createInvitationSchema)`.
  * Ô nhập Email người nhận với kiểm tra real-time.
  * Danh sách Checkbox đa lựa chọn cho các vai trò hiện có của tổ chức.
  * **Ràng buộc phân cấp OWNER**:
    * Sử dụng hook `useAuth()` để đọc `isSuperAdmin` và `isOwner`.
    * Nếu `!isSuperAdmin && !isOwner`, vô hiệu hóa (disabled) checkbox vai trò `OWNER` kèm tooltip: *"Chỉ Chủ sở hữu hoặc Super Admin mới có quyền chỉ định vai trò Chủ sở hữu"*.
  * **Bảo vệ toàn sàn**: Tuyệt đối không render lựa chọn `SUPER_ADMIN`.
  * **Trải nghiệm sau khi gửi thành công**:
    * Hiển thị modal con hoặc Card thông báo thành công: Gồm ô hiển thị đường dẫn `https://app.logix.vn/invite?token=...` và nút "Sao chép liên kết" (Copy to clipboard) với Toast phản hồi tức thì.

#### Task 6.8: Xây dựng Tab / Bảng Quản lý Lời mời (`src/features/identity/components/members/invitation-list-view.tsx`)
* **Mục tiêu**: Bảng quản trị danh sách lời mời tích hợp trong Tab Cài đặt Tổ chức / Thành viên:
  * **Các cột dữ liệu**:
    1. **Email người nhận**: Kèm avatar chữ cái đầu hoặc icon thư.
    2. **Vai trò chỉ định trước**: Hiển thị dạng danh sách Badges màu (VD: Badge xanh cho System Roles, tím cho Custom Roles).
    3. **Người gửi lời mời**: Tên và email người mời.
    4. **Trạng thái**:
       - `PENDING`: Badge vàng cảnh báo ("Chờ kích hoạt").
       - `ACCEPTED`: Badge xanh lá ("Đã tham gia").
       - `REVOKED`: Badge xám ("Đã thu hồi").
       - `EXPIRED`: Badge đỏ cam ("Hết hạn").
    5. **Thời hạn hiệu lực**: Hiển thị số ngày còn lại (VD: "Còn 6 ngày") hoặc ngày hết hạn chi tiết.
    6. **Thao tác**:
       - Nút icon Sao chép link mời (chỉ hiện khi `PENDING`).
       - Nút icon Gửi lại lời mời (cho phép khi `PENDING`, `EXPIRED`, hoặc `REVOKED`, gọi `resendInvitationApi`).
       - Nút icon Thu hồi lời mời (chỉ hiện khi `PENDING`, mở Dialog xác nhận thu hồi, gọi `revokeInvitationApi`).
       - Nút icon Xóa lời mời (mở Dialog xác nhận xóa màu đỏ, gọi `deleteInvitationApi`).

#### Task 6.9: Xây dựng Trang Tiếp nhận Lời mời Công khai (`src/app/(auth)/invite/page.tsx`)
* **Mục tiêu**: Landing Page độc lập tiếp nhận người dùng từ đường dẫn `https://app.logix.vn/invite?token=...`:
* **Thiết kế & Tương tác**:
  * Khi trang tải: Đọc query param `token`, hiển thị skeleton/loading và gọi `getPublicInvitationPreviewApi(token)`.
  * **Xử lý lỗi**:
    - Nếu token không tồn tại, đã hết hạn hoặc bị thu hồi $\rightarrow$ Hiển thị Alert Card lỗi trang trọng kèm thông điệp chi tiết từ `t("iam.invitations.publicPage....")` và nút "Về trang chủ".
  * **Trạng thái hợp lệ**:
    - Hiển thị Card chào mừng với Logo tổ chức, Tên tổ chức, Người mời.
    - Danh sách các vai trò sẽ được nhận kèm mô tả chi tiết quyền hạn.
    - **Trường hợp tài khoản đã tồn tại**: Hiển thị nút bấm lớn "Chấp nhận lời mời & Gia nhập".
    - **Trường hợp tài khoản chưa tồn tại (`requiresRegistration === true`)**: Hiển thị form gồm trường `Họ và tên` và `Mật khẩu mới` (tối thiểu 8 ký tự).
    - Sau khi kích hoạt thành công: Lưu token vào storage, cập nhật state Auth, hiển thị toast chào mừng và tự động chuyển hướng vào Workspace Dashboard của tổ chức.

---

### Giai đoạn 7: Đồng bộ Từ điển Đa ngôn ngữ (i18n VI / EN 100%)

#### Task 7.1: Bổ sung Từ điển Tiếng Việt (`src/lib/i18n/locales/vi.json`)
* Thêm toàn bộ các khóa dịch thuộc nhánh `iam` đã thiết kế ở Mục 7.1: tên 3 vai trò hệ thống, tiêu đề cột bảng, mô tả ma trận, nhãn hành động, thông báo lỗi, thông báo thành công.

#### Task 7.2: Bổ sung Từ điển Tiếng Anh (`src/lib/i18n/locales/en.json`)
* Thêm toàn bộ các khóa dịch tương ứng chuẩn bản ngữ tiếng Anh ở Mục 7.2.

#### Task 7.3: Rà soát Mã nguồn UI (Zero Hardcoded Text)
* Kiểm tra toàn bộ component vừa tạo, bảo đảm 100% văn bản đều đi qua hàm `t("iam....")`.

---

### Giai đoạn 8: Kịch bản Kiểm thử & Tiêu chuẩn Nghiệm thu (Testing & Acceptance Criteria)

| STT | Kịch bản Kiểm thử | Thao tác thực hiện | Kết quả kỳ vọng |
| :---: | :--- | :--- | :--- |
| **TC-01** | Tính bất khả xâm phạm của 3 System Roles | Đăng nhập tài khoản `ADMIN` của tổ chức, mở danh sách vai trò và thử xóa `OWNER`, `ADMIN`, hoặc `MEMBER`. | Nút xóa bị disable hoặc Backend trả về lỗi `400 Bad Request: Không thể xóa 3 vai trò mặc định của hệ thống`. |
| **TC-02** | Tính ẩn danh của `SUPER_ADMIN` | Gọi API `GET /iam/roles` và mở giao diện danh sách vai trò tại bất kỳ tổ chức nào. | Danh sách vai trò hoàn toàn **không** chứa `SUPER_ADMIN`. |
| **TC-03** | Khả năng vượt cấp của `SUPER_ADMIN` | Dùng token của `SUPER_ADMIN` gọi vào các API nghiệp vụ của bất kỳ tenant nào mà tài khoản này không được gán role cụ thể. | `PermissionsGuard` cho phép vượt qua (HTTP 200) thành công. |
| **TC-04** | Độc lập vai trò giữa các Tổ chức | Tạo vai trò "Kế toán kho" tại Tổ chức A. Chuyển sang Tổ chức B (Switch Tenant). | Danh sách vai trò của Tổ chức B **không** xuất hiện vai trò "Kế toán kho" của Tổ chức A. |
| **TC-05** | Ma trận Phân quyền & Ẩn hiện Nút bấm | Tạo role "Nhân viên kiểm kho" chỉ có quyền `inventory:warehouse:read`. Gán cho User B. Đăng nhập User B. | Nút "Tạo kho mới" và "Sửa kho" trên UI tự động biến mất hoặc bị vô hiệu hóa; gọi trực tiếp API `POST /warehouses` bị chặn với lỗi `403 Forbidden`. |
| **TC-06** | Kiểm tra Migration & CI Pipeline | Chạy lệnh `pnpm --dir apps/identity-service exec prisma migrate dev`. | Migration tạo file `.sql` sạch, không dùng `push`, CI pipeline pass xanh 100%. |
| **TC-07** | Mời thành viên kèm chọn trước Custom Roles | Quản trị viên mời `member@logix.vn` kèm 2 roles `[Điều phối viên, Kế toán kho]`. Người nhận nhấp link, tạo mật khẩu và chấp nhận. | Backend tạo user mới, tạo 2 bản ghi trong `user_roles`, `user_tenants.role` là mã vai trò đầu tiên. User đăng nhập có đủ toàn bộ quyền của cả 2 vai trò cộng lại. |
| **TC-08** | Ràng buộc bảo mật khi mời làm OWNER | Case 1: `ADMIN` thông thường cố tình gọi API mời kèm role `OWNER`.<br>Case 2: `SUPER_ADMIN` hoặc `OWNER` hiện tại của tenant gửi lời mời chọn role `OWNER`. | Case 1: Backend trả về `403 Forbidden: Chỉ Chủ sở hữu hoặc Super Admin mới có quyền chỉ định vai trò Chủ sở hữu`.<br>Case 2: Lời mời tạo thành công, người nhận sau khi chấp nhận trở thành `OWNER` chính thức của tổ chức. |
| **TC-09** | Chặn tuyệt đối chỉ định SUPER_ADMIN trong lời mời | Gửi request `POST /iam/invitations` với `roleIds` chứa ID hoặc mã liên quan đến `SUPER_ADMIN`. | Backend lập tức từ chối với lỗi `400 Bad Request: Không thể chỉ định vai trò Super Admin trong lời mời tổ chức`. |
| **TC-10** | Vòng đời lời mời (Thu hồi & Hết hạn) | Case 1: Quản trị viên bấm nút "Thu hồi" lời mời đang ở trạng thái `PENDING`.<br>Case 2: Lời mời đã quá hạn 7 ngày. | Trạng thái chuyển sang `REVOKED` hoặc `EXPIRED`. Khi người dùng truy cập link `/invite?token=...`, hệ thống từ chối cho phép tham gia và hiển thị thông báo lỗi rõ ràng. |
| **TC-11** | Gửi lại và Xóa lời mời | Case 1: Bấm "Gửi lại" lời mời ở trạng thái `EXPIRED` hoặc `REVOKED`.<br>Case 2: Bấm "Xóa" lời mời khỏi danh sách. | Case 1: Token mới được sinh, hạn được cộng thêm 7 ngày, trạng thái về `PENDING`, link mời mới hoạt động bình thường.<br>Case 2: Lời mời được gắn `deletedAt` (Soft delete), biến mất khỏi danh sách lời mời của tổ chức. |

