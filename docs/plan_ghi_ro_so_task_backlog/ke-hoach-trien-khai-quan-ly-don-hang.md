# Kế hoạch triển khai: Quản lý đơn hàng (Sales Order) — Backend + Frontend

> Tài liệu thực thi, viết dựa trên artifact `quan-ly-don-hang-backend-frontend.md` (REQ-001 → REQ-020, SC-001 → SC-012) và source hiện tại của `LogiX-Backend` và `LogiX-Frontend`.
> Kế hoạch gồm **5 giai đoạn**. Mỗi giai đoạn bàn giao được độc lập, phải test kỹ, dọn sạch dữ liệu và file test trước khi sang giai đoạn sau.
> Bối cảnh: **repo public, hệ thống B2B production**. Không hardcode, không dùng fallback nguy hiểm, không mock "cho chạy được".

---

## 0. Hiện trạng thực tế (so với artifact cũ)

### 0.1. Backend

| Thành phần | Hiện trạng | Thay đổi so với artifact cũ |
|---|---|---|
| `apps/order-service/prisma/schema.prisma` | Đã có `SalesOrder`, `OrderLine`, `OrderStatusHistory`, `OrderShortage`, `OutboxEvent`, `InboxEvent`. Status là `String`, không có Prisma enum. | **Mới:** `SalesOrder` có `customerSnapshot`, `deliveryAddressSnapshot`, `warehouseSnapshot` (Json, bắt buộc) và `billingAddressSnapshot` (Json?). Migration `20261010041342_add_order_snapshots`. Comment schema ghi: snapshot bất biến sau khi confirm. |
| `apps/order-service/src` | Chỉ có scaffold: `app.controller/service`, `database/prisma.service.ts`. `main.ts` dùng `process.env.PORT ?? 3002`; chưa có prefix `/api/v1`, chưa có `ValidationPipe`, chưa có guard, chưa có `dotenv/config`. | Không đổi |
| `apps/order-service` test | Dùng Vitest (`vitest run`), có `vitest.config.ts` và `vitest.config.e2e.ts`. Không có `.env.example`. | — |
| `apps/inventory-service` | Đã có `InventoryBalance` (cột generated `available = on_hand - reserved`), `StockMovement`, `StockReceipt`, Outbox/Inbox. **Đã có bảng** `ReservationGroup` (status `ACTIVE/RELEASED/ISSUED`, unique `(tenant_id, idempotency_key)`, có `orderVersion`) và `InventoryReservation` (unique `(tenant, group, order_line)`). | **Mới:** schema reservation đã có, nhưng **chưa có service/controller** reservation. README ghi rõ "outbox rows được ghi nhưng không ai publish". |
| `apps/api-gateway` | Proxy middleware cho auth/iam, master-data, inventory (`src/proxy/*-proxy.middleware.ts`). | Chưa có proxy order. |
| `libs/messaging` | Có `KafkaProducerService`, `DomainEventEnvelope`, `OrderCreatedPayload`, `OrderConfirmedPayload` (có snapshot), `OrderPendingStockPayload`. | `OrderCreatedPayload` vẫn có `unitPrice`, trong khi `OrderLine` không có giá. Chưa có outbox relay. Trong repo không có docker-compose Kafka. |
| Quyền | `apps/identity-service/prisma/seed.js` đã seed `order:sales-order:read/create/update/approve/cancel`. | Hành động **xác nhận đơn dùng `approve`**, không có `confirm`. |
| Master Data | REST theo tenant: `/customers`, `/customers/:id/addresses`, `/products`, `/warehouses`. Pagination trả `{ items, page, pageSize, total }`. | Không có batch lookup sản phẩm theo `ids`, không có endpoint nội bộ cho service khác. |
| Fulfillment / Transport | Chỉ có scaffold. | Không đổi |

### 0.2. Frontend

| Thành phần | Hiện trạng |
|---|---|
| Feature mẫu | `src/features/inventory`, `src/features/master-data`. Fetch bằng `useEffect` với request key (không dùng React Query). API trong `features/<domain>/api/*.api.ts` dùng `authFetch`, `handleResponse`, `toQueryString`, `stripBlanks` và parse response bằng Zod. |
| Component dùng lại | `ResourcePage`, `ResourceTable`, `ResourceFilters`, `ConfirmActionDialog`, `useResourceForm`, `ProductPicker`, `WarehousePicker`. API khách hàng: `listCustomersApi`, `listCustomerAddressesApi`. UI primitives shadcn: `table`, `pagination`, `select`, `combobox`, `tabs`, `sonner`. |
| Điều hướng | `app-sidebar.tsx` chưa có mục Orders. `workspace-guard.tsx` đã có rule `/orders` yêu cầu `order:sales-order:read` hoặc `order:sales-order:create`. |
| i18n | Runtime dùng `src/lib/i18n/locales/{vi,en}.json`. `src/locales/*` là bản sao, hiện vẫn cập nhật song song theo quy ước đang dùng. Chưa có namespace `orders`. |
| Hiển thị | `StatusBadge` có label tiếng Việt hardcode và chưa có đủ status của đơn. Chưa có helper định dạng ngày dùng chung; một số chỗ hardcode `"vi-VN"`. |
| Test | Không có test runner. Kiểm tra bằng `pnpm lint`, `pnpm typecheck`, `pnpm build` (hoặc `pnpm validate`). |
| Quy tắc (`AGENTS.md`) | FE không tự đặt ra rule nghiệp vụ hay chuyển trạng thái. Mọi chữ hiển thị phải đi qua i18n. Raw HTTP chỉ nằm trong `src/lib/api`. |

---

## 1. Nguyên tắc bắt buộc cho mọi giai đoạn

### 1.1. Clean code và kiến trúc

