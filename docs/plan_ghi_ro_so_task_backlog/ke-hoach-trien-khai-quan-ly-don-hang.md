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
| QĐ-4 | FIFO dựa vào mốc nào; sửa đơn PENDING_STOCK có giữ vị trí không | Dùng `pendingSince` (mốc lần **đầu** vào PENDING_STOCK). Sửa line/kho của đơn PENDING_STOCK thì **mất vị trí** (reset `pendingSince`) và đơn vẫn ở PENDING_STOCK. FIFO là thứ tự xét; đơn vẫn thiếu không chặn xét đơn sau. Cần migration thêm cột `pending_since` cùng index `(tenant_id, warehouse_id, status, pending_since)`. |
| QĐ-5 | Race giữa hủy đơn và dispatch | **Đã duyệt khi bắt đầu GĐ5:** Order phân xử trên cùng bản ghi đơn bằng transaction ngắn/row lock: ý định hủy và quyết định chấp thuận dispatch loại trừ nhau. Optimistic version riêng ở hai database không đủ. Fulfillment lưu yêu cầu dispatch trước khi gọi Order, retry cùng mã thao tác khi timeout; sau khi được chấp thuận phải tiếp tục hoàn tất, không tự hết hạn/hoàn tác. Chặn hủy ngay sau khi Order chấp thuận, kể cả projection chưa IN_DELIVERY. Fulfillment vẫn sở hữu shipment; Order chỉ chuyển IN_DELIVERY theo event. Inventory ISSUE theo event đúng một lần. |
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

> **Trạng thái: ✅ Hoàn thành.** Đã có 6 endpoint ở mục 4.2 và đi được qua Gateway. 136 unit test pass. Build, lint, typecheck của order-service, master-data-service, api-gateway và libs/messaging đều xanh. Đã chạy 43 kiểm tra API thật cho đủ 10 case ở mục 4.6, cộng thêm case 2 request đồng thời cùng `Idempotency-Key`: kết quả trả cùng `id` và chỉ tạo 1 bản ghi. Dữ liệu QA và script tạm đã được xóa.

**Quyết định chốt khi triển khai GĐ2:**

| # | Nội dung |
|---|---|
| D2-1 | Master Data trả `version` dạng number. Snapshot lưu `customerVersion`, `addressVersion`, `warehouseVersion`. |
| D2-2 | Đơn tạo tay có `orderSource = MANUAL`. |
| D2-3 | Chuyển trạng thái sai (sửa đơn không ở DRAFT, hủy đơn đã CANCELED) trả 409 với code `INVALID_STATE_TRANSITION` và `details.reason = ORDER_INVALID_TRANSITION`. Các mã `ORDER_*` khác cũng nằm trong `details.reason`. |
| D2-4 | PATCH có `lines` thì thay toàn bộ dòng: xóa dòng cũ rồi tạo lại, sau đó tính lại totals. |
| D2-5 | Sửa đơn DRAFT chỉ ghi outbox `OrderUpdated`, không ghi `OrderStatusHistory`, vì trạng thái không đổi. |
| D2-6 | Timeout khi gọi Master Data là hằng số domain 5000 ms, gọi đồng thời tối đa 10 request. 404 được hiểu là không có dữ liệu (trả 422). 5xx, timeout hoặc body sai trả 503. 400/401/403 trả 502. |
| D2-7 | Mã đơn tính theo ngày ở múi giờ `Asia/Ho_Chi_Minh`, định dạng `SO-YYYYMMDD-000001`. |
| D2-8 | Địa chỉ giao phải thuộc customer, có loại `SHIPPING` và đang `ACTIVE`. |
| D2-9 | Totals làm tròn half-up: quantity 3 chữ số thập phân, weight 3, volume 6. Response trả chuỗi; không lộ BigInt/Decimal. |

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

> **Trạng thái: ✅ Code hoàn thành, chờ người dùng tự kiểm tra UI.** Đã có 4 trang `/orders`, `/orders/new`, `/orders/[orderId]`, `/orders/[orderId]/edit` và mục sidebar. `pnpm lint`, `pnpm typecheck` và `pnpm build` đều xanh. Script quét i18n cho 119 key tĩnh, 9 status và 15 mã lỗi Backend: 0 key thiếu ở cả 4 file locale; key VI/EN khớp nhau; không file nào có BOM; script đã xóa. Một số điểm khác so với 5.2:
> - status/tone nằm trong `constants/order.constants.ts` + `components/order-status-badge.tsx`, không sửa `status-badge.tsx` dùng chung;
> - trang chi tiết là `order-detail-screen.tsx`;
> - có thêm `version-conflict-dialog.tsx`, `customer-picker.tsx`, `utils/{idempotency,order-errors,load-preview,order-form}.ts`;
> - FE gửi currency cố định `VND`, không hiện trường này (QĐ của người dùng).

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

> **Trạng thái: Đã triển khai Backend/Frontend; API và integration đã kiểm chứng, chưa nghiệm thu tương tác UI trên trình duyệt.** Quyết định bổ sung của người dùng: dựng Kafka dùng chung cho hệ thống; reservation bị treo được đối soát qua API nội bộ của Order để hoàn tất confirm nếu còn hợp lệ. Chỉ release khi Order xác nhận rõ reservation không còn được sử dụng; thiếu event hoặc lỗi kết nối không cho phép tự release.

