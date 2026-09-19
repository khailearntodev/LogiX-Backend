# Kế hoạch triển khai: Multi-Tenant Combobox trong Sidebar LogiX

## Tổng quan mục tiêu

Bổ sung cơ chế **chọn tổ chức (tenant) đang hoạt động** ngay trên thanh sidebar bên trái, giống giao diện mẫu (Wareflex). Combobox hiển thị danh sách tenant mà người dùng tham gia, kèm các action **Tạo tổ chức mới** và **Cài đặt tổ chức**. Logo + tên LogiX chuyển xuống góc dưới sidebar. Mọi text UI phải được localise đầy đủ VI/EN.

---

## Phân tích hiện trạng

### Backend – `identity-service`
- ✅ Đã có đầy đủ các endpoint: `POST /auth/switch-tenant`, `POST /auth/organizations`, `GET /auth/me`, `POST /auth/login`
- ✅ `login` và `getProfile` đều trả về `tenants[]` + `activeTenant`
- ✅ `switchTenant` tạo JWT mới với `tenantId` mới trong payload
- ⚠️ **Thiếu**: Endpoint `GET /auth/tenants` riêng biệt để frontend fetch danh sách tenant độc lập (không phải lúc nào cũng gọi `GET /auth/me` toàn bộ profile)
- ⚠️ **Thiếu**: Endpoint `PATCH /auth/organizations/:id` để **cập nhật cài đặt tổ chức** (cần cho nút "Cài đặt tổ chức")
- ⚠️ **Thiếu**: `GET /auth/organizations/:id` để lấy chi tiết 1 tenant

### Frontend – Next.js + shadcn
- ✅ `AuthContext` đã có `switchTenant`, `createOrganization`, `tenants`, `activeTenant`
- ✅ shadcn components đã có: `Popover`, `Command`, `DropdownMenu`, `Dialog`, `Avatar`, `Badge`
- ✅ File locale `vi.json` / `en.json` đã tồn tại tại `src/locales/`
- ⚠️ **Thiếu**: Component `TenantSwitcher` trong sidebar
- ⚠️ **Thiếu**: Dialog "Tạo tổ chức mới" và Dialog/Page "Cài đặt tổ chức"
- ⚠️ **Thiếu**: Logic cập nhật `accessToken` mới vào mọi API call sau khi switch tenant
- ⚠️ **Brand logo** hiện đang ở phần đầu sidebar (header), cần chuyển xuống cuối

---

## Giai đoạn 1 – Backend: Bổ sung API Tenant

**Mục tiêu**: Đảm bảo identity-service có đủ endpoint để FE thực hiện đầy đủ thao tác quản lý tenant.

### 1.1 Thêm `GET /auth/tenants`

Endpoint trả về danh sách **tất cả tenant** mà user hiện tại (theo JWT) tham gia, không kèm thông tin profile. Nhẹ hơn `GET /auth/me`.