1. **Boundary:** Order chỉ ghi DB `orders`. Inventory là nguồn sự thật cho reserved/available. Fulfillment sở hữu Shipment. Không có foreign key xuyên DB, không service nào đọc DB của service khác.
2. **Phân lớp:** controller (mỏng) → service (use case) → mapper (DTO ↔ Prisma). Thêm `domain/order-state-machine.ts` dạng pure function để test riêng. Không dồn logic vào `AppService`.
3. **Tenant và actor** luôn lấy từ JWT (`@CurrentUser()` → `user.tenantId`, `user.sub`). Body và query **không được** chứa `tenantId`.
4. **Decimal/BigInt** không đưa thẳng ra JSON: decimal serialize thành chuỗi, `version` thành chuỗi hoặc số theo mẫu mapper của inventory.
5. **Transaction:** thay đổi nghiệp vụ, `OrderStatusHistory` và `OutboxEvent` phải nằm trong **cùng một** `$transaction`.
6. **Optimistic lock:** mọi command ghi đều nhận `version`, cập nhật bằng `where { id, tenantId, version }`. Nếu 0 dòng bị ảnh hưởng thì trả `409 CONFLICT`.
7. Migration chỉ dùng `pnpm --filter <service> db:migrate:dev --name <tên>`. **Không** dùng `db push`, **không** sửa migration đã apply.

### 1.2. Không hardcode, không fallback nguy hiểm

| Cấm | Thay bằng |
|---|---|
| `process.env.X \|\| 'http://localhost…'` / `?? 'secret'` cho URL hoặc secret mới | Khai báo trong config schema của `@logix/config` dạng **bắt buộc**; thiếu thì service fail-fast khi khởi động. (Các proxy cũ đang có fallback: không sao chép pattern đó; refactor phần cũ là việc riêng.) |
| `catch {}` nuốt lỗi, hoặc gặp lỗi Inventory thì vẫn coi như "thiếu hàng" / "đã giữ" | Ném lỗi chuẩn `@logix/errors` (503/502). Đơn giữ nguyên trạng thái và ghi log có `correlationId`. |
| Giả lập reserve thành công, tạo số shipment giả, mock dữ liệu trên UI | Chỉ hiển thị dữ liệu Backend trả về. |
| Hardcode mã quyền, status, chuỗi UI rải rác | Hằng số tập trung (`order-status.ts`, `order-permissions.ts`) và key i18n. |
| Secret, token, chuỗi kết nối trong code, test hoặc tài liệu commit | Chỉ đặt trong `.env` (đã gitignore). Cập nhật `.env.example` với giá trị trống hoặc placeholder. |
| FE dùng `"vi-VN"` cố định | Lấy locale từ `useI18n()`. |

### 1.3. Quy trình test và dọn dẹp sau mỗi giai đoạn

1. **Unit test (Vitest)** cho service, state machine và mapper. Đây là test lâu dài, **giữ trong repo**.
2. **API test thật** qua Gateway (`http://localhost:3000/api/v1`). Viết script tạm, ví dụ `scripts/tmp-order-phaseN.mjs`, với user và tenant QA có tiền tố riêng (`qa.order.p<N>.%`, `QA Order P<N> %`).
3. FE: chạy `pnpm validate` (lint + typecheck + build), sau đó người dùng tự kiểm tra UI theo checklist của giai đoạn.
4. **Dọn dẹp bắt buộc:**
   - xóa dữ liệu QA trong mọi DB bị chạm tới (`logix_identity`, `logix_master_data`, `logix_orders`, `logix_inventory`, …) bằng `docker exec -i logix-postgres psql -U postgres -d <db>`, lọc theo `tenant_id` của tenant QA;
   - xóa script tạm, file log, file `.http` tạm;
   - chạy lại `pnpm test` để chắc các test lâu dài vẫn xanh.
5. Không commit trừ khi người dùng yêu cầu.

---

## 2. Tổng quan 5 giai đoạn

| GĐ | Tên | Kết quả bàn giao | REQ chính | Phụ thuộc |
|---|---|---|---|---|
| 1 | Chốt contract và dựng nền order-service | Service chạy chuẩn, có auth và quyền, đi qua Gateway; chốt các quyết định kỹ thuật còn mở | 001, 016 (nền) | — |
| 2 | Backend Order Draft | API tạo/list/detail/sửa/hủy DRAFT hoàn chỉnh, có snapshot, totals, version, idempotency, history, outbox | 001–010, 014 (draft), 016, 018 | GĐ1 |
| 3 | Frontend Order Draft | Màn hình danh sách/tạo/sửa/chi tiết/hủy; đủ VI/EN | 017, 018, 020 | GĐ2 |
| 4 | Giữ hàng tự động và xử lý bất đồng bộ | Confirm all-or-nothing, PENDING_STOCK, shortage, retry FIFO, release khi hủy, outbox relay; cập nhật UI | 011–014, 019 | GĐ2 (BE), GĐ3 (FE) |
| 5 | Fulfillment/Shipment Pool, lifecycle, hardening, nghiệm thu | Shipment từ OrderConfirmed, PICKING/READY, chặn hủy sau dispatch, đo hiệu năng, đối chiếu SC | 015, 019, 020 | GĐ4 |

Mốc gọi tên: hết GĐ3 là **Order Draft MVP**. Chỉ khi xong GĐ4 mới được gọi là "Sales Order có giữ hàng". Chỉ khi xong GĐ5 mới gọi là "Quản lý đơn hàng hoàn chỉnh".

---

## 3. Giai đoạn 1 — Chốt contract và dựng nền order-service

> **Trạng thái: ✅ Hoàn thành.** Đã duyệt QĐ-1, QĐ-2 (làm InternalServiceGuard ngay ở GĐ1), QĐ-4, QĐ-6. Migration `order_draft_foundation` đã được apply. Đã test API qua Gateway (401/403/200; không proxy `/internal`). Đã dọn dữ liệu QA và xóa script tạm.

### 3.1. Mục tiêu

order-service khởi động đúng chuẩn của các service đã có (master-data, inventory), xác thực được JWT, kiểm tra được quyền và truy cập được qua Gateway. Các câu hỏi còn mở và các chỗ lệch contract được chốt ngay trong kế hoạch này (bảng 3.2) trước khi viết nghiệp vụ.

### 3.2. Quyết định kỹ thuật (QĐ) cần chốt

Các quyết định chỉ ghi trong bảng dưới đây, không tạo tài liệu ADR trong repo.