> **Quyết định phục hồi hủy:** lưu yêu cầu hủy bền vững trước khi gọi Inventory. Khi release hoặc ghi CANCELED lỗi, giữ trạng thái nghiệp vụ cũ nhưng khóa sửa/xác nhận, hiển thị đang xử lý hủy và tự thử hoàn tất. Không để đơn CONFIRMED tiếp tục vận hành khi hàng có thể đã được release.

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
| POST | `/api/v1/orders/:id/cancel` | `…:cancel` | DRAFT/PENDING_STOCK/CONFIRMED: lưu cancellation intent + tăng version trước; gọi release; chỉ chuyển CANCELED + tăng version lần nữa khi release thành công. Release lỗi thì 503, status cũ nhưng khóa thao tác; worker tự phục hồi. |
| PATCH | `/api/v1/orders/:id` | `…:update` | Mở cho PENDING_STOCK chưa reservation/intent hủy. Kiểm tra active reservation dưới lock Order; chỉ reset `pending_since` khi gửi sửa line/kho. |

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

### 6.8. Bàn giao triển khai và bằng chứng

**Đã nối đầy đủ:**
- Kafka KRaft local dùng chung, script provision topic và cấu hình bắt buộc; relay Order/Inventory, retry/backoff, lock và thứ tự event cùng aggregate.
- Inventory reserve/preview/active/release nội bộ: tenant từ token nội bộ, all-or-nothing, decimal string, key theo version, không đổi on-hand.
- Order confirm-preview/confirm/retry/shortages; PENDING_STOCK editable khi chưa reservation; khóa thao tác trong thời gian phục hồi hủy.
- FIFO và Inbox theo warehouse + từng Order; consumer Inventory acknowledge/release; job phục hồi hủy và đối soát reservation orphan.
- Frontend preview xác nhận, bảng shortage/thời điểm chờ, retry thủ công, phân biệt 503 với thiếu hàng, khóa hủy đang phục hồi; đồng bộ VI/EN ở cả hai bộ locale.
- Migration `track_order_reservation_group`, `persist_order_cancellation_intent`, `acknowledge_order_reservations` đã áp dụng.

**Chi tiết phục hồi tránh mất tín hiệu:**
- `OrderPendingStock` lần đầu và `OrderUpdated` khi còn pending tự đánh thức FIFO, tránh nhập kho tới trước commit pending.
- Retry vẫn thiếu không phát thêm `OrderPendingStock`, tránh vòng lặp event vô hạn.
- Khi Inventory đã reserve nhưng Order rollback, key không đổi giúp confirm/reconciler dùng lại group; version tăng và key mới không được chiếm một group active cũ.
- Release đối soát chỉ nhắm group được quét, không giải phóng một group mới của Order. Các lý do release (Order không tồn tại/đã hủy, trạng thái hoặc version/nội dung không còn phù hợp) không cho phép tự nhận lại group cũ; đường confirm luôn kiểm tra version dưới lock và Inventory kiểm tra key/nội dung active.
- Hủy API lặp sau CANCELED vẫn 409; worker gặp hủy đã hoàn tất trả kết quả hiện tại, không release thêm.

**Bằng chứng kiểm thử (lệnh cuối thành công phải có exit code 0):**

| Phạm vi | Bằng chứng đã chạy | Kết quả |
|---|---|---|
| Reserve/confirm/atomicity/recovery/relay thật | Suite integration tạm PostgreSQL + HTTP + Kafka; gồm 9 case, tenant/topic QA riêng ở lượt cuối | 9/9, exit 0 |
| Consumer Kafka phục hồi | Event đầu làm handler lỗi tạm thời; consumer tự restart, nhận lại cùng eventId rồi xử lý event kế tiếp | 1/1, exit 0 |
| Inventory HTTP + event hủy trùng | Internal token, reserve, acknowledge lặp, hai event cancel song song; on-hand không đổi, reserved giảm một lần, Inbox/StockReleased một lần | 1/1, exit 0 |
| Gateway + AppModule thật | Order/Inventory/Gateway trên cổng ngẫu nhiên; relay tự chạy được vô hiệu hóa trong riêng test này để không quét outbox người dùng, event gửi vào Kafka topic QA; 401/403/tenant 404/internal 404, preview, FIFO, shortage, replay, cancel, retry sau release | 1/1, exit 0 |
| Unit | `pnpm --filter order-service test`, `inventory-service test`, `@logix/messaging test`: command/version, FIFO/wakeup/Inbox, retry/backoff, fail-closed reconcile, recovery | Order 183/183, Inventory 37/37, messaging 30/30; tổng 250, exit 0 |
| Backend compile/lint | Shared messaging build, Order/Inventory TypeScript đầy đủ, oxlint source/test và production `nest build` hai service | Exit 0 |
| Frontend | Full lint, typecheck, production build; hai bộ locale đồng bộ | Exit 0 |