**File cần sửa/tạo:**
- [`auth.controller.ts`](file:///e:/GraduateProject/Logix/LogiX-Backend/apps/identity-service/src/auth/auth.controller.ts) — thêm `@Get('tenants')`, yêu cầu `JwtAuthGuard`
- [`auth.service.ts`](file:///e:/GraduateProject/Logix/LogiX-Backend/apps/identity-service/src/auth/services/auth.service.ts) — thêm method `getTenants(userId)`

**Response schema:**
```json
[
  {
    "id": "uuid",
    "code": "string",
    "name": "string",
    "logoUrl": "string | null",
    "role": "OWNER | ADMIN | MEMBER",
    "isDefault": true
  }
]
```

### 1.2 Thêm `GET /auth/organizations/:tenantId`

Lấy chi tiết một tổ chức (dùng cho trang Cài đặt tổ chức).

**File cần sửa/tạo:**
- [`auth.controller.ts`](file:///e:/GraduateProject/Logix/LogiX-Backend/apps/identity-service/src/auth/auth.controller.ts) — thêm `@Get('organizations/:tenantId')`
- [`auth.service.ts`](file:///e:/GraduateProject/Logix/LogiX-Backend/apps/identity-service/src/auth/services/auth.service.ts) — thêm method `getOrganization(userId, tenantId)`

> **Quan trọng – Tenant Isolation**: Phải xác thực rằng `userId` có `UserTenant` tồn tại với `tenantId` này. Không trả về tenant mà user không thuộc về.

### 1.3 Thêm `PATCH /auth/organizations/:tenantId`

Cập nhật thông tin tổ chức (tên, logo, v.v.). Chỉ OWNER hoặc ADMIN mới được phép.

**File cần sửa/tạo:**
- [`auth.controller.ts`](file:///e:/GraduateProject/Logix/LogiX-Backend/apps/identity-service/src/auth/auth.controller.ts) — thêm `@Patch('organizations/:tenantId')`
- `dto/update-organization.dto.ts` — **[NEW]** DTO mới với các trường `name?`, `logoUrl?`
- [`auth.service.ts`](file:///e:/GraduateProject/Logix/LogiX-Backend/apps/identity-service/src/auth/services/auth.service.ts) — thêm method `updateOrganization(userId, tenantId, dto)` có kiểm tra role

### 1.4 Thêm `POST /auth/organizations/:tenantId/set-default`

Đặt một tenant làm tenant mặc định (mặc định khi đăng nhập lại).

**File cần sửa/tạo:**
- [`auth.controller.ts`](file:///e:/GraduateProject/Logix/LogiX-Backend/apps/identity-service/src/auth/auth.controller.ts) — thêm `@Post('organizations/:tenantId/set-default')`
- [`auth.service.ts`](file:///e:/GraduateProject/Logix/LogiX-Backend/apps/identity-service/src/auth/services/auth.service.ts) — thêm `setDefaultTenant(userId, tenantId)` dùng transaction để unset cũ, set mới

### 1.5 Kiểm thử Backend

Sau khi implement, chạy:
```bash
pnpm lint
pnpm typecheck
pnpm test
```
Tại thư mục `LogiX-Backend`.

---

## Giai đoạn 2 – Frontend: Cập nhật Auth API và Context

**Mục tiêu**: Mở rộng tầng API và Context để hỗ trợ các endpoint mới + cải thiện luồng switch tenant.

### 2.1 Cập nhật `src/features/identity/api/auth.api.ts`

Thêm các hàm API mới:
- `getTenantsApi(accessToken?)` — gọi `GET /auth/tenants`
- `getOrganizationApi(tenantId, accessToken?)` — gọi `GET /auth/organizations/:tenantId`
- `updateOrganizationApi(tenantId, data, accessToken?)` — gọi `PATCH /auth/organizations/:tenantId`
- `setDefaultTenantApi(tenantId, accessToken?)` — gọi `POST /auth/organizations/:tenantId/set-default`

### 2.2 Cập nhật `src/features/identity/schemas/auth.schema.ts`

Thêm schema Zod và type:
- `organizationDetailSchema` — chi tiết tổ chức
- `updateOrganizationSchema` — DTO cập nhật tổ chức
- `OrganizationDetail`, `UpdateOrganizationData` — export type

### 2.3 Cải thiện `src/lib/auth/auth-context.tsx`

**Thay đổi quan trọng trong `switchTenant`:**
- Sau khi nhận `accessToken` mới từ `switch-tenant`, phải:
  1. Cập nhật `accessToken` trong state và `sessionStorage`
  2. Fetch lại danh sách tenant mới bằng `getTenantsApi` với token mới
  3. Cập nhật `activeTenant` trong state

**Thêm vào `AuthContextType`:**
```typescript
setDefaultTenant: (tenantId: string) => Promise<void>;
updateOrganization: (tenantId: string, data: UpdateOrganizationData) => Promise<void>;
```

**Thêm vào `AuthProvider`:**
- `setDefaultTenant` — gọi API rồi cập nhật `tenants[]` (đánh dấu lại `isDefault`)
- `updateOrganization` — gọi API rồi cập nhật tên/logo trong `tenants[]` và `activeTenant` nếu là tenant đang active

---

## Giai đoạn 3 – Frontend: Component TenantSwitcher

**Mục tiêu**: Tạo component combobox tenant đặt ở góc trên trái sidebar.

### 3.1 Tạo `src/components/shared/tenant-switcher.tsx` — **[NEW]**

Component `TenantSwitcher` sử dụng `Popover` + `Command` từ shadcn.

**Cấu trúc giao diện (theo ảnh mẫu):**

```
┌──────────────────────────────┐
│ [Logo] Tên Tổ Chức  FREE ▼  │  ← Trigger button
└──────────────────────────────┘
         ▼ (khi mở)
┌──────────────────────────────┐
│ TỔ CHỨC CỦA BẠN             │
│ ● Tổ chức A   [MẶC ĐỊNH] ●  │  ← active + default badge
│   Tổ chức B                  │
│   Tổ chức C                  │
├──────────────────────────────┤
│ ⚙ Cài đặt tổ chức           │
├──────────────────────────────┤
│ [Admin-only section]         │
│ 🏢 Tất cả tổ chức (Admin)   │
│ 👤 Tất cả người dùng (Admin)│
│ 🔒 Bảo mật hệ thống (Admin) │
├──────────────────────────────┤
│ + Tạo tổ chức mới            │
└──────────────────────────────┘
```

**Logic hiển thị:**
- Lấy `tenants`, `activeTenant` từ `useAuth()`
- Mỗi tenant hiển thị: Avatar (logo hoặc initials), tên (truncate), badge `MẶC ĐỊNH`/`DEFAULT` nếu `isDefault: true`, dot xanh nếu là `activeTenant`
- Nút "Cài đặt tổ chức" → mở Dialog cài đặt hoặc navigate đến route `/settings/organization`
- Nút "Tạo tổ chức mới" → mở Dialog tạo mới
- Section Admin (Admin/tất cả tổ chức...) → chỉ hiện nếu role = `OWNER` hoặc `ADMIN`
- Khi click 1 tenant → gọi `switchTenant(tenantId)` → loading state → toast thành công/thất bại

**Collapsed state (sidebar thu gọn):**
- Chỉ hiện avatar logo/initials của `activeTenant` (không có text), tooltip hiện tên

### 3.2 Tạo Dialog "Tạo tổ chức mới" — `create-org-dialog.tsx` — **[NEW]**

Nằm trong `src/components/shared/` hoặc `src/features/identity/components/`.

**Form fields:**
- Tên tổ chức (required, min 2 ký tự)
- Mã tổ chức/slug (optional, tự sinh nếu để trống)
- Checkbox "Đặt làm tổ chức mặc định"

**Hành vi:**
- Submit → gọi `createOrganization(data)` từ AuthContext
- Thành công → đóng dialog, toast success, optionally tự động `switchTenant` sang org mới
- Lỗi → hiện toast error

### 3.3 Tạo Dialog "Cài đặt tổ chức" — `org-settings-dialog.tsx` — **[NEW]**

Nằm trong `src/features/identity/components/`.

**Tabs hoặc sections:**
- **Thông tin chung**: Tên tổ chức, logo URL, mã tổ chức (readonly)
- **Quản lý mặc định**: Nút "Đặt làm tổ chức mặc định"
- (Tương lai: Thành viên, Cài đặt bảo mật)

---

## Giai đoạn 4 – Frontend: Tái cấu trúc Sidebar Layout

**Mục tiêu**: Tích hợp `TenantSwitcher` vào đầu sidebar, chuyển logo/brand xuống cuối.

### 4.1 Sửa `src/components/shared/app-sidebar.tsx`

**Thay đổi cấu trúc:**

```
TRƯỚC:
┌───────────────────┐
│ [Logo] LogiX      │  ← Brand Header (h-16)
│  Intelligent...   │
├───────────────────┤
│  Nav Links        │
└───────────────────┘

SAU:
┌───────────────────┐
│ [TenantSwitcher]  │  ← Tenant selector (h-14~16)
├───────────────────┤
│  Nav Links        │
│  (flex-1 scroll)  │
├───────────────────┤
│ [Logo] LogiX      │  ← Brand Footer (tĩnh, h-14)
│  Intelligent...   │
└───────────────────┘
```

**Điều chỉnh collapsed state:**
- Desktop collapsed: `TenantSwitcher` chỉ hiển thị avatar, brand footer hiển thị logo nhỏ
- Mobile drawer: hiển thị đầy đủ cả hai

### 4.2 Cập nhật Mobile Drawer (Sheet)

Trong phần `SheetContent`, áp dụng layout tương tự: `TenantSwitcher` trên cùng, brand ở dưới.

---

## Giai đoạn 5 – Frontend: Localisation (VI/EN)

**Mục tiêu**: Mọi string UI phải đi qua `t()` hook, không có hardcode.

### 5.1 Cập nhật `src/locales/vi.json`

Thêm namespace `tenant`:

```json
"tenant": {
  "yourOrganizations": "Tổ chức của bạn",
  "defaultBadge": "Mặc định",
  "activeDot": "Đang hoạt động",
  "orgSettings": "Cài đặt tổ chức",
  "allOrgs": "Tất cả tổ chức (Admin)",
  "allUsers": "Tất cả người dùng (Admin)",
  "systemSecurity": "Bảo mật hệ thống (Admin)",
  "createNew": "Tạo tổ chức mới",
  "switchingTo": "Đang chuyển sang {name}...",
  "switchSuccess": "Đã chuyển sang tổ chức {name}",
  "switchError": "Không thể chuyển tổ chức. Vui lòng thử lại.",
  "createOrgTitle": "Tạo tổ chức mới",
  "createOrgDesc": "Tạo một không gian làm việc mới cho nhóm của bạn",
  "orgNameLabel": "Tên tổ chức",
  "orgNamePlaceholder": "VD: Công ty TNHH ABC",
  "orgCodeLabel": "Mã tổ chức (tùy chọn)",
  "orgCodePlaceholder": "VD: abc-company (tự sinh nếu để trống)",
  "setAsDefault": "Đặt làm tổ chức mặc định",
  "createButton": "Tạo tổ chức",
  "creating": "Đang tạo...",
  "createSuccess": "Tạo tổ chức thành công!",
  "createError": "Tạo tổ chức thất bại. Vui lòng thử lại.",
  "settingsTitle": "Cài đặt tổ chức",
  "settingsDesc": "Quản lý thông tin và cài đặt tổ chức",
  "orgNameUpdate": "Cập nhật tên tổ chức",
  "setDefault": "Đặt làm mặc định",
  "setDefaultSuccess": "Đã đặt tổ chức mặc định thành công",
  "setDefaultError": "Không thể cập nhật tổ chức mặc định",
  "saveSettings": "Lưu thay đổi",
  "saveSuccess": "Đã lưu cài đặt tổ chức",
  "saveError": "Lưu thất bại. Vui lòng thử lại.",
  "freePlan": "Miễn phí",
  "noTenants": "Bạn chưa tham gia tổ chức nào",
  "loadingTenants": "Đang tải danh sách tổ chức..."
}
```

### 5.2 Cập nhật `src/locales/en.json`

```json
"tenant": {
  "yourOrganizations": "Your Organizations",
  "defaultBadge": "Default",
  "activeDot": "Active",
  "orgSettings": "Organization Settings",
  "allOrgs": "All Organizations (Admin)",
  "allUsers": "All Users (Admin)",
  "systemSecurity": "System Security (Admin)",
  "createNew": "Create New Organization",
  "switchingTo": "Switching to {name}...",
  "switchSuccess": "Switched to {name}",
  "switchError": "Failed to switch organization. Please try again.",
  "createOrgTitle": "Create New Organization",
  "createOrgDesc": "Create a new workspace for your team",
  "orgNameLabel": "Organization Name",
  "orgNamePlaceholder": "E.g. My Company Ltd.",
  "orgCodeLabel": "Organization Code (optional)",
  "orgCodePlaceholder": "E.g. my-company (auto-generated if empty)",
  "setAsDefault": "Set as default organization",
  "createButton": "Create Organization",
  "creating": "Creating...",
  "createSuccess": "Organization created successfully!",
  "createError": "Failed to create organization. Please try again.",
  "settingsTitle": "Organization Settings",
  "settingsDesc": "Manage your organization info and settings",
  "orgNameUpdate": "Update organization name",
  "setDefault": "Set as Default",
  "setDefaultSuccess": "Default organization updated successfully",
  "setDefaultError": "Failed to update default organization",
  "saveSettings": "Save Changes",
  "saveSuccess": "Organization settings saved",
  "saveError": "Failed to save. Please try again.",
  "freePlan": "Free",
  "noTenants": "You are not a member of any organization",
  "loadingTenants": "Loading organizations..."
}
```

---

## Giai đoạn 6 – Tích hợp và kiểm thử End-to-End

### 6.1 Luồng tích hợp hoàn chỉnh

```
[User click tenant khác]
    → TenantSwitcher.handleSelect(tenantId)
    → AuthContext.switchTenant(tenantId)
    → switchTenantApi({ tenantId }, currentAccessToken)
    → POST /auth/switch-tenant { tenantId }
    → Backend: xác thực UserTenant, tạo JWT mới với tenantId mới
    → Response: { accessToken: newToken, activeTenant: { ... } }
    → FE: setAccessToken(newToken), setActiveTenant(...)
    → FE: getTenantsApi(newToken) → setTenants(...)
    → Toast: "Đã chuyển sang tổ chức X"
    → UI cập nhật: TenantSwitcher hiển thị tổ chức mới đang active
```

### 6.2 Kiểm tra đặc biệt

| Tình huống | Kết quả mong đợi |
|---|---|
| User có 1 tenant | Combobox hiển thị 1 item, không thể switch |
| User có nhiều tenant | Switch tenant thành công, UI cập nhật ngay |
| Switch tenant lỗi (403) | Toast lỗi, không thay đổi activeTenant |
| Tạo org thành công | Org mới xuất hiện trong danh sách |
| Tạo org thất bại | Toast lỗi, dialog không đóng |
| Collapsed sidebar | Chỉ hiện avatar, tooltip khi hover |
| Light mode / Dark mode | Không bị vỡ màu, đủ contrast |
| Mobile drawer | TenantSwitcher hiển thị đầy đủ trong Sheet |
| Locale VI | Tất cả text hiển thị tiếng Việt |
| Locale EN | Tất cả text hiển thị tiếng Anh |

### 6.3 Chạy kiểm thử tự động

**Backend:**
```bash
cd LogiX-Backend
pnpm lint
pnpm typecheck
pnpm test
```

**Frontend:**
```bash
cd LogiX-Frontend
pnpm lint
pnpm exec tsc --noEmit
pnpm build
```

---

## Tổng hợp file cần thay đổi

### Backend — `LogiX-Backend/apps/identity-service`

| File | Trạng thái | Mô tả |
|---|---|---|
| `src/auth/auth.controller.ts` | MODIFY | Thêm 4 endpoint mới |
| `src/auth/services/auth.service.ts` | MODIFY | Thêm 4 method tương ứng |
| `src/auth/dto/update-organization.dto.ts` | **NEW** | DTO cập nhật tổ chức |

### Frontend — `LogiX-Frontend/src`

| File | Trạng thái | Mô tả |
|---|---|---|
| `features/identity/api/auth.api.ts` | MODIFY | Thêm 4 hàm API mới |
| `features/identity/schemas/auth.schema.ts` | MODIFY | Thêm schema + type mới |
| `lib/auth/auth-context.tsx` | MODIFY | Thêm action mới, cải thiện switchTenant |
| `components/shared/tenant-switcher.tsx` | **NEW** | Component combobox tenant chính |
| `components/shared/create-org-dialog.tsx` | **NEW** | Dialog tạo tổ chức mới |
| `features/identity/components/org-settings-dialog.tsx` | **NEW** | Dialog cài đặt tổ chức |
| `components/shared/app-sidebar.tsx` | MODIFY | Tích hợp TenantSwitcher, chuyển brand xuống cuối |
| `components/shared/index.ts` | MODIFY | Export các component mới |
| `locales/vi.json` | MODIFY | Thêm namespace `tenant` |
| `locales/en.json` | MODIFY | Thêm namespace `tenant` |

---

## Ràng buộc kiến trúc cần tuân thủ

> [!IMPORTANT]
> - **Tenant isolation**: Mọi endpoint mới phải xác thực `userId` thuộc `tenantId` trước khi trả dữ liệu
> - **Authorization server-side**: Role check (OWNER/ADMIN để update org) phải ở backend, FE chỉ ẩn/hiện UI
> - **accessToken propagation**: Sau `switchTenant`, token mới phải được dùng cho tất cả API call tiếp theo
> - **Locale bắt buộc**: Không được hardcode bất kỳ string nào trong UI — tất cả phải qua `t()`
> - **Light/Dark mode**: Mọi component mới phải test cả 2 mode
> - **Responsive**: Phải kiểm tra trên mobile (Sheet/drawer) và desktop (collapsed/expanded sidebar)