| # | Câu hỏi | Đề xuất mặc định (người dùng cần duyệt) |
|---|---|---|
| QĐ-1 | Confirm gọi Inventory theo cách nào? | **Command đồng bộ** Order → Inventory qua endpoint nội bộ `POST /internal/reservations` với idempotency key `order:{orderId}:v{orderVersion}`. Inventory giữ hàng all-or-nothing trong một transaction và trả `RESERVED` hoặc `INSUFFICIENT` kèm danh sách thiếu. Phần **bất đồng bộ** dùng cho: `StockReceived` → retry FIFO, `OrderConfirmed`/`OrderCanceled` → Fulfillment. Lý do: state machine không có trạng thái trung gian "CONFIRMING". Cách này cho UI kết quả xác định và tránh "thành công giả". |
| QĐ-2 | Xác thực service-to-service | Endpoint `/internal/*` **không** được Gateway proxy (pathFilter chỉ `/api/v1/...`). Endpoint được bảo vệ bằng `InternalServiceGuard`, xác thực token ký bằng `INTERNAL_SERVICE_JWT_SECRET`. Biến này bắt buộc trong config schema, **không có default**. Tenant truyền trong claim của token nội bộ, không lấy từ body. |
| QĐ-3 | Kiểm tra Master Data khi tạo/sửa đơn | Order gọi Master Data REST hiện có qua `MASTER_DATA_SERVICE_URL` (bắt buộc) và **forward Authorization của user**. Như vậy tenant và quyền đọc master data được kiểm tra ở chính service sở hữu. Gọi song song từng product (giới hạn số dòng, ví dụ ≤ 100 dòng/đơn, để trong config). Nếu sau này cần batch lookup thì thêm `GET /products?ids=` ở Master Data trong một task riêng. |
| QĐ-4 | FIFO dựa vào mốc nào; sửa đơn PENDING_STOCK có giữ vị trí không | Dùng `pendingSince` (mốc lần **đầu** vào PENDING_STOCK). Sửa line/kho của đơn PENDING_STOCK thì **mất vị trí** (reset `pendingSince`) và đơn vẫn ở PENDING_STOCK. Cần migration thêm cột `pending_since` cùng index `(tenant_id, warehouse_id, status, pending_since)`. |
| QĐ-5 | Race giữa hủy đơn và dispatch | Hủy đơn chỉ hợp lệ khi `status ∈ {DRAFT, PENDING_STOCK, CONFIRMED, PICKING, READY_TO_SHIP}`, kiểm tra bằng optimistic version. Dispatch (GĐ5) chuyển đơn sang IN_DELIVERY cũng bằng version. Bên nào commit sau sẽ nhận 409. Fulfillment khi nhận `OrderCanceled` mà shipment đã dispatched thì phát `ShipmentCancelRejected` để báo; trạng thái không được lùi. |
| QĐ-6 | Mã quyền cho confirm | Dùng mã đã seed `order:sales-order:approve` cho confirm và retry. **Không** tạo mã `confirm` mới, để tránh lệch với seed và RBAC plan. |
| QĐ-7 | Sinh mã đơn | Thêm bảng `order_number_sequences (tenant_id, period, last_value)`. Mỗi lần tạo đơn, khóa dòng bằng `UPDATE … RETURNING` trong transaction tạo đơn. Định dạng mã đơn: `SO-YYYYMMDD-000001`. Prefix lấy từ hằng số domain, không lấy từ input. |
| QĐ-8 | Idempotency tạo đơn | Header `Idempotency-Key` (bắt buộc với POST tạo đơn). Lưu `idempotencyKey` cùng `idempotency_request_hash` (SHA-256 của payload chuẩn hóa) với unique `(tenant_id, idempotency_key)`. Cùng key và cùng hash thì trả lại đơn cũ (200). Cùng key nhưng khác hash thì trả 409 `IDEMPOTENCY_KEY_REUSED`. |
| QĐ-9 | Lệch contract event | Bỏ `unitPrice` khỏi `OrderCreatedPayload` (đơn không có giá, giá nằm ngoài phạm vi). Thêm `eventVersion` mới nếu cần tương thích. Đối chiếu `StockReceivedPayload` với outbox thực tế của inventory và sửa interface theo **dữ liệu thật**. |

### 3.3. Việc cần làm (file thật)

**order-service**

1. `apps/order-service/src/main.ts`:
   - thêm `import 'dotenv/config'`;
   - thêm `setGlobalPrefix('api/v1')` và `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`, sao chép đúng từ `master-data-service/src/main.ts`;
   - bỏ `?? 3002` và đưa `PORT` vào config schema.
2. `apps/order-service/src/app.module.ts`:
   - mở rộng config schema: `DATABASE_URL`, `PORT`, `JWT_ACCESS_SECRET` (hoặc biến tương ứng đang dùng ở `@logix/auth`), `MASTER_DATA_SERVICE_URL`, `INVENTORY_SERVICE_URL`, `INTERNAL_SERVICE_JWT_SECRET`, `ORDER_MAX_LINES`, tất cả đều bắt buộc;
   - import module auth của `@logix/auth` giống inventory.
3. Xóa `app.controller.ts` và `app.service.ts` (Hello World). Thêm `GET /api/v1/orders/health` hoặc dùng health check chung nếu đã có.
4. Tạo khung module: `src/orders/orders.module.ts`, `src/orders/domain/order-status.ts`, `src/orders/domain/order-state-machine.ts`, `src/orders/domain/order-permissions.ts`.
5. Tạo `apps/order-service/.env.example`, liệt kê đủ key với giá trị trống. Đảm bảo `.env` đã nằm trong `.gitignore`.
6. Migration (QĐ-4, 7, 8): `pnpm --filter order-service db:migrate:dev --name order_draft_foundation`. Migration gồm:
   - cột `pending_since`, `idempotency_request_hash`;
   - bảng `order_number_sequences`;
   - **kiểm tra lại** unique `(tenant_id, idempotency_key)` và check constraint cho 9 status (thêm nếu thiếu).

**api-gateway**

7. `apps/api-gateway/src/proxy/order-proxy.middleware.ts`: copy pattern của inventory, `pathFilter` gồm `/api/v1/orders`. Target lấy từ `ORDER_SERVICE_URL`, **bắt buộc** (không `|| localhost`).
8. Đăng ký middleware trong `apps/api-gateway/src/app.module.ts`. Cập nhật `.env` và `.env.example` của gateway.

**libs**

9. `libs/messaging/src/interfaces/domain-event.interface.ts`: sửa theo QĐ-9. Tìm mọi nơi đang dùng interface này để đảm bảo build không gãy.
10. `libs/auth`: thêm `InternalServiceGuard` cùng helper ký và xác thực token nội bộ (dùng ở GĐ4), kèm unit test.