**Dọn dẹp và giới hạn nghiệm thu:**
- Các integration spec tạm đã xóa sau chạy; dữ liệu của đúng tenant QA được xóa, topic/group QA riêng được xóa, ứng dụng test đóng. Không dừng Kafka/PostgreSQL hay service người dùng. Giữ unit test regression lâu dài theo quy tắc dự án.
- Lượt integration đầu trước khi cô lập topic đã publish một số event QA vào topic domain; dữ liệu QA đã xóa nhưng lịch sử Kafka có thể còn. Không xóa topic domain để tránh mất event người dùng; không coi đây là dữ liệu nghiệp vụ.
- **Phục hồi spam log 2026-10-11:** đọc Kafka xác minh 14 `OrderConfirmed` có mã `QA-*` thuộc 5 tenant test; truy vấn Order và Inventory xác nhận không còn Order/reservation của các tenant đó. Người dùng đồng ý xử lý đúng event QA: đã ghi 14 Inbox `inventory-order-confirmation` với outcome `IGNORED_QA_CLEANUP`, giữ nguyên topic và không reset offset. Handler thật replay toàn bộ 22 event hiện có qua consumer group kiểm chứng riêng: 1/1 test qua, exit 0, không lỗi handler; group/test tạm đã xóa. Consumer group Inventory chính đang `Empty` tại lúc kiểm tra, cần khởi động lại service để nó tự xử lý tiếp và commit offset bình thường; chưa tuyên bố đã quan sát tiến độ group chính. Không thêm quy tắc bỏ qua reservation thiếu vào production code. Nguyên nhân QA lọt topic còn gồm relay service người dùng quét outbox QA: chỉ đổi topic của producer test hoặc vô hiệu hóa relay trong app test là chưa đủ; lần test tiếp phải cô lập database/outbox khỏi mọi relay đang chạy.
- Chưa dùng trình duyệt: chưa nghiệm thu tương tác VI/EN, mobile/desktop, preview/error/cancel recovery bằng UI. UI hiện refetch thủ công, chưa tự polling lifecycle.
- Chưa dừng broker dùng chung để thử restart hoặc đo tải; rehearsal restart và benchmark thuộc hardening GĐ5.
- Permanent invalid Kafka event hiện giữ offset và retry/log; có thể chặn partition. DLQ/replay có kiểm soát chưa triển khai, không tuyên bố exactly-once hay tự bỏ event lỗi.
- SC-008/009/011 mới có bằng chứng phần reservation; Shipment/issue/dispatch/lifecycle vẫn thuộc GĐ5. Không gọi toàn bộ Sales Order/Shipment hoàn chỉnh.
- Công cụ test của editor không phát hiện Vitest, nên dùng lệnh test chuẩn của từng package; không bỏ qua test. Editor diagnostics phạm vi Order/Inventory/messaging/frontend orders không có lỗi. Next build còn cảnh báo convention middleware cũ; không đổi phần ngoài GĐ4.
- `git diff --check` Backend qua; Frontend toàn worktree còn whitespace ở CSS header của thay đổi trước GĐ4. Không tự sửa thay đổi ngoài phạm vi; các file orders/locale GĐ4 được kiểm tra riêng.

### 6.9. Dữ liệu mẫu lưu lâu dài trên console

Theo yêu cầu và xác nhận của người dùng, đã tạo dữ liệu cho **Công ty Ahihi**
qua các API public của Gateway, bằng quyền thực tế của OWNER hiện có. Không
đổi tài khoản, mật khẩu hay phân quyền; không ghi trực tiếp trạng thái Order,
balance/reservation hoặc giả Shipment/dispatch.

| Dữ liệu | Số lượng |
|---|---:|
| Kho | 6 |
| Sản phẩm | 40 |
| Khách hàng / địa chỉ SHIPPING | 24 / 48 |
| Phương tiện | 12 |
| Phiếu nhập POSTED / stock movements | 24 / 240 |
| Balance kho–sản phẩm | 240 |
| Order / OrderLine | 80 / 256 |
| DRAFT / CONFIRMED / PENDING_STOCK / CANCELED | 24 / 32 / 16 / 8 |
| History / shortage chưa resolved | 140 / 16 |
| ReservationGroup ACTIVE / RELEASED | 32 / 4 |

Các mã Master Data dùng prefix `DEMO-`, tên kho/sản phẩm/khách hàng ghi `[Mẫu]`;
biển số `DEMO-*`, email khách hàng dùng `example.com`. Đây là dữ liệu giả lập
nghiệp vụ được lưu thật, không phải chứng nhận về địa chỉ, phương tiện hay
doanh nghiệp ngoài đời. Order dùng mã do service sinh và key namespace
`console-demo-v1`. Sản phẩm tồn thấp cho phép thao tác shortage/retry thực tế.

Đã đọc lại qua Gateway đúng tenant: orders/products/warehouses/customers/
vehicles/balances đều HTTP 200 và đúng tổng; shortage/history có dữ liệu.
Đối chiếu SQL: không có tổng quantity/weight/volume sai, không balance âm hay
reserved lệch tổng reservation ACTIVE; 32 group ACTIVE đều acknowledged.
Outbox Order/Inventory đã publish hết tại thời điểm kiểm tra, Inventory
không có lastError. Lệnh tạo và kiểm chứng đều exit 0.

**Không dọn bộ này như QA:** dữ liệu được giữ để người dùng xem và vận hành
trên console. Script thao tác tạm đã xóa; không tạo mock UI hoặc thay code
nghiệp vụ. Shipment/lifecycle GĐ5 chưa có dữ liệu giả.

---

## 7. Giai đoạn 5 — Fulfillment/Shipment Pool, lifecycle, hardening và nghiệm thu

> **Trạng thái: GĐ5A/B/C hoàn thành code; GĐ5D đang bị chặn bởi outbox retry/transaction timeout và benchmark chưa đạt. Chưa nghiệm thu GĐ5.** UI/browser vẫn chưa nghiệm thu theo phạm vi người dùng đã chốt. Bằng chứng hiện tại ở [báo cáo GĐ5D](./runtime-validation-report.md).

### 7.0. Quyết định và thứ tự triển khai đã chốt

- Nguồn chính là kế hoạch này; cập nhật tiến độ/bằng chứng tại đây, không suy ra hoàn thành chỉ từ schema hoặc build xanh.
- Snapshot khách hàng/địa chỉ/kho copy nguyên từ `OrderConfirmed`; không đọc lại Master Data khi tạo shipment, không làm thay đổi thông tin giao hàng đã xác nhận.
- Thống nhất status GĐ5: `PENDING_PICK → PICKING → READY_TO_SHIP → DISPATCHED → DELIVERED/FAILED`; hủy chỉ trước quyết định dispatch. Cập nhật schema/architecture cũ dùng CREATED/READY/IN_TRANSIT trong cùng cụm Fulfillment.
- Bổ sung API/UI tối thiểu ghi nhận giao thành công/thất bại ở Fulfillment, quyền riêng, version, xác nhận và lý do thất bại; chưa trip/route/POD/giao lại.
- **UI dispatch phải có hộp thoại xác nhận dùng theme/component hệ thống**, hiển thị shipment/đơn và cảnh báo không thể hủy sau khi được chấp thuận. Chưa hoàn tất thì hiển thị đang xử lý, không báo thành công giả.
- Được phép benchmark 100 VU/10 phút nhưng chỉ trong môi trường kiểm thử cô lập: tenant/topic/consumer group/tiến trình QA riêng; không dừng broker dùng chung, không sửa/xóa dữ liệu demo.
- Cụm 5A: contract và cơ chế Order phân xử hủy/dispatch, migration an toàn, proof race/replay/tenant/auth; chưa mở dispatch cho người dùng.
- Cụm 5B: Fulfillment pool/lifecycle + dispatch intent/recovery, Inventory ISSUE và Order projection; theo xác nhận bổ sung, nối Gateway và seed quyền backend trong cụm này để test API thật.
- Cụm 5C: UI Shipment Pool/detail/actions, hộp thoại, VI/EN, liên kết Order, trạng thái dispatch đang xử lý cho Orders và refetch có giới hạn; Gateway/quyền backend đã chuyển sang 5B.
- Cụm 5D: E2E/replay/recovery/benchmark, đối chiếu SC-001–012, dọn QA/scripts và nghiệm thu.

#### 7.0.1. Bằng chứng cụm 5A — hoàn thành nền phân xử, chưa hoàn thành GĐ5

| Task | Kết quả | REQ/SC liên quan |
|---|---|---|
| G5-A01 | Contract `AuthorizeOrderDispatchRequest`/`OrderDispatchGrant`; migration `20261017054805_order_dispatch_arbitration` đã áp dụng bằng `migrate dev`, regenerate client, không reset DB. Unique mã thao tác theo tenant, CHECK quyết định đầy đủ/loại trừ hủy. | REQ-014, REQ-019; nền SC-009/010 |
| G5-A02 | API nội bộ `POST /internal/orders/:orderId/authorize-dispatch`, chỉ Fulfillment; tenant từ token nội bộ. READY/version/reservation phải khớp. Cấp phép và hủy khóa cùng row; recovery hủy không được release sau grant. Replay chính xác trả quyết định gốc; không chuyển IN_DELIVERY tại bước grant. Cho hủy PICKING/READY trước grant. | REQ-014, REQ-016, REQ-019 |
| G5-A03 | 43 test mới cho Order (183 → 226); tổng 324 test xanh gồm Order 226, Inventory 37, auth 31, messaging 30. Order `tsc --noEmit` (cả tests), lint, build; messaging build/typecheck đều exit 0. | Bằng chứng cục bộ, không nghiệm thu toàn bộ SC |

Runtime G5-A03: Gateway, Order và Inventory thật chạy ở cổng riêng, PostgreSQL
thật, JWT/guard thật. Seed chỉ tenant QA riêng trong Order/Inventory; không tạo
tài khoản Identity/master data hay sửa demo. **81 kiểm tra HTTP exit 0**, kèm
assert DB/tồn kho:

- 401 thiếu/sai loại token, sai internal caller, tenant claim sai định dạng; 403
  user thiếu quyền; 404 cross-tenant. Gateway không lộ endpoint nội bộ (thử cả
  `/internal`, `/api/v1/internal`, đường public Orders).
- 400 DTO/header sai; 409 version/reservation/replay content sai và request key
  dùng cho đơn khác. Replay 10 lần không tăng version lần nữa.
- Dispatch thắng: đơn vẫn READY_TO_SHIP, hủy 409, giữ nguyên `on_hand=100`,
  `reserved=10`. Cấp phép không phải xuất kho và không phải hoàn tất dispatch.
- Hủy thắng: release qua HTTP tới Inventory thật, `on_hand=100`, `reserved=0`;
  cấp phép dispatch 409.
- 20 cặp yêu cầu đồng thời có luân phiên head start: 10 hủy thắng/10 cấp phép
  dispatch thắng; mỗi cặp đúng một bên thành công, không có ISSUE.
- Dừng **chỉ Inventory kiểm thử**: cancel 503 nhưng giữ ý định hủy, dispatch bị
  chặn; khởi động lại rồi gọi đúng hàm completion mà worker dùng, release/hủy
  hoàn tất. Đây không phải phép thử lịch chạy tự động của worker.
- Restart **chỉ Order kiểm thử**: grant vẫn replay nguyên vẹn và tiếp tục chặn hủy.
- Negative proof trực tiếp DB: CHECK chặn grant thiếu trường, grant + ý định hủy,
  grant + CANCELED.

Outbox relay/consumer/reconciler bị tắt **chỉ trong test host** để không publish
event QA vào topic dùng chung; production không bị đổi cấu hình. Không dùng
bằng chứng này để tuyên bố Kafka recovery hay ISSUE đã đạt. Dữ liệu QA của cả
hai DB và mọi tiến trình test đã được dọn; script runtime tạm được xóa sau chạy.

**Còn lại tại thời điểm kết thúc 5A (xem cập nhật 5B bên dưới):** G5-B (Fulfillment/ISSUE/projection), G5-C (Gateway/quyền/UI Shipment,
hộp thoại theo theme, expose trạng thái dispatch đang xử lý cho UI Orders) và
G5-D (E2E hoàn chỉnh/replay Kafka/recovery/benchmark 100 VU/10 phút). Chưa chạy
benchmark, chưa sửa frontend và chưa nghiệm thu UI; không đánh dấu SC-001–012
hoàn tất từ cụm 5A.

#### 7.0.2. Bằng chứng cụm 5B — hoàn thành backend, chưa nghiệm thu UI/toàn GĐ5