**identity**

11. Kiểm tra `seed.js`: quyền `order:*` đã được gán cho role Owner/Admin theo cơ chế hiện có. Nếu chưa, bổ sung trong seed (không chèn tay vào DB).

### 3.4. Tiêu chí hoàn thành

- `pnpm --filter order-service build` và `pnpm --filter order-service test` xanh. `pnpm --filter api-gateway build` xanh.
- Thiếu một biến env bắt buộc thì service **không khởi động** và báo lỗi rõ tên biến.
- Gọi qua Gateway `GET /api/v1/orders/health`:
  - không có token → 401;
  - token không có quyền → 403;
  - có `order:sales-order:read` → 200.
- Các QĐ ở mục 3.2 đã được người dùng duyệt.

### 3.5. Checklist test và dọn dẹp

- Unit test: `order-state-machine.spec.ts` liệt kê **toàn bộ** cặp chuyển tiếp hợp lệ và không hợp lệ theo bảng state machine (mục 7 artifact cũ). `InternalServiceGuard.spec.ts` kiểm tra token sai chữ ký, hết hạn, thiếu tenant.
- Script tạm `tmp-order-phase1.mjs`: kiểm tra 401/403/200 qua Gateway với user QA. Chạy xong thì xóa user/tenant QA và xóa script.

### 3.6. Không được làm

Không viết endpoint nghiệp vụ trước khi các QĐ được duyệt. Không thêm fallback URL hoặc secret. Không cho Gateway proxy `/internal/*`.

---

## 4. Giai đoạn 2 — Backend Order Draft

### 4.1. Mục tiêu

API đơn nháp hoàn chỉnh. Đây là nguồn sự thật duy nhất cho validate, snapshot, totals và trạng thái.

### 4.2. API (đường dẫn qua Gateway)

| Method | Path | Quyền | Mô tả |
|---|---|---|---|
| POST | `/api/v1/orders` | `order:sales-order:create` | Tạo DRAFT. Header `Idempotency-Key` bắt buộc. |
| GET | `/api/v1/orders` | `…:read` | Lọc theo `q` (orderNumber), `customerId`, `warehouseId`, `status[]`, `createdFrom/To`, `page`, `pageSize`. Sắp xếp ổn định `createdAt desc, id desc`. |
| GET | `/api/v1/orders/:id` | `…:read` | Header, lines, snapshot, totals, version. |
| GET | `/api/v1/orders/:id/history` | `…:read` | Timeline từ `OrderStatusHistory`. |
| PATCH | `/api/v1/orders/:id` | `…:update` | Sửa customer/address/warehouse/lines/currency khi đơn ở DRAFT. Body có `version`. |
| POST | `/api/v1/orders/:id/cancel` | `…:cancel` | Hủy DRAFT, body `{ version, reason }`. Các trạng thái khác được mở ở GĐ4/5. |

Response list theo đúng format master-data: `{ items, page, pageSize, total }`. Lỗi theo envelope của `@logix/errors`. Mã lỗi nghiệp vụ là hằng số, ví dụ:
- `ORDER_NOT_FOUND`
- `ORDER_INVALID_TRANSITION`
- `ORDER_VERSION_CONFLICT`
- `ORDER_ADDRESS_NOT_OF_CUSTOMER`
- `ORDER_MASTER_DATA_INACTIVE`
- `ORDER_DUPLICATE_PRODUCT`
- `ORDER_TOO_MANY_LINES`
- `IDEMPOTENCY_KEY_REUSED`
- `UPSTREAM_UNAVAILABLE`

### 4.3. File cần tạo

```
apps/order-service/src/orders/
  orders.module.ts
  orders.controller.ts                 # chỉ map HTTP ↔ service
  dto/create-order.dto.ts              # class-validator; quantity là chuỗi decimal > 0, tối đa 3 chữ số thập phân
  dto/update-order.dto.ts
  dto/list-orders.query.ts
  dto/cancel-order.dto.ts
  services/order-command.service.ts    # create/update/cancel
  services/order-query.service.ts      # list/detail/history
  services/order-number.service.ts     # QĐ-7
  services/order-totals.ts             # pure function, dùng Prisma.Decimal
  integrations/master-data.client.ts   # QĐ-3: fetch kèm timeout và forward Authorization, map lỗi upstream
  mappers/order.mapper.ts              # Decimal → string, BigInt → string
  outbox/order-outbox.writer.ts        # ghi OutboxEvent trong tx (chưa publish)
  *.spec.ts
```

### 4.4. Nghiệp vụ chi tiết

1. **Validate (REQ-002, 003, 004):**
   - 1 ≤ số dòng ≤ `ORDER_MAX_LINES`;
   - không trùng `productId` (trả lỗi rõ, không tự gộp);
   - quantity > 0;
   - customer ACTIVE; address thuộc customer và ACTIVE; warehouse ACTIVE; mỗi product ACTIVE;
   - currency theo ISO-4217 (3 chữ hoa).
   - Master Data trả 404 thì trả 422 kèm field. Master Data timeout hoặc 5xx thì trả 503 `UPSTREAM_UNAVAILABLE` và **không** tạo đơn.
2. **Snapshot (REQ-005):** Backend tự build snapshot từ response Master Data, bỏ qua mọi snapshot hoặc tổng do client gửi (DTO không có các field đó; `forbidNonWhitelisted` sẽ chặn):
   - `customerSnapshot`: code, name, taxCode, contact;
   - `deliveryAddressSnapshot`: các field địa chỉ và người nhận;
   - `warehouseSnapshot`: code, name, address, lat/lng;
   - line: `skuSnapshot`, `productNameSnapshot`, `unitSnapshot`, `unitWeight`, `unitVolume`.
   - Chính sách: khi sửa DRAFT thì **chụp lại snapshot** cho các phần bị đổi. Sau khi confirm, snapshot bất biến.
3. **Totals:** `totalQuantity = Σ qty`, `totalWeight = Σ qty × unitWeight`, `totalVolume = Σ qty × unitVolume`, tính bằng `Prisma.Decimal` (không dùng `number`).
4. **Transaction tạo đơn:** sinh số đơn → tạo `SalesOrder` (status `DRAFT`, `version 1`) và lines → `OrderStatusHistory(null → DRAFT, actorId, correlationId, orderVersion 1)` → `OutboxEvent OrderCreated`. Tất cả trong một `$transaction`.
5. **Update:** chỉ cho phép khi đơn ở DRAFT, theo state machine.
   - So version.
   - Thay lines theo cách diff: xóa mềm `deletedAt` hoặc xóa hẳn tùy convention hiện có; giữ unique `(tenant, order, product)` (lưu ý dòng đã xóa mềm vẫn chiếm unique, nên chọn xóa hẳn dòng của DRAFT hoặc dùng partial unique, ghi rõ lựa chọn vào bảng QĐ).
   - Tính lại totals và snapshot.
   - Tăng version.
   - Ghi history **chỉ khi đổi status**. Thay đổi nội dung ghi outbox `OrderUpdated` nếu contract cần.
6. **Cancel DRAFT:** đặt `canceledAt` và `cancelReason`, chuyển status sang CANCELED; ghi history và outbox `OrderCanceled`.
7. **Correlation:** đọc `x-correlation-id` từ request (nếu có, phải là UUID hợp lệ), nếu không thì tự sinh. Ghi vào history, outbox và log.

### 4.5. Tiêu chí hoàn thành (REQ / SC)

REQ-001 đến REQ-010, REQ-014 (phần DRAFT), REQ-016, REQ-018. SC-001 đến SC-005 của artifact cũ (phần draft).

### 4.6. Checklist test

**Unit (giữ lại trong repo):**
- totals với số thập phân, ví dụ trong mục 6.3 của artifact cũ (15 / 35 / 0,20);
- state machine;
- trùng product;
- address không thuộc customer;
- idempotency trong 3 tình huống: key mới, replay cùng hash, cùng key khác hash;
- version conflict;
- mapper không làm lộ BigInt/Decimal;
- Master Data timeout ra 503 và không ghi DB.

**API thật (`tmp-order-phase2.mjs`, xóa sau khi chạy)** — tenant QA A và B, mỗi tenant có customer, address, warehouse, 2 product:
1. Tạo đơn hợp lệ → 201. DB có header, lines, history và 1 outbox; `inventory_balances` **không đổi**.
2. Replay cùng `Idempotency-Key` → cùng `id`. Đổi payload với cùng key → 409.
3. Gửi kèm `customerSnapshot`/`totalWeight`/`tenantId` trong body → 400.
4. Tenant B đọc/sửa/hủy đơn của tenant A bằng ID → 404.
5. Address của customer khác → 422. Product bị disable → 422. Quantity `0` hoặc `-1` → 400.
6. Hai PATCH cùng version → request thứ hai nhận 409.
7. List với từng filter và phân trang, kiểm tra `total` đúng và không trùng hoặc sót giữa các trang.
8. Hủy DRAFT → CANCELED. Hủy lần hai → 409 `ORDER_INVALID_TRANSITION`.
9. User chỉ có quyền `read` gọi POST → 403.
10. Tắt master-data-service rồi tạo đơn → 503, không có bản ghi nào.

**Dọn dẹp:** xóa đơn, sequence và outbox của tenant QA trong `logix_orders`; xóa master data QA; xóa user/tenant QA; xóa script.

---

## 5. Giai đoạn 3 — Frontend Order Draft

### 5.1. Mục tiêu

Người dùng thao tác được toàn bộ luồng đơn nháp trên UI, dùng đúng theme và component hiện có, đủ VI/EN, không tự đặt ra rule nghiệp vụ.

### 5.2. File cần tạo hoặc sửa

```
src/features/orders/
  api/orders.api.ts            # listOrdersApi, getOrderApi, getOrderHistoryApi, createOrderApi(idempotencyKey), updateOrderApi, cancelOrderApi
  schemas/order.schema.ts      # Zod cho response và form; quantity giữ dạng string decimal
  constants/order-status.ts    # danh sách status + map sang key i18n + tone badge (không hardcode label)
  utils/order-actions.ts       # xác định nút được hiện từ status + quyền; chỉ dùng để ẩn/hiện, Backend vẫn là nơi quyết định
  components/
    orders-screen.tsx          # danh sách, dựa trên pattern ResourcePage/ResourceFilters/ResourceTable
    order-filters.tsx          # q, customer, warehouse (WarehousePicker), status (multi), khoảng ngày
    order-form.tsx             # tạo/sửa (trang riêng vì form nhiều dòng)
    order-lines-editor.tsx     # ProductPicker + quantity + preview tổng tải
    customer-address-select.tsx# dùng listCustomersApi + listCustomerAddressesApi
    order-detail.tsx           # header, snapshot, lines, totals, nút hành động
    order-timeline.tsx         # history
    cancel-order-dialog.tsx    # dựa trên ConfirmActionDialog, có ô reason
  index.ts
src/app/(workspace)/orders/page.tsx
src/app/(workspace)/orders/new/page.tsx
src/app/(workspace)/orders/[orderId]/page.tsx
src/app/(workspace)/orders/[orderId]/edit/page.tsx
src/components/shared/app-sidebar.tsx      # thêm mục "Đơn hàng", permission order:sales-order:read
src/components/shared/status-badge.tsx     # thêm tone cho các status đơn; label truyền vào từ i18n
src/lib/format/                            # (mới) formatDateTime(locale), formatDecimal(locale); dùng Intl, không hardcode "vi-VN"
src/lib/i18n/locales/{vi,en}.json          # namespace "orders" (+ đồng bộ src/locales/{vi,en}.json)
```

### 5.3. Yêu cầu UI

1. **Danh sách:**
   - cột: mã đơn, khách hàng (lấy từ snapshot), kho, trạng thái, tổng SL/khối lượng/thể tích, ngày tạo;
   - filter lưu trên URL giống inventory; phân trang;
   - có trạng thái loading, rỗng, lỗi (kèm nút thử lại);
   - nút "Tạo đơn" chỉ hiện khi có quyền `create`.
2. **Form:**
   - chọn lại customer thì reset address;
   - address chỉ hiện địa chỉ ACTIVE của customer đã chọn;
   - chỉ chọn một kho;
   - chặn chọn trùng product ngay trên UI; Backend vẫn validate;
   - preview tổng tải ghi rõ "tạm tính", không có trường giá hay tổng tiền;
   - nút submit bị disable khi đang gửi;
   - `Idempotency-Key = crypto.randomUUID()` sinh **một lần cho mỗi lần mở form** và giữ nguyên khi retry;
   - lỗi theo field map từ lỗi 422; khi lỗi thì **không mất dữ liệu đã nhập**.