| Task | Kết quả | REQ/SC liên quan |
|---|---|---|
| G5-B01 | Contract/schema lifecycle, snapshot dòng bổ sung tương thích event v1; API snapshot nội bộ chỉ Fulfillment; consumer tạo một shipment/đơn, copy snapshot, Inbox + cursor/tombstone chống tái tạo sau hủy. | REQ-014, REQ-016, REQ-019; SC-009/010 |
| G5-B02 | List/detail/filter, picking/ready, dispatch preview và lệnh xác nhận; ghi nhận delivered/failed có version/quyền riêng/lý do. Persist intent trước HTTP; revalidate Order READY/version thật, không nhận version tương lai đoán từ client; replay request gốc, recovery tự động sau restart và backoff lưu DB. | REQ-014, REQ-015, REQ-016, REQ-019; SC-010/011 |
| G5-B03 | Inventory ISSUE giữ cùng advisory lock với reserve/release, giảm reserved và gọi primitive on-hand trong một transaction; receipt unique tenant/shipment + movement từng product, `StockIssued`. Order projection/history/Inbox/version, completedAt, bỏ qua stale/invalid transition, không mở giao lại. | REQ-014, REQ-015, REQ-019; SC-009/010/011 |
| G5-B04 | Gateway chỉ proxy public Shipments; 4 quyền catalogue được upsert riêng, không chạy seed tài khoản/không gán custom role. Build/source typecheck/lint và runtime qua Gateway + PostgreSQL/Kafka thật. | REQ-016, REQ-019; nền SC-009/010/011 |

- **435 test nguồn khác nhau pass, 0 fail/skip:** Fulfillment 94, Order 244,
  Inventory 48, shared auth 31, shared messaging 16, Gateway 1 và catalogue
  Identity 1. Messaging được chạy với selector `src` để không đếm trùng test
  JavaScript đã emit vào `dist`; số lịch sử 5A giữ nguyên theo command lúc đó.
- Bốn service Fulfillment/Order/Inventory/Gateway build, source typecheck và
  lint exit 0. Order/Inventory typecheck gồm test exit 0. Full typecheck của
  Fulfillment/Gateway còn import scaffold có sẵn `supertest/types` trong
  `test/app.e2e-spec.ts`; không sửa ngoài phạm vi, không tuyên bố full tsc xanh.
- Bốn migration 5B đã áp dụng bằng `migrate dev`, regenerate clients, không
  reset DB. Pool local trước migration trống; migration chủ động từ chối dữ
  liệu shipment legacy chưa backfill thay vì bịa snapshot/đổi status âm thầm.
- Runtime cuối **73 kiểm tra HTTP exit 0**, 3 file hành trình tạm, database QA
  riêng cho từng service, topic/group/port/PID riêng. Không dùng database demo
  để chạy các hành trình.
- Kiểm tra confirm → pool → picking → ready → dispatch → ISSUE →
  delivered/failed và projection; hủy trước grant release đúng, sau grant 409;
  version/request-ID conflict, 400/401/403/404, cookie/Bearer/refresh token,
  tenant isolation, internal caller và Gateway không lộ internal snapshot.
- Cố ý mất phản hồi sau khi Order đã grant: intent vẫn PENDING, Order vẫn
  READY và chặn hủy; restart riêng Fulfillment, worker tự hoàn tất đúng request,
  đúng một `ShipmentDispatched` và đúng một ISSUE cho mỗi product.
- Trigger lỗi **chỉ DB QA** tại movement product thứ hai: transaction rollback
  toàn bộ (cả hai balances giữ `on_hand=100,reserved=10`, group ACTIVE, 0 ISSUE
  movement). Bỏ trigger, Kafka tự retry → cả hai `90/0`, đúng 2 movements.
- Replay dispatch với event ID mới không trừ kho lại/không lùi Order; lịch sử
  OrderConfirmed thiếu toàn bộ snapshot dòng lấy qua HTTP nội bộ rồi tạo pool,
  không đổi stock; cancellation đến trước confirmation không tái tạo shipment.
- QA hosts/topics/groups/databases đã dọn, kể cả residue của lần khởi động gặp
  cổng Windows bị từ chối. Script runtime tạm được xóa sau verification;
  regression tests lâu dài được giữ. Không commit.

**Giới hạn:** bằng chứng backend của 5B không thay nghiệm thu 5C/5D. Chưa chạy
UI/browser, benchmark 100 VU/10 phút hoặc dừng broker. Permanent malformed event
vẫn retry/block partition theo baseline, chưa có DLQ tự động. Không tuyên bố đã
backfill dữ liệu demo thật; consumer production sẽ đọc lịch sử khi được cấu
hình/khởi động. Trước khi chạy local cần đồng bộ `KAFKA_FULFILLMENT_TOPIC` cho
ba service, cấu hình đầy đủ Fulfillment theo `.env.example` (hai secret dùng
giá trị hiện có tương ứng của Identity/Order), và `FULFILLMENT_SERVICE_URL`
ở Gateway; không có fallback bí mật/URL. **Cập nhật 5C:** cấu hình env local này
đã được đồng bộ và kiểm tra schema (xem §7.4); nhận xét chưa cấu hình ở trên là
trạng thái lịch sử khi kết thúc batch 5B.

### 7.1. Mục tiêu

**G5-B đã hoàn thành backend (đã duyệt):** quyền `fulfillment:shipment:read|update|dispatch|complete`;
backend Gateway/seed được nối trong 5B để kiểm thử thật, UI ở 5C. Consumer được
đọc lịch sử để tạo shipment cho đơn đã confirm, kể cả demo; tạo shipment không
đổi tồn kho. Event mới bổ sung snapshot dòng; event cũ lấy snapshot dòng bất biến
qua API nội bộ Order có guard, không đọc Master Data/DB xuyên service.

Đơn đã xác nhận đi tiếp: tạo shipment, chuẩn bị hàng, sẵn sàng giao, dispatch. Trạng thái đơn chỉ đổi theo event của service sở hữu. Không hủy được sau dispatch. Đo và nghiệm thu toàn bộ SC.

### 7.2. Fulfillment-service

1. Schema theo `docs/architecture/database-design.md` (khoảng dòng 734 trở đi): `Shipment` (1 shipment/đơn theo AGENTS.md), snapshot người nhận/kho chụp **tại lúc tạo shipment**, status `PENDING_PICK → PICKING → READY_TO_SHIP → DISPATCHED → DELIVERED/FAILED/CANCELED`, version, Outbox/Inbox. Migration bằng `migrate dev`.
2. Consumer `OrderConfirmed` (idempotent theo `orderId + orderVersion`, ghi inbox): tạo shipment vào **Shipment Pool**.
3. API (qua Gateway `/api/v1/shipments`, thêm proxy với `FULFILLMENT_SERVICE_URL` bắt buộc):
   - list pool (lọc theo kho/status/ngày), detail;
   - `start-picking`, `mark-ready`, có version.
   - Quyền catalogue đã chốt/seed: `fulfillment:shipment:read|update|dispatch|complete`; không tự gán custom role.
   - `dispatch-preview`, `dispatch` có requestId/version/orderVersion/confirmed; `mark-delivered`, `mark-failed` có version/confirmed, thất bại bắt buộc lý do.
4. Phát event `ShipmentPicking`, `ShipmentReadyToShip`. Consumer `OrderCanceled`: hủy shipment nếu chưa dispatch; nếu đã dispatch thì phát `ShipmentCancelRejected`.
5. **Dispatch** (`DISPATCHED`): phát `ShipmentDispatched`. Inventory consume để **ISSUE** reservation: giảm `on_hand` và `reserved` đúng một lần, ghi `StockMovement` (idempotency key `shipment:{id}:issue`). Phần trip/route của Transport **ngoài phạm vi**; dispatch ở đây là command tối thiểu trên shipment.

### 7.3. Order — projection lifecycle

- Consumer: `ShipmentPicking` → PICKING, `ShipmentReadyToShip` → READY_TO_SHIP, `ShipmentDispatched` → IN_DELIVERY, `ShipmentDelivered` → COMPLETED, `ShipmentDeliveryFailed` → DELIVERY_FAILED.
- **Chống lùi trạng thái:** chỉ áp dụng chuyển tiếp hợp lệ theo state machine. Event tới sai thứ tự hoặc đã cũ thì ghi inbox `IGNORED_STALE` và không đổi trạng thái.
- Cancel: chặn khi `status ∈ {IN_DELIVERY, DELIVERY_FAILED, COMPLETED}` (REQ-014, QĐ-5). Race với dispatch được xử lý bằng version.
- Không có API nào cho người dùng tự đặt PICKING/READY/IN_DELIVERY/COMPLETED (REQ-015).

### 7.4. Frontend

**GĐ5C hoàn thành code và kiểm tra không-browser (2026-10-17)** — nguồn chính là mục này,
không mở rộng Trip/Route/POD; không thay thế nghiệm thu lifecycle/visual trong 5D:

| Task | Phạm vi | REQ | Trạng thái |
|---|---|---|---|
| G5-C01 | Đồng bộ env local (ignored), Gateway/topic/secret nội bộ; schema/API Shipment, route guard/sidebar | REQ-019, REQ-020 | Hoàn thành code/config |
| G5-C02 | Pool, lọc kho/status/ngày, phân trang; detail snapshot/items/history | REQ-015, REQ-020 | Hoàn thành code/contract |
| G5-C03 | Action theo quyền; preview + hộp thoại theo theme; stable dispatch request, pending/recovery, delivered/failed | REQ-015, REQ-019, REQ-020 | Hoàn thành code/logic |
| G5-C04 | Order liên kết shipment thật; grant-aware cancel, bounded refetch; VI/EN, responsive/light/dark; test và dọn QA | REQ-015, REQ-019, REQ-020 | Hoàn thành code; chưa nghiệm thu visual |

Kiểm thử GĐ5C: Order unit regression; lint/typecheck/build frontend; assertion schema/helper/API
cho picking → ready → dispatch → delivered, nhánh failed/cancel, phân quyền, stale version.
**Người dùng đã yêu cầu không kiểm tra browser, chỉ tiếp tục sửa code** trong batch này;
không kết luận đã nghiệm thu browser/visual/runtime lifecycle. Bằng chứng API/PostgreSQL/Kafka
GĐ5B được giữ nguyên, không chạy lại hoặc sửa dữ liệu demo chỉ để kiểm tra UI.
Frontend chưa có runner unit: dùng script assertion tạm cho pure helper/schema, không thêm
test dependency chỉ để chạy một batch. Xóa các script/QA resource sau kiểm thử, giữ regression
test sẵn trong runner backend. Chu kỳ refetch đặt ở config: 5 giây, tối đa 12 lượt/nguồn dữ liệu;
tab ẩn không gửi polling, focus/manual refresh vẫn hoạt động.

**Bằng chứng 5C:**
- `pnpm validate` frontend: lint, typecheck và production build đạt; hai route Shipment
  được build. Chỉ còn cảnh báo `middleware` deprecated đã có trước batch.
- `pnpm test` Order: **245/245 test**, 15 file; build, tsc gồm test và lint đạt.
  Regression mới kiểm tra public view vẫn có grant khi Order còn READY_TO_SHIP.
- **16/16 kiểm tra assertion tạm**: 336 tổ hợp Shipment status/quyền/intent;
  ma trận Order cancel/edit/confirm trước/sau grant; schema/decimal/version;
  mapping list/detail/preview/5 command; malformed response fail closed; lỗi
  400/401/403/404/409/network; chính xác 12 poll, pause tab ẩn và cleanup.
  Kiểm tra handler hộp thoại bằng harness không-DOM: retry/đóng-mở giữ nguyên
  request, chống submit kép, trim reason và conflict/mismatched preview.