3. **Conflict 409:** hiện dialog "Đơn đã được người khác cập nhật", có nút tải lại. Không tự ghi đè.
4. **Chi tiết:** snapshot customer/address/kho, các dòng, totals, timeline (actor, thời điểm, lý do). Nút Sửa/Hủy hiện theo `status` và quyền. Không có dropdown đổi trạng thái tùy ý.
5. **i18n:** mọi chuỗi đều nằm trong `orders.*`, gồm cả 9 status, message lỗi theo mã lỗi Backend, toast và empty state. Kiểm tra bằng script quét key (giống lần sửa `iam.invitations.invitedBy`) → 0 key thiếu ở cả VI và EN.
6. **Theme:** chỉ dùng primitives trong `src/components/ui` và token màu sẵn có; kiểm tra light/dark và responsive (sidebar thu gọn, mobile).
7. Khi có lỗi thì **không** hiện toast thành công. 403 hiển thị đúng màn access denied hiện có.

### 5.4. Tiêu chí hoàn thành

REQ-017, REQ-018, REQ-020 (phần draft). SC-006, SC-007.

### 5.5. Checklist test

- `pnpm validate` xanh (lint + typecheck + build).
- Script quét i18n tạm: 0 key thiếu. Chạy xong thì xóa script.
- Checklist để người dùng tự kiểm tra UI (backend chạy thật, tenant QA):
  - tạo đơn, sửa đơn, hủy đơn;
  - filter và phân trang;
  - mở 2 tab rồi sửa để ra conflict;
  - user chỉ có quyền read (không thấy nút Tạo/Sửa/Hủy);
  - tắt master-data-service rồi tạo đơn (hiện lỗi, giữ nguyên form);
  - đổi ngôn ngữ VI/EN trên cả 4 trang;
  - dark mode.
- **Dọn dẹp:** xóa dữ liệu QA như GĐ2, xóa script tạm.

---

## 6. Giai đoạn 4 — Giữ hàng tự động (Reservation) và xử lý bất đồng bộ

### 6.1. Mục tiêu

Xác nhận đơn giữ đủ **toàn bộ** hàng hoặc không giữ gì. Thiếu hàng thì đơn vào PENDING_STOCK và có shortage. Nhập kho thì retry theo FIFO. Hủy đơn thì giải phóng phần đã giữ. Mọi bước idempotent.

### 6.2. Inventory (nguồn sự thật của reserved)

```
apps/inventory-service/src/inventory/
  reservations.internal.controller.ts   # /internal/reservations (InternalServiceGuard), không qua Gateway
  services/reservation.service.ts
  dto/reserve.dto.ts, release.dto.ts
  *.spec.ts
```

1. `POST /internal/reservations` với body `{ orderId, orderVersion, warehouseId, lines[{orderLineId, productId, quantity}] }` và idempotency key `order:{orderId}:v{orderVersion}`.
   - Transaction: lock các dòng `inventory_balances` bằng `SELECT … FOR UPDATE` theo **thứ tự productId cố định** để tránh deadlock.
   - Nếu mọi dòng có `available ≥ qty`: tạo `ReservationGroup ACTIVE` và các `InventoryReservation`, tăng `reserved_quantity`, tăng version balance, ghi outbox `StockReserved`. Trả `RESERVED`.
   - Nếu thiếu: **không ghi gì vào balance**, trả `INSUFFICIENT` kèm `[{productId, required, available}]`.
   - Gọi lại cùng idempotency key thì trả đúng kết quả cũ (RESERVED). Với INSUFFICIENT thì không lưu group nên lần gọi sau đánh giá lại.
2. `POST /internal/reservations/release` với `{ orderId }`: chuyển group ACTIVE → RELEASED, giảm `reserved`, ghi outbox `StockReleased`. Idempotent: group đã RELEASED thì trả OK.
3. Nhập kho (`stock-receipt.service.ts`) đã ghi outbox. Chuẩn hóa payload `StockReceived` theo QĐ-9 (`warehouseId`, `productId`, `quantity`).
4. **Không** thay đổi `on_hand` khi reserve/release. Việc xuất kho (ISSUED) thuộc GĐ5.

### 6.3. Outbox relay và consumer (phần bất đồng bộ)

1. `libs/messaging`: thêm `OutboxRelay` dùng chung.
   - Poll `outbox_events WHERE published_at IS NULL AND next_attempt_at <= now()` theo batch, `FOR UPDATE SKIP LOCKED`.
   - Publish lên Kafka với key = `aggregateId`.
   - Thành công: set `publishedAt`. Thất bại: `attemptCount++`, `nextAttemptAt` tăng theo backoff, ghi `lastError`.
   - Tham số batch, interval và topic lấy từ config bắt buộc.
2. Bật relay trong order-service và inventory-service.
3. **Hạ tầng Kafka:** repo hiện chưa có compose. Thêm `docker-compose` dev (Kafka KRaft single-node) hoặc tài liệu hướng dẫn. `KAFKA_BROKERS` là biến bắt buộc, **không** mặc định `localhost:9092` trong code.
4. Consumer phía Order cho `StockReceived`/`StockReleased`:
   - ghi `InboxEvent (eventId, consumerName)` unique để chống xử lý trùng;
   - tìm các đơn PENDING_STOCK cùng tenant và warehouse, có product liên quan, sắp theo `pending_since ASC, id ASC`;
   - lần lượt gọi reserve. Gặp đơn vẫn thiếu thì cập nhật shortage và **đi tiếp** đơn sau; FIFO là thứ tự xét, không chặn cả hàng đợi (bổ sung ghi chú này vào QĐ-4).
5. Consumer của Inventory cho `OrderCanceled`: release (bản dự phòng khi Order gọi release đồng bộ thất bại).

### 6.4. Order