- Chỉ cập nhật `.env` local đã git-ignore; giữ nguyên DATABASE_URL, không in
  secret và không đổi catalogue/gán role. Fulfillment dùng JWT hiện có từ
  Identity, internal secret hiện có từ Order; Order/Inventory/Fulfillment dùng
  chung topic, Gateway có Fulfillment URL. Schema cấu hình 4 service đạt,
  JWT Identity/Order/Inventory/Fulfillment nhất quán. Cần restart service để nhận env.
- Không cài dependency/test framework mới, không tạo tài khoản/dữ liệu QA, không
  backfill demo hoặc dừng Kafka; script assertion tạm được xóa, regression backend giữ.
- Public Order summary/detail + frontend Zod cùng thêm `dispatchGrantedAt` và
  `dispatchShipmentId`. Hủy hợp lệ trước grant ở PICKING/READY_TO_SHIP; sau grant
  luôn ẩn thao tác hủy, không chờ status projection.

**Còn lại GĐ5D:** nghiệm thu browser/visual và luồng thật FE→Gateway→Kafka/Inventory,
replay/recovery toàn hệ thống, đối chiếu SC-001–012, benchmark cô lập 100 VU/10 phút.
Không tuyên bố các mục này đã pass trong batch code-only 5C.

**Sửa lỗi vận hành/layout/locales sau 5D (2026-10-17):**
- Đọc hết snapshot high-water của topic Order và đối chiếu nguồn: 14 event `QA-*`
  có snapshot header sai, Order/reservation/shipment nguồn đã không còn; Inventory
  đã đánh dấu chính các event này `IGNORED_QA_CLEANUP` từ đợt dọn QA trước.
  Ghi đúng 14 Inbox tombstone tương ứng ở Fulfillment, không xóa topic, reset
  offset, xóa dữ liệu demo hoặc nới schema cho event nghiệp vụ.
- 36 event demo dùng contract cũ chỉ thiếu snapshot dòng hàng được xử lý qua
  legacy compatibility có sẵn, không bị bỏ qua: tạo 36 Shipment (32 PENDING_PICK,
  4 CANCELED). Consumer Fulfillment bắt kịp cả 6 partition, lag = 0; 40 outbox
  đã publish, không còn pending tại thời điểm kiểm tra.
- Phát hiện local chưa provision topic Fulfillment trong khi broker tắt auto-create.
  Đã provision topic với cấu hình 6 partition/replication 1; sửa
  `scripts/setup-kafka.mjs`, env example và hướng dẫn để setup đủ ba domain.
  Chỉ bổ sung cấu hình topic trong env local ignored, không đổi secret.
- Route Shipment có layout riêng với padding; filter/card dựa theo container
  width thực tế khi sidebar/Copilot mở; bảng cuộn ngang và dialog cuộn theo
  chiều cao viewport. Không đổi quyền, trạng thái, polling hoặc dispatch request ID.
- Đồng bộ VI/EN ở cả hai nơi chứa dictionary cho Order/Shipment/picker: placeholder,
  loading/empty/error/retry, dialog close và xác nhận hành động; bổ sung ba lỗi
  dispatch của Order, dịch status trong lỗi transition, không đưa nguyên thông báo
  tiếng Việt của backend vào UI tiếng Anh. Picker không còn giả lỗi tải thành
  kết quả rỗng hoặc im lặng che lỗi.
- Bằng chứng: Fulfillment **96/96 test**, gồm hai regression mới cho Inbox QA
  và giữ strict validation; **924 assertions** locale/error mapper trên 39 source
  files; **10 Gateway probes** Order/Shipment (200/400/401/403/404, tenant QA rỗng,
  không tạo dữ liệu/cấp quyền tài khoản thật); bốn ca setup Kafka đạt; lint,
  typecheck và production build frontend đạt. CSS build có đủ năm container
  breakpoint. Route types cũ được tái sinh bằng `next typegen`.
- Hai host Order/Inventory khởi động tạm để kiểm chứng được dừng sau kiểm thử;
  cần restart backend dev đang chạy nếu hai service đã thoát lúc thiếu topic.
  Script chẩn đoán/repair/assertion tạm được xóa, giữ regression backend.
  Không dùng browser, chưa nghiệm thu visual; không thay kết luận blocked của
  G5-D02/G5-D03 hay tuyên bố các lỗi outage dài/benchmark đã được sửa.

**Sửa tiếp dropdown địa chỉ và bốn card Order detail (2026-10-17):**
- Dropdown địa chỉ dùng Popover/Command không modal, không khóa body scroll như
  Select; giữ trigger một dòng, menu theo độ rộng trigger và chiều cao viewport,
  hỗ trợ tìm theo nhãn/địa chỉ, ngắt dòng dài. Không đổi primitive Select dùng chung.
  Chỉ ACTIVE SHIPPING được chọn; địa chỉ cũ không hợp lệ vẫn disabled. Đổi khách
  hàng đóng menu cũ; nút mở không submit form. Bổ sung copy tìm kiếm VI/EN.
- Bốn card dùng hai cột từ container 40rem, một cột khi hẹp, không dựa trên viewport
  vốn còn chứa sidebar/Copilot. Dispatch notice nằm ngoài lưới; snapshot dài được
  wrap mà không ép card rộng hơn container. Không thay snapshot hoặc lifecycle.
- Frontend lint/typecheck/build đạt; 34 kiểm tra source behavior/cấu trúc đạt;
  production CSS có breakpoint và ràng buộc kích thước menu. Không tạo file test
  tạm, không dùng browser; visual và blocker GĐ5D vẫn chưa nghiệm thu.

**Rà soát tên/mã nghiệp vụ thay UUID và Actor (2026-10-17):**
- Shipment Pool đã hoàn thành chức năng BE/FE của GĐ5A–5C; chưa được gọi là hoàn
  tất nghiệm thu vì G5-D02/G5-D03 vẫn blocked và UI chưa nghiệm thu visual.