| Method | Path | Quyền | Mô tả |
|---|---|---|---|
| GET | `/api/v1/orders/:id/confirm-preview` | `…:approve` | Đọc available hiện tại (chỉ để tham khảo, gọi `GET /inventory/balances` forward JWT hoặc qua internal). Trả từng dòng đủ/thiếu. |
| POST | `/api/v1/orders/:id/confirm` | `…:approve` | `{ version }`. Gọi reserve. `RESERVED` → CONFIRMED (`confirmedAt`, snapshot đông cứng, outbox `OrderConfirmed`). `INSUFFICIENT` → PENDING_STOCK (`pendingSince` nếu chưa có, upsert `OrderShortage` theo `shortageHash`, outbox `OrderPendingStock`). Lỗi upstream → 503, **giữ nguyên DRAFT**. |
| POST | `/api/v1/orders/:id/retry-reservation` | `…:approve` | Retry thủ công cho đơn PENDING_STOCK. |
| GET | `/api/v1/orders/:id/shortages` | `…:read` | Danh sách thiếu chưa resolved. |
| POST | `/api/v1/orders/:id/cancel` | `…:cancel` | Mở rộng sang PENDING_STOCK và CONFIRMED. Nếu đã reserve thì gọi release **trước**, release thành công mới chuyển CANCELED. Release lỗi thì 503 và trạng thái giữ nguyên. |
| PATCH | `/api/v1/orders/:id` | `…:update` | Mở cho PENDING_STOCK (chưa có reservation). Reset `pending_since` theo QĐ-4. |

**Tính nhất quán khi Inventory đã giữ hàng nhưng transaction phía Order lỗi:** nhờ idempotency key, gọi lại confirm sẽ nhận lại RESERVED. Thêm job đối soát `reservation-reconciler` ở Inventory: group ACTIVE quá N phút (cấu hình) mà không có `StockReserved` được Order xác nhận (Order phát `OrderConfirmed` có `reservationGroupId`) thì cảnh báo và release theo quy tắc đã chốt. **Không** tự release khi chưa có xác nhận rõ ràng.

### 6.5. Frontend

- `order-detail.tsx`:
  - nút "Xác nhận đơn" (quyền `approve`) mở dialog preview, hiện bảng đủ/thiếu kèm ghi chú "số liệu tham khảo tại thời điểm xem";
  - bấm xác nhận thì gọi `confirm`; UI chỉ hiện trạng thái do Backend trả về.
- PENDING_STOCK: panel shortage (SKU, cần, có sẵn, thời điểm kiểm tra), nút "Thử giữ hàng lại", chip "Đang chờ hàng từ …".
- 503: thông báo "Kho tạm thời không phản hồi, đơn chưa được xác nhận". **Không** hiện thành "thiếu hàng".
- Danh sách: lọc PENDING_STOCK, cột hiện thời điểm chờ.
- Bổ sung i18n `orders.confirm.*`, `orders.shortage.*`, `orders.errors.UPSTREAM_UNAVAILABLE`, …

### 6.6. Tiêu chí hoàn thành

REQ-009 (pending), REQ-011 đến REQ-014, REQ-019. SC-008, SC-009, SC-011 (phần reservation).

### 6.7. Checklist test

**Unit:**
- reserve all-or-nothing: đủ, thiếu 1 SKU, thiếu tất cả;
- lock theo thứ tự cố định;
- idempotency reserve và release;
- inbox chống trùng;
- thứ tự FIFO;
- relay: retry/backoff, không publish 2 lần khi 2 instance chạy cùng lúc (`SKIP LOCKED`).

**API thật (`tmp-order-phase4.mjs`, xóa sau khi chạy)** — dùng ví dụ trong mục 6.1/6.2 của artifact cũ:
1. Đủ hàng → CONFIRMED. `reserved` tăng đúng, `on_hand` không đổi.
2. A đủ, B thiếu → PENDING_STOCK. `reserved` của **cả A và B không đổi**. Có shortage.
3. Gọi confirm 2 lần song song cùng version → chỉ một reservation.
4. Hai đơn PENDING_STOCK cùng SKU (đơn 1 trước). Nhập đủ cho 1 đơn → đơn 1 CONFIRMED, đơn 2 vẫn PENDING. Nhập thêm → đơn 2 CONFIRMED.
5. Phát lại cùng event `StockReceived` → không reserve thêm.
6. Hủy đơn CONFIRMED → reserved trả về như cũ, group RELEASED. Hủy lại → 409.
7. Tắt inventory-service rồi confirm → 503, đơn vẫn DRAFT, không có shortage.
8. Gọi trực tiếp `/api/v1/internal/...` qua Gateway → 404. Gọi `/internal/reservations` không có token nội bộ → 401.

**Dọn dẹp:** xóa dữ liệu QA ở `logix_orders` và `logix_inventory` (reservation, balance, movement, receipt, outbox, inbox của tenant QA) và master data/identity QA. Xóa topic test nếu đã tạo topic riêng. Xóa script.

---

## 7. Giai đoạn 5 — Fulfillment/Shipment Pool, lifecycle, hardening và nghiệm thu

### 7.1. Mục tiêu

Đơn đã xác nhận đi tiếp: tạo shipment, chuẩn bị hàng, sẵn sàng giao, dispatch. Trạng thái đơn chỉ đổi theo event của service sở hữu. Không hủy được sau dispatch. Đo và nghiệm thu toàn bộ SC.

### 7.2. Fulfillment-service

1. Schema theo `docs/architecture/database-design.md` (khoảng dòng 734 trở đi): `Shipment` (1 shipment/đơn theo AGENTS.md), snapshot người nhận/kho chụp **tại lúc tạo shipment**, status `PENDING_PICK → PICKING → READY_TO_SHIP → DISPATCHED → DELIVERED/FAILED/CANCELED`, version, Outbox/Inbox. Migration bằng `migrate dev`.
2. Consumer `OrderConfirmed` (idempotent theo `orderId + orderVersion`, ghi inbox): tạo shipment vào **Shipment Pool**.
3. API (qua Gateway `/api/v1/shipments`, thêm proxy với `FULFILLMENT_SERVICE_URL` bắt buộc):
   - list pool (lọc theo kho/status/ngày), detail;
   - `start-picking`, `mark-ready`, có version.
   - Permission mới seed trong `identity-service/prisma/seed.js` theo convention, ví dụ `fulfillment:shipment:read|update`. Tên chính xác chốt khi bắt đầu GĐ5.