- Người dùng chốt **current-directory**: lịch sử Shipment/Order/biến động kho hiện
  tên + email hiện tại của người thực hiện. Lấy chính mình từ Auth, người khác từ
  API thành viên tổ chức của Identity theo `userId`, không nhầm ID membership.
  Một request directory cho cả lịch sử, không gọi mỗi dòng hoặc mỗi nhịp polling.
  Không thêm snapshot danh tính, không backfill tên lịch sử.
- Actor null hiện “Hệ thống”; actor không còn trong directory hiện thông tin người
  dùng không khả dụng, không giả thành hệ thống. Lỗi tải/thiếu quyền có thông báo
  VI/EN và retry rõ ràng; đổi tenant/session không hiển thị lại dữ liệu người cũ.
- Preview xác nhận/thiếu hàng dùng tên + SKU trong Order snapshot bất biến. Tồn
  kho dùng tên + mã kho/sản phẩm; không fallback UUID rút gọn. Metadata được
  dedupe theo ID/phạm vi đăng nhập, lỗi không tạo vòng lặp retry tự động.
- Tham chiếu lịch sử kho dùng số phiếu nhập/số Shipment; điều chỉnh thủ công có
  nhãn riêng và actor. Inventory bổ sung `referenceNumber` từ bảng phiếu nhập
  thuộc chính service, luôn lọc tenant; Shipment tra qua API theo quyền đọc.
  Schema frontend nhận `SHIPMENT` đúng với contract backend đã có.
- Giữ ID kỹ thuật trong payload/route/key và mục “Chi tiết kỹ thuật” mở rộng,
  không đổi ID trong database. Không sửa role, seed, migration hoặc dữ liệu demo.
- Bằng chứng: **53/53 test Inventory**, gồm năm regression receipt lookup có
  negative proof trước sửa; build/tsc/lint backend đạt; **59 kiểm tra hành vi**
  source frontend (directory, đổi tenant, abort, quyền, lỗi/retry, nhãn và locale
  VI/EN); lint/typecheck/production build frontend đạt. **8 API probes thật**
  qua Gateway đạt: 200/401/403, đối chiếu đủ 100 dòng biến động với số phiếu gốc,
  directory active đúng tenant và hai actor lịch sử Shipment tra được hồ sơ.
  Không ghi token/email/tên vào evidence; không dùng browser; script QA tạm được
  xóa, giữ regression backend. Các blocker GĐ5D không thay đổi.

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

**GĐ5D đã kiểm thử 2026-10-17; FAIL, chưa nghiệm thu.** Người dùng xác nhận tiếp tục không
dùng browser: chỉ API/integration/hiệu năng, ghi rõ UI chưa nghiệm thu.
Tài nguyên QA: database riêng theo role sở hữu của từng service, broker Kafka
riêng (không dừng broker dùng chung), topic/group/port riêng; không thay env/demo.

| Task | Phạm vi | Trạng thái |
|---|---|---|
| G5-D01 | Regression baseline + API lifecycle/draft/tenant/permission/transaction; sửa logger lộ token nội bộ | Hoàn thành phạm vi functional: 449 unit, 72 runtime assertions; exit 0 |
| G5-D02 | Cancel-dispatch race, toàn event replay, consumer/broker recovery cô lập | Bị chặn: race/replay/outage ngắn đạt; persisted retry khi outage dài chưa đạt, suite exit 1 |
| G5-D03 | Benchmark 100 VU/600 giây, p95 API và publish→business effect | Đã đo hai lượt đủ 600 giây, chưa đạt: 500/latency và broker coordinator lỗi |
| G5-D04 | Đối chiếu SC-001–012, báo cáo bằng chứng, dọn script/tài nguyên QA | Hoàn thành báo cáo/cleanup; không đồng nghĩa nghiệm thu GĐ5D |

Chi tiết, command/exit code, ma trận SC và giới hạn đo:
[runtime-validation-report.md](./runtime-validation-report.md).
Lượt tải độc lập có 44.465 requests/600,97 giây, 69 non-2xx, p95 gộp 2.837,45 ms,
p95 create 3.976,31 ms; 100 connections/VU, pipelining 1, cap 100 request/giây.
Consumer quan sát gặp lỗi histogram âm trong Kafka 4.1.1 nên không dùng p95
event đo trên mẫu thiếu để tuyên bố đạt. Chưa đo lại tải sau sửa logger.

Đã sửa shared logger che `x-internal-service-token`; regression dev/prod trước
sửa fail đúng lỗi, sau sửa 3/3 pass. Functional chạy lại sau rebuild logger:
72 assertions, exit 0; năm log service không còn JWT thô/marker PII QA.
Không có thay đổi counter/transaction tạo đơn QĐ-7 hoặc auth protocol.
Outbox vẫn durable nhưng Kafka retry vượt transaction timeout khiến mark
published/failed có thể rollback; ca persisted backoff trong outage dài chưa
đạt. SC-011/012 tiếp tục bị chặn; không có waiver cho các lỗi này.

Stack kiểm thử: Node/Nest application thật qua Gateway, PostgreSQL/Kafka thật;
script runtime tạm chia thành lifecycle, race/replay/recovery, benchmark (setup →
action → persistence verification → cleanup). Dữ liệu seed có UUID riêng, không
phụ thuộc dữ liệu demo; JWT QA ký bằng secret chỉ nằm trong process QA, claim
quyền rõ ràng, không seed Identity hoặc cấp quyền tài khoản thật. Master Data
chạy service thật và DB riêng; không mock API liên service.
Không fallback DB/broker giả: nếu hạ tầng không chạy thì ghi blocker, không PASS.
Browser tier bị loại theo quyết định người dùng (không phải lỗi tooling).
SC-012 đo p95 API ≤2 giây, publish→effect ≤3 giây; báo cáo cả lỗi/request count,
workload và cấu hình, không thay threshold hoặc tắt consumer để làm đẹp kết quả.

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