4. Phát event `ShipmentPicking`, `ShipmentReadyToShip`. Consumer `OrderCanceled`: hủy shipment nếu chưa dispatch; nếu đã dispatch thì phát `ShipmentCancelRejected`.
5. **Dispatch** (`DISPATCHED`): phát `ShipmentDispatched`. Inventory consume để **ISSUE** reservation: giảm `on_hand` và `reserved` đúng một lần, ghi `StockMovement` (idempotency key `shipment:{id}:issue`). Phần trip/route của Transport **ngoài phạm vi**; dispatch ở đây là command tối thiểu trên shipment.

### 7.3. Order — projection lifecycle

- Consumer: `ShipmentPicking` → PICKING, `ShipmentReadyToShip` → READY_TO_SHIP, `ShipmentDispatched` → IN_DELIVERY, `ShipmentDelivered` → COMPLETED, `ShipmentDeliveryFailed` → DELIVERY_FAILED.
- **Chống lùi trạng thái:** chỉ áp dụng chuyển tiếp hợp lệ theo state machine. Event tới sai thứ tự hoặc đã cũ thì ghi inbox `IGNORED_STALE` và không đổi trạng thái.
- Cancel: chặn khi `status ∈ {IN_DELIVERY, DELIVERY_FAILED, COMPLETED}` (REQ-014, QĐ-5). Race với dispatch được xử lý bằng version.
- Không có API nào cho người dùng tự đặt PICKING/READY/IN_DELIVERY/COMPLETED (REQ-015).

### 7.4. Frontend

```
src/features/shipments/   # api, schemas, components: shipment-pool-screen, shipment-detail, các action dialog
src/app/(workspace)/shipments/page.tsx, [shipmentId]/page.tsx
workspace-guard.tsx       # thêm rule /shipments với quyền fulfillment
app-sidebar.tsx           # mục "Shipment Pool"
order-detail.tsx          # khối "Vận chuyển" lấy shipment thật theo orderId; nếu không có thì hiện trạng thái rỗng (không có số giả)
i18n                      # namespace "shipments" + bổ sung orders.lifecycle.*
```

Cập nhật trạng thái bằng refetch khi focus hoặc polling có giới hạn (interval để trong config). Không tự suy ra trạng thái ở client.

### 7.5. Hardening

1. **Race:** test song song cancel và dispatch → đúng một bên thắng, bên còn lại nhận 409 hoặc `ShipmentCancelRejected`; tồn kho nhất quán.
2. **Replay:** phát lại toàn bộ event của một đơn → không có thêm shipment, reservation hay issue.
3. **Phục hồi:** dừng Kafka hoặc consumer rồi bật lại → outbox tự publish lại, trạng thái hội tụ.
4. **Hiệu năng (SC-012):** script k6 hoặc autocannon tạm, 100 VU trong 10 phút với API list/detail/create/confirm. Ghi p95 và p95 từ publish đến khi có hiệu lực nghiệp vụ. Kết quả lưu vào `docs/` dưới dạng báo cáo đo (không phải script). Xóa script tải sau khi đo.
5. **Bảo mật:**
   - rà lại mọi endpoint có guard và quyền;
   - không lộ `/internal` qua Gateway;
   - không log PII hay token;
   - `.env.example` đầy đủ, không chứa secret.

### 7.6. Tiêu chí hoàn thành và nghiệm thu

REQ-015, REQ-019, REQ-020 (lifecycle). Toàn bộ SC-001 đến SC-012. Bảng đối chiếu REQ/SC → test/bằng chứng được cập nhật vào tài liệu dự án.

### 7.7. Checklist test và dọn dẹp

- Unit test cho fulfillment (state machine của shipment, consumer idempotent) và cho projection của order (stale event).
- API E2E tạm đi hết luồng: tạo → confirm → shipment xuất hiện trong pool → picking → ready → dispatch (`on_hand` giảm đúng một lần) → delivered → order COMPLETED. Thêm nhánh: hủy trước dispatch, hủy sau dispatch bị chặn, giao thất bại → DELIVERY_FAILED.
- `pnpm test` cho các service bị chạm; `pnpm validate` cho FE.
- **Dọn dẹp:** xóa dữ liệu QA ở `logix_orders`, `logix_inventory`, `logix_fulfillment`, master data, identity. Xóa topic test. Xóa script E2E và script tải.

---

## 8. Rủi ro chính và cách giảm thiểu

| Rủi ro | Giảm thiểu |
|---|---|
| Gọi Master Data từng product làm chậm khi đơn có nhiều dòng | Giới hạn bằng `ORDER_MAX_LINES`, gọi song song có giới hạn concurrency; đo trong GĐ5; đề xuất batch endpoint nếu vượt ngưỡng. |
| Inventory đã reserve nhưng Order chưa commit | Idempotency key theo version kèm reconciler (GĐ4); không tự release khi chưa chắc chắn. |
| Deadlock khi reserve nhiều SKU | Lock theo thứ tự `productId` cố định; dùng transaction ngắn. |
| Event sai thứ tự hoặc trùng | Ghi inbox, kiểm tra state machine, so `aggregateVersion`. |
| Lệch contract FE và BE | Schema Zod parse mọi response; đổi contract ở BE thì phải cập nhật Zod trong cùng giai đoạn. |
| Thiếu hạ tầng Kafka ở môi trường dev | Bổ sung compose hoặc tài liệu ở GĐ4. Tới lúc đó, các luồng đồng bộ (GĐ2–3) không phụ thuộc Kafka. |
| Locale có hai bản (`src/lib/i18n/locales` và `src/locales`) | Cập nhật cả hai theo quy ước hiện tại; nên dọn bản thừa trong một task riêng. |

## 9. Ngoài phạm vi (giữ nguyên artifact cũ)

Thanh toán, giá, thuế, khuyến mãi; đơn đa kho, partial reservation, split; 3PL, reverse logistics, GPS; trip/route và UI điều phối đầy đủ của Transport; tự tạo đơn từ forecast; AI tool orchestration.

## 10. Việc cần người dùng chốt trước khi bắt đầu GĐ1

1. Duyệt QĐ-1 (confirm đồng bộ, retry bất đồng bộ) và QĐ-2 (token nội bộ).
2. Duyệt QĐ-4: FIFO theo `pending_since`, sửa đơn thì mất vị trí.
3. Duyệt QĐ-6: dùng `approve` cho xác nhận đơn.
