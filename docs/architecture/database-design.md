# Thiết kế cơ sở dữ liệu theo service

## 1. Mục đích và trạng thái

Tài liệu này là artifact thiết kế dữ liệu chi tiết cho kiến trúc microservice của
LogiX. Thiết kế bám theo BRD, đề cương đồ án và các boundary đã được mô tả trong:

- `docs/architecture/service-boundaries.md`;
- `docs/architecture/data-ownership.md`;
- `docs/architecture/event-architecture.md`;
- `docs/patterns/encoding-invariants.md`.

**Trạng thái:** baseline đề xuất để triển khai MVP. Những lựa chọn vật lý có ảnh
hưởng lớn như tách PostgreSQL cluster, bật Row-Level Security, phân vùng bảng,
thời hạn lưu audit và UUIDv7 cần được xác nhận bằng ADR trước khi trở thành chính
sách kiến trúc bắt buộc.

Mục tiêu của thiết kế:

1. Mỗi dữ liệu nghiệp vụ có đúng một service sở hữu.
2. Không truy vấn hoặc tạo foreign key xuyên database/service.
3. Mọi dữ liệu tenant được cách ly và truy vấn theo `tenant_id`.
4. Các invariant quan trọng được bảo vệ đồng thời ở application và database.
5. Command/event lặp lại không tạo tác động nghiệp vụ kép.
6. Index xuất phát từ access pattern trong BRD, không tạo index theo cảm tính.
7. Forecast, route optimizer và Agent không thay thế nguồn sự thật nghiệp vụ.

## 2. Kiến trúc lưu trữ tổng thể

### 2.1 PostgreSQL

Khuyến nghị MVP dùng một PostgreSQL cluster để giảm chi phí vận hành, nhưng mỗi
service có database và database role riêng:

| Service | Database đề xuất | Schema | Quyền sở hữu |
|---|---|---|---|
| `api-gateway` | Không có database nghiệp vụ | Không áp dụng | Không sở hữu business state |
| `identity-service` | `logix_identity` | `identity` | Tenant, user, role, session |
| `master-data-service` | `logix_master_data` | `master_data` | Customer, product, warehouse, vehicle, driver |
| `order-service` | `logix_order` | `orders` | SalesOrder, OrderLine, lịch sử trạng thái |
| `inventory-service` | `logix_inventory` | `inventory` | Balance, reservation, movement |
| `fulfillment-service` | `logix_fulfillment` | `fulfillment` | Shipment và vòng đời shipment |
| `transport-service` | `logix_transport` | `transport` | Trip, stop, route plan, delivery attempt |
| `notification-service` | `logix_notification` | `notification` | Notification, recipient, delivery/read state |
| `audit-service` | `logix_audit` | `audit` | Audit log bất biến |
| `agent-service` | `logix_agent` | `agent` | Conversation, execution, tool call, confirmation |
| `forecast-service` | `logix_forecast` | `forecast` | Forecast run/result/metric/model metadata |
| `route-optimizer-service` | `logix_route_optimizer` (tùy chọn) | `route_optimizer` | Optimization run/result metadata |

Mỗi role chỉ được kết nối database của chính service. Không cấp quyền như:

```text
agent_role          -> logix_order
forecast_role       -> logix_order
transport_role      -> logix_inventory
route_optimizer_role -> logix_transport
```

Không dùng foreign key xuyên database. Ví dụ `orders.customer_id` là định danh
tham chiếu tới Master Data, nhưng không phải foreign key vật lý. Service có thể
lưu snapshot tối thiểu khi cần giữ lịch sử nghiệp vụ.

### 2.2 Redis

Redis là hạ tầng hỗ trợ, không phải nguồn sự thật cho order, inventory, shipment,
trip, audit hoặc forecast:

| Service | Mục đích hợp lệ |
|---|---|
| API Gateway | Rate limit, cache discovery/config ngắn hạn |
| Identity | Session/revocation cache có TTL |
| Transport | Distributed lock ngắn hạn nếu có nhiều instance |
| Agent | Execution state ngắn hạn, timeout/cancel signal |
| Route Optimizer | Cache distance matrix theo input hash |
| Notification | Fan-out hoặc unread counter có thể tái tạo |

Mọi key phải có namespace, tenant khi phù hợp và TTL, ví dụ:
`logix:agent:{tenant_id}:execution:{execution_id}`.

### 2.3 Object storage

MinIO/S3 có thể lưu model artifact, dataset snapshot, report lớn hoặc audit payload
lớn. PostgreSQL giữ URI, checksum, content type, kích thước và metadata. Không lưu
token, API key hoặc dữ liệu nhạy cảm chưa lọc trong object storage.

## 3. Quy ước dữ liệu dùng chung

### 3.1 Kiểu dữ liệu

| Dữ liệu | Kiểu PostgreSQL | Quy tắc |
|---|---|---|
| ID | `uuid` | Sinh ở application; UUIDv7 được khuyến nghị nếu có ADR |
| Tenant ID | `uuid NOT NULL` | Bắt buộc với mọi business row thuộc tenant |
| Timestamp | `timestamptz` | Lưu UTC, hiển thị theo timezone người dùng |
| Số lượng | `numeric(18,3)` | Không dùng floating point cho tồn kho |
| Khối lượng | `numeric(18,3)` | Đơn vị cơ sở thống nhất trong master data |
| Thể tích | `numeric(18,6)` | Đơn vị cơ sở thống nhất |
| Tiền tệ | `numeric(18,2)` + `char(3)` | ISO 4217; một currency cấu hình/tenant trong MVP |
| Phiên bản | `bigint` | Tăng đơn điệu để optimistic concurrency |
| Trạng thái | `varchar` + `CHECK` hoặc enum | Migration phải xử lý khi thêm trạng thái |
| Payload linh hoạt | `jsonb` | Chỉ dùng cho metadata/event/snapshot có schema |
| Hash | `varchar(64)` | SHA-256 ở dạng hex khi cần tái lập/deduplicate |

### 3.2 Cột nền

Business table thuộc tenant và có vòng đời cập nhật nên có tối thiểu:

```sql
id uuid PRIMARY KEY,
tenant_id uuid NOT NULL,
created_at timestamptz NOT NULL DEFAULT now(),
updated_at timestamptz NOT NULL DEFAULT now(),
version bigint NOT NULL DEFAULT 1,
deleted_at timestamptz NULL
```

`created_by`/`updated_by` chỉ thêm khi service cần nguồn actor trực tiếp. Audit đầy
đủ thuộc `audit-service`. Không tự động coi `updated_at` là bằng chứng audit.

`deleted_at` biểu diễn **xóa mềm**, khác với `disabled_at`/`disabled_reason`:

- disable là trạng thái nghiệp vụ có thể phục hồi; bản ghi vẫn tồn tại và vẫn có
  thể xuất hiện trong màn hình quản trị;
- soft delete đặt `deleted_at`, loại bản ghi khỏi truy vấn nghiệp vụ thông thường
  và giữ bản ghi trong cửa sổ retention trước khi role vận hành được phép purge;
- thao tác soft delete là một update có kiểm soát, phải tăng `version`, cập nhật
  `updated_at` và tạo audit tương ứng;
- repository thông thường luôn lọc `deleted_at IS NULL`; truy vấn phục hồi/quản trị
  muốn đọc bản ghi đã xóa phải dùng API và quyền riêng;
- thêm `deleted_at` không tự động cho phép tái sử dụng mã nghiệp vụ. Các unique
  hiện tại vẫn giữ mã của bản ghi đã xóa; nếu muốn tái sử dụng mã cần một quyết
  định sản phẩm riêng trước khi đổi unique index thành partial index.

Các bảng append-only không dùng vòng đời soft delete ở business path và không kế
thừa đầy đủ bộ cột mutable ở trên. Các bảng append-only của thiết kế hiện tại gồm:

- `stock_movements`;
- `order_status_history`;
- `shipment_status_history`;
- `delivery_attempts` sau khi attempt đã được ghi nhận;
- `audit_logs`.

Business role chỉ được `INSERT`/`SELECT` các bảng append-only, không được
`UPDATE`, `DELETE` hoặc gán `deleted_at`. Việc loại bỏ dữ liệu, nếu có, chỉ do
retention/archive job với role vận hành riêng thực hiện. `outbox_events` không
được xếp là strict append-only vì publisher còn cập nhật trạng thái publish/retry;
`inbox_events` cũng tuân theo lifecycle xử lý và retention riêng.

### 3.3 Quy tắc index multi-tenant

1. `tenant_id` đứng đầu composite index cho truy vấn nghiệp vụ trong tenant.
2. Unique nghiệp vụ phải có `tenant_id`, ví dụ `UNIQUE (tenant_id, sku)`.
3. Không tạo index đơn `tenant_id` nếu composite index hiện có đã phục vụ truy vấn.
4. Index phải phù hợp `WHERE` và `ORDER BY`; cột có cardinality thấp như `status`
   thường không nên đứng một mình.
5. Dùng partial index cho hàng đang hoạt động/chưa xử lý để giảm kích thước.
6. Dùng `INCLUDE` cho truy vấn đọc thường xuyên chỉ sau khi có bằng chứng query plan.
7. Mọi index mới cần được kiểm chứng bằng `EXPLAIN (ANALYZE, BUFFERS)` trên dataset
   benchmark, vì index làm tăng chi phí ghi và dung lượng.

### 3.4 Tenant isolation

Mỗi repository method nhận tenant context bắt buộc và câu query luôn có điều kiện
`tenant_id = :tenant_id`. ID đơn lẻ không đủ để truy xuất business row:

```sql
SELECT ...
FROM sales_orders
WHERE tenant_id = :tenant_id
  AND id = :order_id
  AND deleted_at IS NULL;
```

Điều kiện `deleted_at IS NULL` không áp dụng cho bảng append-only không có cột
`deleted_at`, hoặc cho API quản trị/phục hồi đã được phân quyền rõ ràng.

Khuyến nghị defense-in-depth bằng PostgreSQL Row-Level Security sau khi có ADR và
integration test chứng minh connection pool luôn thiết lập đúng tenant context.
RLS không thay thế kiểm tra RBAC ở application.

### 3.5 Outbox, inbox và idempotency

Service phát event quan trọng dùng `outbox_events` trong cùng transaction với thay
đổi authoritative state. Consumer dùng `inbox_events` hoặc bảng business
idempotency trong cùng transaction với business effect.

Mẫu `outbox_events`:

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | `uuid PK` | `event_id` |
| `tenant_id` | `uuid NOT NULL` | Tenant của event |
| `event_type` | `varchar(100)` | Tên event |
| `event_version` | `integer` | Phiên bản schema |
| `aggregate_type` | `varchar(100)` | Loại aggregate |
| `aggregate_id` | `uuid` | ID aggregate |
| `aggregate_version` | `bigint` | Chống event cũ |
| `correlation_id` | `uuid` | Truy vết luồng |
| `causation_id` | `uuid` | Nguyên nhân trực tiếp |
| `payload` | `jsonb` | Payload đã version hóa |
| `occurred_at` | `timestamptz` | Thời điểm nghiệp vụ |
| `published_at` | `timestamptz NULL` | NULL khi chưa publish |
| `attempt_count` | `integer` | Số lần publish |
| `next_attempt_at` | `timestamptz` | Retry có backoff |
| `last_error` | `text NULL` | Không chứa secret |

Index chuẩn:

```sql
CREATE INDEX ix_outbox_pending
ON outbox_events (next_attempt_at, occurred_at)
WHERE published_at IS NULL;

CREATE INDEX ix_outbox_aggregate
ON outbox_events (tenant_id, aggregate_type, aggregate_id, aggregate_version);
```

Mẫu `inbox_events`:

```sql
event_id uuid PRIMARY KEY,
tenant_id uuid NOT NULL,
consumer_name varchar(100) NOT NULL,
event_type varchar(100) NOT NULL,
aggregate_id uuid,
aggregate_version bigint,
processed_at timestamptz NOT NULL,
outcome varchar(30) NOT NULL,
error_code varchar(100)
```

Nếu nhiều logical consumer dùng chung database, khóa unique là
`UNIQUE (consumer_name, event_id)`. Inbox cần retention job sau thời gian an toàn;
không xóa trước cửa sổ replay/dedup đã công bố.

## 4. `api-gateway`

### 4.1 Quyền sở hữu

API Gateway không có database nghiệp vụ và không lưu bản sao authoritative của
tenant, user, order hoặc inventory. Nó xác thực request boundary, routing, rate
limit và truyền tenant/user/correlation context đã kiểm chứng.

### 4.2 Dữ liệu tạm

- Rate limit: Redis với TTL.
- Cache public key/JWKS hoặc service discovery: cache có TTL và fallback rõ ràng.
- Không lưu access token thô, request body nhạy cảm hoặc business state lâu dài.

Nếu cần idempotency HTTP ở gateway, gateway chỉ giữ response cache ngắn hạn; khóa
idempotency nghiệp vụ cuối cùng vẫn phải được owning service kiểm tra.

## 5. `identity-service` - `logix_identity`

### 5.1 Bảng `tenants`

| Cột | Kiểu | Ràng buộc/ý nghĩa |
|---|---|---|
| `id` | `uuid PK` | Tenant authority |
| `code` | `varchar(50)` | `UNIQUE`, mã nền tảng |
| `name` | `varchar(200)` | Bắt buộc |
| `status` | `varchar(20)` | `ACTIVE`, `SUSPENDED`, `DISABLED` |
| `default_currency` | `char(3)` | Currency dùng trong MVP |
| `timezone` | `varchar(50)` | IANA timezone |
| `settings` | `jsonb` | Cấu hình đã schema hóa |
| `created_at`, `updated_at` | `timestamptz` | Timestamp |
| `version` | `bigint` | Optimistic lock |

Index:

```sql
CREATE UNIQUE INDEX ux_tenants_code ON tenants (lower(code));
CREATE INDEX ix_tenants_status_created ON tenants (status, created_at DESC);
```

### 5.2 Bảng `users`

| Cột | Kiểu | Ràng buộc/ý nghĩa |
|---|---|---|
| `id`, `tenant_id` | `uuid` | PK và tenant scope |
| `email` | `varchar(320)` | Chuẩn hóa lowercase |
| `password_hash` | `text` | Chỉ hash mạnh, không lưu password |
| `display_name` | `varchar(200)` | Tên hiển thị |
| `status` | `varchar(20)` | `ACTIVE`, `LOCKED`, `DISABLED` |
| `token_version` | `bigint` | Thu hồi token/session hiện tại |
| `last_login_at` | `timestamptz NULL` | Theo dõi đăng nhập |
| `created_at`, `updated_at`, `version` |  | Cột nền |

Ràng buộc và index:

```sql
CREATE UNIQUE INDEX ux_users_tenant_email
ON users (tenant_id, lower(email));

CREATE INDEX ix_users_tenant_status
ON users (tenant_id, status, created_at DESC);

CREATE INDEX ix_users_active_email
ON users (tenant_id, lower(email))
WHERE status = 'ACTIVE';
```

### 5.3 RBAC

`roles(id, tenant_id, code, name, description, is_system, created_at, updated_at)`

`permissions(id, code, description)` là catalogue toàn nền tảng; quyền không chứa
business state của tenant.

`role_permissions(role_id, permission_id, granted_at, granted_by)`

`user_roles(tenant_id, user_id, role_id, granted_at, granted_by)`

Ràng buộc/index:

```sql
CREATE UNIQUE INDEX ux_roles_tenant_code ON roles (tenant_id, code);
CREATE UNIQUE INDEX ux_permissions_code ON permissions (code);
CREATE UNIQUE INDEX ux_role_permissions ON role_permissions (role_id, permission_id);
CREATE UNIQUE INDEX ux_user_roles ON user_roles (tenant_id, user_id, role_id);
CREATE INDEX ix_user_roles_role ON user_roles (tenant_id, role_id, user_id);
```

Application phải kiểm tra `user`, `role` cùng tenant trước khi ghi bảng liên kết.

### 5.4 Session và refresh token

`sessions` gồm `id`, `tenant_id`, `user_id`, `refresh_token_hash`, `device_id`,
`ip_hash`, `user_agent`, `issued_at`, `expires_at`, `revoked_at`, `revoke_reason`.

```sql
CREATE UNIQUE INDEX ux_sessions_refresh_hash ON sessions (refresh_token_hash);
CREATE INDEX ix_sessions_user_active
ON sessions (tenant_id, user_id, expires_at DESC)
WHERE revoked_at IS NULL;
CREATE INDEX ix_sessions_expiry ON sessions (expires_at)
WHERE revoked_at IS NULL;
```

Refresh token chỉ lưu hash. Session hết hạn được purge theo retention job.

## 6. `master-data-service` - `logix_master_data`

PostGIS được khuyến nghị cho tọa độ warehouse và delivery address. Nếu chưa bật
PostGIS, dùng `latitude numeric(9,6)` và `longitude numeric(9,6)` với `CHECK` phạm
vi; không dùng chuỗi để lưu tọa độ.

### 6.1 `customers`

Các cột: `id`, `tenant_id`, `code`, `name`, `tax_code`, `phone`, `email`, `status`,
`disabled_at`, `disabled_reason`, cột nền.

```sql
CREATE UNIQUE INDEX ux_customers_tenant_code
ON customers (tenant_id, code);
CREATE INDEX ix_customers_tenant_status_name
ON customers (tenant_id, status, name);
CREATE INDEX ix_customers_search_name
ON customers USING gin (to_tsvector('simple', coalesce(name, '') || ' ' || code));
```

GIN chỉ nên tạo nếu endpoint có full-text search. Với tìm prefix, dùng `pg_trgm`
và GIN trigram thay vì B-tree thông thường.

### 6.2 `customer_addresses`

Các cột: `id`, `tenant_id`, `customer_id` (FK nội bộ), `label`, `recipient_name`,
`phone`, `address_line`, `ward`, `district`, `province`, `postal_code`, `location
geography(Point,4326)`, `is_default`, `status`, cột nền.

```sql
CREATE INDEX ix_customer_addresses_customer
ON customer_addresses (tenant_id, customer_id, status);
CREATE UNIQUE INDEX ux_customer_default_address
ON customer_addresses (tenant_id, customer_id)
WHERE is_default = true AND status = 'ACTIVE';
CREATE INDEX ix_customer_addresses_location
ON customer_addresses USING gist (location);
```

### 6.3 `products`

Các cột: `id`, `tenant_id`, `sku`, `name`, `base_unit`, `weight`, `volume`,
`status`, cột nền. `CHECK (weight >= 0)` và `CHECK (volume >= 0)`.

```sql
CREATE UNIQUE INDEX ux_products_tenant_sku ON products (tenant_id, sku);
CREATE INDEX ix_products_tenant_status_name ON products (tenant_id, status, name);
```

Threshold tồn thấp phụ thuộc SKU-kho nên không đặt trên `products`; đặt tại
`inventory-service` vì Inventory sở hữu quyết định low-stock theo balance.

### 6.4 `warehouses`

Các cột: `id`, `tenant_id`, `code`, `name`, địa chỉ chuẩn hóa, `location
geography(Point,4326)`, `status`, cột nền.

```sql
CREATE UNIQUE INDEX ux_warehouses_tenant_code ON warehouses (tenant_id, code);
CREATE INDEX ix_warehouses_tenant_status ON warehouses (tenant_id, status, name);
CREATE INDEX ix_warehouses_location ON warehouses USING gist (location);
```

### 6.5 `vehicles`

Các cột: `id`, `tenant_id`, `code`, `license_plate`, `capacity_weight`,
`capacity_volume`, `status`, cột nền. Capacity bắt buộc dương để dispatch.

```sql
CREATE UNIQUE INDEX ux_vehicles_tenant_code ON vehicles (tenant_id, code);
CREATE UNIQUE INDEX ux_vehicles_tenant_plate
ON vehicles (tenant_id, upper(license_plate));
CREATE INDEX ix_vehicles_active_capacity
ON vehicles (tenant_id, capacity_weight, capacity_volume)
WHERE status = 'ACTIVE';
```

### 6.6 `drivers`

Các cột: `id`, `tenant_id`, `code`, `user_id` (ID từ Identity, không FK),
`license_number`, `license_expiry`, `phone`, `status`, cột nền.

```sql
CREATE UNIQUE INDEX ux_drivers_tenant_code ON drivers (tenant_id, code);
CREATE UNIQUE INDEX ux_drivers_tenant_user ON drivers (tenant_id, user_id);
CREATE UNIQUE INDEX ux_drivers_tenant_license
ON drivers (tenant_id, license_number);
CREATE INDEX ix_drivers_active ON drivers (tenant_id, id)
WHERE status = 'ACTIVE';
```

Master data đã được tham chiếu chỉ disable, không hard delete. Database role ứng
dụng có thể bị thu hồi quyền `DELETE` trên các bảng này sau khi luồng vận hành ổn định.

## 7. `order-service` - `logix_order`

### 7.1 `sales_orders`

| Cột | Kiểu | Ràng buộc/ý nghĩa |
|---|---|---|
| `id`, `tenant_id` | `uuid` | PK và tenant scope |
| `order_number` | `varchar(50)` | Unique trong tenant |
| `customer_id` | `uuid` | Tham chiếu Master Data, không FK |
| `delivery_address_id` | `uuid` | Tham chiếu Master Data |
| `warehouse_id` | `uuid` | Chính xác một kho/order |
| `currency` | `char(3)` | Currency của tenant |
| `status` | `varchar(30)` | State machine BRD |
| `order_source` | `varchar(30)` | `B2B`, `ECOMMERCE` nếu stretch |
| `external_channel` | `varchar(50) NULL` | Stretch |
| `external_order_id` | `varchar(100) NULL` | Stretch |
| `idempotency_key` | `varchar(100) NULL` | Chống import/tạo trùng |
| `total_quantity` | `numeric(18,3)` | Tổng dòng hàng |
| `total_weight` | `numeric(18,3)` | Snapshot tại thời điểm order |
| `total_volume` | `numeric(18,6)` | Snapshot |
| `confirmed_at` | `timestamptz NULL` | FIFO pending stock |
| `canceled_at` | `timestamptz NULL` | Hủy trước dispatch |
| `completed_at` | `timestamptz NULL` | Chỉ sau delivered |
| `cancel_reason` | `text NULL` | Lý do nếu hủy |
| `version` | `bigint` | Optimistic concurrency |

`status` chỉ nhận: `DRAFT`, `PENDING_STOCK`, `CONFIRMED`, `PICKING`,
`READY_TO_SHIP`, `IN_DELIVERY`, `DELIVERY_FAILED`, `COMPLETED`, `CANCELED`.

Index:

```sql
CREATE UNIQUE INDEX ux_orders_tenant_number
ON sales_orders (tenant_id, order_number);

CREATE UNIQUE INDEX ux_orders_tenant_idempotency
ON sales_orders (tenant_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX ux_orders_external_source
ON sales_orders (tenant_id, external_channel, external_order_id)
WHERE external_order_id IS NOT NULL;

CREATE INDEX ix_orders_tenant_status_created
ON sales_orders (tenant_id, status, created_at DESC);

CREATE INDEX ix_orders_customer_created
ON sales_orders (tenant_id, customer_id, created_at DESC);

CREATE INDEX ix_orders_warehouse_status
ON sales_orders (tenant_id, warehouse_id, status, created_at);

CREATE INDEX ix_orders_pending_fifo
ON sales_orders (tenant_id, warehouse_id, confirmed_at, id)
WHERE status = 'PENDING_STOCK';

CREATE INDEX ix_orders_active_updated
ON sales_orders (tenant_id, updated_at DESC)
WHERE status NOT IN ('COMPLETED', 'CANCELED');
```

### 7.2 `order_lines`

Các cột: `id`, `tenant_id`, `order_id` (FK nội bộ), `line_number`, `product_id`,
`sku_snapshot`, `product_name_snapshot`, `unit_snapshot`, `quantity`,
`unit_weight`, `unit_volume`, `created_at`, `updated_at`.

Ràng buộc:

```sql
CHECK (quantity > 0)
CHECK (unit_weight >= 0)
CHECK (unit_volume >= 0)
UNIQUE (tenant_id, order_id, line_number)
UNIQUE (tenant_id, order_id, product_id)
```

Index `ix_order_lines_order (tenant_id, order_id, line_number)` phục vụ load order.
Index `ix_order_lines_product (tenant_id, product_id, created_at DESC)` chỉ cần nếu
có query lịch sử theo SKU; forecast nên dùng event/projection chuyên biệt thay vì
quét trực tiếp database Order.

### 7.3 `order_status_history`

Các cột: `id`, `tenant_id`, `order_id`, `from_status`, `to_status`, `reason`,
`actor_id`, `correlation_id`, `order_version`, `occurred_at`.

```sql
CREATE UNIQUE INDEX ux_order_history_version
ON order_status_history (tenant_id, order_id, order_version);
CREATE INDEX ix_order_history_timeline
ON order_status_history (tenant_id, order_id, occurred_at, id);
```

History hỗ trợ timeline; audit bất biến đầy đủ vẫn thuộc Audit Service.

### 7.4 `order_shortages`

Projection trạng thái thiếu hàng gồm `id`, `tenant_id`, `order_id`, `product_id`,
`warehouse_id`, `required_quantity`, `available_quantity`, `shortage_hash`,
`detected_at`, `resolved_at`.

```sql
CREATE UNIQUE INDEX ux_open_order_shortage
ON order_shortages (tenant_id, order_id, product_id)
WHERE resolved_at IS NULL;
CREATE INDEX ix_shortage_retry_lookup
ON order_shortages (tenant_id, warehouse_id, product_id, detected_at)
WHERE resolved_at IS NULL;
```

Giá trị available trong bảng này chỉ là snapshot từ phản hồi Inventory, không phải
nguồn sự thật tồn kho.

## 8. `inventory-service` - `logix_inventory`

Đây là persistence boundary có yêu cầu transaction và concurrency nghiêm ngặt nhất.

### 8.1 `inventory_balances`

Các cột: `id`, `tenant_id`, `warehouse_id`, `product_id`, `on_hand_quantity`,
`reserved_quantity`, `low_stock_threshold`, `version`, `created_at`, `updated_at`.

```sql
CHECK (on_hand_quantity >= 0)
CHECK (reserved_quantity >= 0)
CHECK (on_hand_quantity >= reserved_quantity)
CHECK (low_stock_threshold >= 0)
UNIQUE (tenant_id, warehouse_id, product_id)
```

`available_quantity = on_hand_quantity - reserved_quantity` nên là generated
column hoặc biểu thức query, không có luồng ghi độc lập:

```sql
available_quantity numeric(18,3)
GENERATED ALWAYS AS (on_hand_quantity - reserved_quantity) STORED
```

Index:

```sql
CREATE UNIQUE INDEX ux_balances_warehouse_product
ON inventory_balances (tenant_id, warehouse_id, product_id);

CREATE INDEX ix_balances_product_warehouse
ON inventory_balances (tenant_id, product_id, warehouse_id);

CREATE INDEX ix_balances_low_stock
ON inventory_balances (tenant_id, warehouse_id, available_quantity)
WHERE available_quantity <= low_stock_threshold;
```

Lưu ý: PostgreSQL không cho partial-index predicate dùng biểu thức không immutable;
generated column ở đây là số học immutable. Cần kiểm tra migration thực tế.

Reserve all-or-nothing phải lock tất cả balance theo thứ tự ổn định, ví dụ
`ORDER BY product_id FOR UPDATE`, kiểm tra toàn bộ rồi mới tăng `reserved_quantity`
trong một transaction để tránh deadlock và partial reservation.

### 8.2 `reservation_groups`

Đại diện một lần reserve toàn bộ order: `id`, `tenant_id`, `order_id`,
`warehouse_id`, `status` (`ACTIVE`, `RELEASED`, `ISSUED`), `idempotency_key`,
`order_version`, `reserved_at`, `released_at`, `issued_at`, `version`.

```sql
CREATE UNIQUE INDEX ux_reservation_order_active
ON reservation_groups (tenant_id, order_id)
WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX ux_reservation_idempotency
ON reservation_groups (tenant_id, idempotency_key);
CREATE INDEX ix_reservation_status_age
ON reservation_groups (tenant_id, status, reserved_at);
```

### 8.3 `inventory_reservations`

Các cột: `id`, `tenant_id`, `reservation_group_id` (FK nội bộ), `order_id`,
`order_line_id`, `balance_id` (FK nội bộ), `warehouse_id`, `product_id`, `quantity`,
`status`, `created_at`, `released_at`, `issued_at`.

```sql
CHECK (quantity > 0)
UNIQUE (tenant_id, reservation_group_id, order_line_id)
```

Index:

```sql
CREATE INDEX ix_reservations_group
ON inventory_reservations (tenant_id, reservation_group_id);
CREATE INDEX ix_reservations_balance_active
ON inventory_reservations (tenant_id, balance_id, created_at)
WHERE status = 'ACTIVE';
CREATE INDEX ix_reservations_order
ON inventory_reservations (tenant_id, order_id, status);
```

### 8.4 `stock_movements`

Ledger append-only cho mọi thay đổi on-hand. Các cột: `id`, `tenant_id`,
`warehouse_id`, `product_id`, `balance_id`, `movement_type` (`RECEIPT`, `ISSUE`,
`ADJUSTMENT_IN`, `ADJUSTMENT_OUT`, `REVERSAL`), `quantity_delta`, `before_on_hand`,
`after_on_hand`, `reference_type`, `reference_id`, `idempotency_key`, `reason`,
`actor_id`, `correlation_id`, `occurred_at`, `created_at`.

Ràng buộc:

```sql
CHECK (quantity_delta <> 0)
CHECK (after_on_hand >= 0)
CHECK (movement_type NOT LIKE 'ADJUSTMENT%' OR reason IS NOT NULL)
```

Index:

```sql
CREATE UNIQUE INDEX ux_stock_movement_idempotency
ON stock_movements (tenant_id, idempotency_key);
CREATE INDEX ix_stock_movement_balance_time
ON stock_movements (tenant_id, warehouse_id, product_id, occurred_at DESC, id);
CREATE INDEX ix_stock_movement_reference
ON stock_movements (tenant_id, reference_type, reference_id);
CREATE INDEX ix_stock_movement_correlation
ON stock_movements (tenant_id, correlation_id);
```

Ứng dụng không cung cấp API update/delete movement. Sửa sai bằng movement đảo có
tham chiếu movement gốc.

### 8.5 `stock_receipts`

Các cột: `id`, `tenant_id`, `receipt_number`, `warehouse_id`, `idempotency_key`,
`status`, `received_at`, `actor_id`, `correlation_id`, cột nền. `stock_receipt_lines`
gồm product, quantity và liên kết movement.

```sql
CREATE UNIQUE INDEX ux_receipts_tenant_number
ON stock_receipts (tenant_id, receipt_number);
CREATE UNIQUE INDEX ux_receipts_idempotency
ON stock_receipts (tenant_id, idempotency_key);
CREATE INDEX ix_receipts_warehouse_time
ON stock_receipts (tenant_id, warehouse_id, received_at DESC);
```

## 9. `fulfillment-service` - `logix_fulfillment`

### 9.1 `shipments`

Các cột: `id`, `tenant_id`, `shipment_number`, `order_id`, `warehouse_id`,
`delivery_address_id`, `status`, `total_weight`, `total_volume`,
`reservation_group_id`, `assigned_trip_id NULL`, `dispatch_issued_at NULL`,
`ready_at`, `delivered_at`, `failed_at`, `failure_reason`, cột nền.

`status`: `CREATED`, `READY`, `ASSIGNED`, `IN_TRANSIT`, `FAILED`, `DELIVERED`,
`CANCELED`.

```sql
CREATE UNIQUE INDEX ux_shipments_order
ON shipments (tenant_id, order_id);
CREATE UNIQUE INDEX ux_shipments_number
ON shipments (tenant_id, shipment_number);
CREATE INDEX ix_shipments_ready_warehouse
ON shipments (tenant_id, warehouse_id, ready_at, id)
WHERE status = 'READY';
CREATE INDEX ix_shipments_trip_status
ON shipments (tenant_id, assigned_trip_id, status)
WHERE assigned_trip_id IS NOT NULL;
CREATE INDEX ix_shipments_order_status
ON shipments (tenant_id, order_id, status);
```

Unique `(tenant_id, order_id)` bảo vệ quan hệ một order - tối đa một shipment.
`assigned_trip_id` là ID xuyên service và không có FK; Fulfillment vẫn là authority
cho shipment state, còn Transport là authority cho membership của trip.

### 9.2 `shipment_items`

Snapshot đóng gói gồm `id`, `tenant_id`, `shipment_id`, `order_line_id`,
`product_id`, `sku_snapshot`, `quantity`, `weight`, `volume`.

```sql
UNIQUE (tenant_id, shipment_id, order_line_id)
CHECK (quantity > 0)
CREATE INDEX ix_shipment_items_shipment
ON shipment_items (tenant_id, shipment_id);
```

### 9.3 `shipment_status_history`

Giống pattern order history: unique theo `(tenant_id, shipment_id,
shipment_version)` và index timeline `(tenant_id, shipment_id, occurred_at, id)`.

## 10. `transport-service` - `logix_transport`

### 10.1 `delivery_trips`

Các cột: `id`, `tenant_id`, `trip_number`, `warehouse_id`, `vehicle_id`,
`driver_id`, `status`, `planned_start_at`, `actual_start_at`, `completed_at`,
`total_weight`, `total_volume`, `approved_route_plan_id`, `dispatch_version`,
`dispatched_at`, `canceled_at`, `cancel_reason`, cột nền.

`status`: `DRAFT`, `PLANNED`, `APPROVED`, `IN_PROGRESS`, `COMPLETED`, `CANCELED`.

```sql
CREATE UNIQUE INDEX ux_trips_number ON delivery_trips (tenant_id, trip_number);
CREATE INDEX ix_trips_status_schedule
ON delivery_trips (tenant_id, status, planned_start_at);
CREATE INDEX ix_trips_warehouse_status
ON delivery_trips (tenant_id, warehouse_id, status, planned_start_at);
CREATE INDEX ix_trips_driver_active
ON delivery_trips (tenant_id, driver_id, planned_start_at)
WHERE status IN ('PLANNED', 'APPROVED', 'IN_PROGRESS');
CREATE INDEX ix_trips_vehicle_active
ON delivery_trips (tenant_id, vehicle_id, planned_start_at)
WHERE status IN ('PLANNED', 'APPROVED', 'IN_PROGRESS');
```

Nếu trip có `planned_end_at`, nên dùng exclusion constraint với `tstzrange` để
ngăn lịch trùng ở database. Đây là lựa chọn cần ADR vì ảnh hưởng quy tắc scheduling:

```sql
EXCLUDE USING gist (
  tenant_id WITH =,
  driver_id WITH =,
  tstzrange(planned_start_at, planned_end_at, '[)') WITH &&
) WHERE (status IN ('PLANNED', 'APPROVED', 'IN_PROGRESS'));
```

Tương tự cho vehicle. Application vẫn phải kiểm tra trạng thái ACTIVE qua contract
Master Data ngay trước dispatch.

### 10.2 `trip_shipments`

Các cột: `id`, `tenant_id`, `trip_id` (FK nội bộ), `shipment_id`, `warehouse_id`,
`weight`, `volume`, `assigned_at`, `removed_at`.

```sql
CREATE UNIQUE INDEX ux_trip_active_shipment
ON trip_shipments (tenant_id, shipment_id)
WHERE removed_at IS NULL;
CREATE INDEX ix_trip_shipments_trip
ON trip_shipments (tenant_id, trip_id, assigned_at)
WHERE removed_at IS NULL;
```

Warehouse của mọi row phải bằng warehouse của trip; application kiểm tra trong
transaction. Có thể dùng trigger nội bộ nếu cần defense-in-depth, nhưng không gọi
service khác từ trigger.

### 10.3 `trip_stops`

Các cột: `id`, `tenant_id`, `trip_id`, `shipment_id`, `delivery_address_id`,
`address_snapshot jsonb`, `location geography(Point,4326)`, `planned_sequence`,
`approved_sequence`, `status` (`PENDING`, `ARRIVED`, `DELIVERED`, `FAILED`),
`current_attempt`, `arrived_at`, `completed_at`, cột nền.

```sql
CREATE UNIQUE INDEX ux_trip_stop_shipment
ON trip_stops (tenant_id, trip_id, shipment_id);
CREATE UNIQUE INDEX ux_trip_stop_approved_sequence
ON trip_stops (tenant_id, trip_id, approved_sequence)
WHERE approved_sequence IS NOT NULL;
CREATE INDEX ix_trip_stops_driver_view
ON trip_stops (tenant_id, trip_id, approved_sequence);
CREATE INDEX ix_trip_stops_status
ON trip_stops (tenant_id, trip_id, status);
CREATE INDEX ix_trip_stops_location ON trip_stops USING gist (location);
```

Các unique index đảm bảo mỗi shipment phục vụ đúng một lần và không trùng thứ tự.

### 10.4 `route_plans`

Các cột: `id`, `tenant_id`, `trip_id`, `plan_version`, `route_request_id`,
`status` (`PROPOSED`, `APPROVED`, `SUPERSEDED`, `REJECTED`), `source`
(`OPTIMIZER`, `MANUAL_OVERRIDE`), `input_hash`, `solver_name`, `solver_version`,
`objective`, `total_distance`, `estimated_cost`, `metrics jsonb`,
`original_plan_id NULL`, `override_reason NULL`, `approved_by`, `approved_at`,
`created_at`.

```sql
CREATE UNIQUE INDEX ux_route_plan_version
ON route_plans (tenant_id, trip_id, plan_version);
CREATE UNIQUE INDEX ux_route_request
ON route_plans (tenant_id, route_request_id);
CREATE UNIQUE INDEX ux_route_plan_approved
ON route_plans (tenant_id, trip_id)
WHERE status = 'APPROVED';
CREATE INDEX ix_route_plan_trip_created
ON route_plans (tenant_id, trip_id, created_at DESC);
CREATE INDEX ix_route_plan_input_hash
ON route_plans (tenant_id, input_hash, created_at DESC);
```

Manual override bắt buộc `override_reason` và `original_plan_id`:

```sql
CHECK (
  source <> 'MANUAL_OVERRIDE'
  OR (override_reason IS NOT NULL AND original_plan_id IS NOT NULL)
)
```

### 10.5 `route_plan_stops`

Các cột: `route_plan_id`, `tenant_id`, `trip_stop_id`, `sequence`,
`distance_from_previous`, `cumulative_distance`, `estimated_arrival_at`.

```sql
UNIQUE (tenant_id, route_plan_id, sequence)
UNIQUE (tenant_id, route_plan_id, trip_stop_id)
```

Hai constraint chứng minh mỗi stop xuất hiện đúng một lần trong một plan.

### 10.6 `delivery_attempts`

Các cột: `id`, `tenant_id`, `trip_stop_id`, `shipment_id`, `attempt_number`,
`status`, `reason`, `actor_driver_id`, `occurred_at`, `correlation_id`.

```sql
CHECK (status <> 'FAILED' OR reason IS NOT NULL)
UNIQUE (tenant_id, trip_stop_id, attempt_number)
CREATE INDEX ix_delivery_attempt_shipment
ON delivery_attempts (tenant_id, shipment_id, attempt_number DESC);
```

### 10.7 `trip_dispatches`

Idempotency record gồm `id`, `tenant_id`, `trip_id`, `dispatch_version`,
`idempotency_key`, `status`, `requested_by`, `requested_at`, `completed_at`,
`correlation_id`.

```sql
CREATE UNIQUE INDEX ux_trip_dispatch_version
ON trip_dispatches (tenant_id, trip_id, dispatch_version);
CREATE UNIQUE INDEX ux_trip_dispatch_key
ON trip_dispatches (tenant_id, idempotency_key);
```

Transport chỉ phát `TripDispatched` một lần cho dispatch version. Inventory vẫn
tự deduplicate event trước khi trừ kho.

## 11. `notification-service` - `logix_notification`

### 11.1 `notifications`

Các cột: `id`, `tenant_id`, `type`, `title`, `body`, `severity`, `entity_type`,
`entity_id`, `source_event_id`, `deduplication_key`, `data jsonb`, `created_at`,
`expires_at`.

```sql
CREATE UNIQUE INDEX ux_notification_event_recipient_scope
ON notifications (tenant_id, deduplication_key)
WHERE deduplication_key IS NOT NULL;
CREATE INDEX ix_notifications_entity
ON notifications (tenant_id, entity_type, entity_id, created_at DESC);
CREATE INDEX ix_notifications_created
ON notifications (tenant_id, created_at DESC);
```

### 11.2 `notification_recipients`

Các cột: `id`, `tenant_id`, `notification_id`, `recipient_type` (`USER`, `ROLE`),
`recipient_id`, `read_at`, `archived_at`, `created_at`.

```sql
CREATE UNIQUE INDEX ux_notification_recipient
ON notification_recipients
(tenant_id, notification_id, recipient_type, recipient_id);
CREATE INDEX ix_recipient_unread
ON notification_recipients (tenant_id, recipient_type, recipient_id, created_at DESC)
WHERE read_at IS NULL AND archived_at IS NULL;
```

### 11.3 `notification_deliveries`

Theo dõi kênh `IN_APP`, `EMAIL`, `PUSH` nếu triển khai: `notification_recipient_id`,
`channel`, `status`, `attempt_count`, `next_attempt_at`, `sent_at`, `last_error`.

```sql
CREATE UNIQUE INDEX ux_delivery_channel
ON notification_deliveries (notification_recipient_id, channel);
CREATE INDEX ix_delivery_retry
ON notification_deliveries (next_attempt_at)
WHERE status IN ('PENDING', 'RETRY');
```

## 12. `audit-service` - `logix_audit`

### 12.1 `audit_logs`

Audit append-only gồm:

| Cột | Kiểu | Ý nghĩa |
|---|---|---|
| `id` | `uuid PK` | Audit ID |
| `tenant_id` | `uuid NOT NULL` | Tenant context |
| `actor_id` | `uuid NULL` | User/system actor |
| `actor_type` | `varchar(30)` | `USER`, `SYSTEM`, `AGENT` |
| `action` | `varchar(100)` | Hành động chuẩn hóa |
| `entity_type` | `varchar(100)` | Loại đối tượng |
| `entity_id` | `uuid NULL` | ID đối tượng |
| `outcome` | `varchar(30)` | `SUCCESS`, `DENIED`, `FAILED` |
| `before_data` | `jsonb NULL` | Dữ liệu đã lọc |
| `after_data` | `jsonb NULL` | Dữ liệu đã lọc |
| `metadata` | `jsonb` | IP hash, reason, tool metadata |
| `correlation_id` | `uuid NOT NULL` | Truy vết |
| `causation_id` | `uuid NULL` | Nguồn trực tiếp |
| `source_service` | `varchar(100)` | Producer |
| `source_event_id` | `uuid NULL` | Deduplicate ingestion |
| `occurred_at` | `timestamptz` | Thời điểm hành động |
| `ingested_at` | `timestamptz` | Thời điểm audit nhận |

Index:

```sql
CREATE UNIQUE INDEX ux_audit_source_event
ON audit_logs (source_service, source_event_id)
WHERE source_event_id IS NOT NULL;
CREATE INDEX ix_audit_tenant_time
ON audit_logs (tenant_id, occurred_at DESC, id);
CREATE INDEX ix_audit_actor_time
ON audit_logs (tenant_id, actor_id, occurred_at DESC);
CREATE INDEX ix_audit_action_time
ON audit_logs (tenant_id, action, occurred_at DESC);
CREATE INDEX ix_audit_entity_time
ON audit_logs (tenant_id, entity_type, entity_id, occurred_at DESC);
CREATE INDEX ix_audit_correlation
ON audit_logs (tenant_id, correlation_id, occurred_at);
CREATE INDEX ix_audit_failed
ON audit_logs (tenant_id, occurred_at DESC)
WHERE outcome IN ('DENIED', 'FAILED');
```

Không tạo GIN trên toàn bộ `before_data`/`after_data` mặc định vì tốn chi phí ghi.
Chỉ thêm expression index cho key thực sự được truy vấn thường xuyên.

Audit role ứng dụng chỉ có `INSERT` và `SELECT`; không có `UPDATE`/`DELETE`. Nếu
phải tuân thủ retention, purge chạy bằng role vận hành riêng, có audit và chính
sách được ADR phê duyệt. Khi dữ liệu lớn, partition theo tháng trên `occurred_at`,
nhưng mọi query vẫn phải có `tenant_id` và khoảng thời gian.

## 13. `agent-service` - `logix_agent`

### 13.1 `conversations`

Các cột: `id`, `tenant_id`, `user_id`, `title`, `status`, `context_summary`,
`last_message_at`, `expires_at`, cột nền.

```sql
CREATE INDEX ix_conversations_user_recent
ON conversations (tenant_id, user_id, last_message_at DESC)
WHERE status = 'ACTIVE';
```

Không lưu token/API key. Nội dung hội thoại phải có retention và redaction policy.

### 13.2 `conversation_messages`

Các cột: `id`, `tenant_id`, `conversation_id`, `role`, `content`,
`content_redacted`, `model_message_id`, `sequence`, `created_at`.

```sql
CREATE UNIQUE INDEX ux_message_sequence
ON conversation_messages (tenant_id, conversation_id, sequence);
CREATE INDEX ix_message_timeline
ON conversation_messages (tenant_id, conversation_id, created_at, id);
```

Nếu không cần lưu raw content, chỉ lưu bản redacted. Raw prompt không được mặc định
đưa vào audit hoặc log.

### 13.3 `agent_executions`

Các cột: `id`, `tenant_id`, `user_id`, `conversation_id`, `status` (`QUEUED`,
`RUNNING`, `WAITING_CONFIRMATION`, `SUCCEEDED`, `FAILED`, `CANCELED`, `TIMED_OUT`),
`intent`, `provider`, `model`, `model_version`, `input_summary`, `output_summary`,
`correlation_id`, `idempotency_key`, `started_at`, `finished_at`, `latency_ms`,
`error_code`, `error_message_sanitized`, cột nền.

```sql
CREATE UNIQUE INDEX ux_agent_execution_idempotency
ON agent_executions (tenant_id, user_id, idempotency_key);
CREATE INDEX ix_agent_execution_user_recent
ON agent_executions (tenant_id, user_id, created_at DESC);
CREATE INDEX ix_agent_execution_status_age
ON agent_executions (tenant_id, status, created_at)
WHERE status IN ('QUEUED', 'RUNNING', 'WAITING_CONFIRMATION');
CREATE INDEX ix_agent_execution_metrics
ON agent_executions (tenant_id, provider, model, finished_at DESC)
WHERE finished_at IS NOT NULL;
CREATE INDEX ix_agent_execution_correlation
ON agent_executions (tenant_id, correlation_id);
```

### 13.4 `tool_calls`

Các cột: `id`, `tenant_id`, `agent_execution_id`, `sequence`, `tool_name`,
`tool_version`, `required_permission`, `input_sanitized jsonb`,
`output_sanitized jsonb`, `status`, `attempt_count`, `started_at`, `finished_at`,
`latency_ms`, `business_entity_type`, `business_entity_id`, `error_code`.

```sql
CREATE UNIQUE INDEX ux_tool_call_sequence
ON tool_calls (tenant_id, agent_execution_id, sequence);
CREATE INDEX ix_tool_call_metrics
ON tool_calls (tenant_id, tool_name, status, finished_at DESC);
CREATE INDEX ix_tool_call_business_entity
ON tool_calls (tenant_id, business_entity_type, business_entity_id);
```

Business outcome trong bảng này chỉ là metadata; state cuối thuộc owning service.

### 13.5 `confirmation_requests`

Các cột: `id`, `tenant_id`, `user_id`, `agent_execution_id`, `tool_call_id`,
`action_type`, `preview_payload_sanitized jsonb`, `context_hash`, `status`
(`PENDING`, `CONFIRMED`, `REJECTED`, `EXPIRED`, `CONSUMED`), `expires_at`,
`confirmed_at`, `consumed_at`, `version`.

```sql
CREATE UNIQUE INDEX ux_pending_tool_confirmation
ON confirmation_requests (tenant_id, tool_call_id)
WHERE status = 'PENDING';
CREATE INDEX ix_confirmation_user_pending
ON confirmation_requests (tenant_id, user_id, expires_at)
WHERE status = 'PENDING';
CREATE UNIQUE INDEX ux_confirmation_context_consumed
ON confirmation_requests (tenant_id, user_id, context_hash)
WHERE status = 'CONSUMED';
```

Khi consume confirmation, transaction phải kiểm tra cùng tenant, user, action,
preview hash, chưa hết hạn và chưa consumed. Confirm không tự ghi business DB;
Agent gọi API owning service dưới quyền user.

### 13.6 `llm_provider_configs`

Chỉ lưu cấu hình không bí mật: `id`, `tenant_id NULL` (default nền tảng hoặc override
tenant), `provider`, `model`, `endpoint_alias`, `parameters jsonb`, `is_active`,
`version`, timestamp. Secret lưu trong secret manager và chỉ tham chiếu bằng
`credential_ref`.

```sql
CREATE UNIQUE INDEX ux_active_provider_config
ON llm_provider_configs (tenant_id, provider)
WHERE is_active = true;
```

Thiết kế này hỗ trợ engine-agnostic và đổi model bằng cấu hình, nhưng business code
chỉ gọi interface chung, không phụ thuộc schema của provider.

## 14. `forecast-service` - `logix_forecast`

### 14.1 `demand_observations`

Projection rebuildable từ sự kiện order hoàn tất, không đọc trực tiếp Order DB.
Các cột: `id`, `tenant_id`, `warehouse_id`, `product_id`, `demand_date`,
`fulfilled_quantity`, `source_event_id`, `source_order_id`, `source_version`,
`created_at`.

```sql
CHECK (fulfilled_quantity >= 0)
CREATE UNIQUE INDEX ux_demand_source_event
ON demand_observations (source_event_id);
CREATE UNIQUE INDEX ux_demand_order_product
ON demand_observations
(tenant_id, source_order_id, product_id, source_version);
CREATE INDEX ix_demand_series_date
ON demand_observations (tenant_id, warehouse_id, product_id, demand_date);
```

Có thể tổng hợp bảng `daily_demand` theo khóa `(tenant_id, warehouse_id,
product_id, demand_date)` để tăng tốc. Projection phải cập nhật idempotent và có
khả năng rebuild.

### 14.2 `forecast_runs`

Các cột: `id`, `tenant_id`, `status`, `horizon_days`, `training_start_date`,
`training_end_date`, `requested_by`, `trigger_type`, `model_name`, `model_version`,
`baseline_name`, `parameters jsonb`, `dataset_hash`, `random_seed`, `started_at`,
`completed_at`, `latency_ms`, `error_code`, `error_message_sanitized`, cột nền.

```sql
CHECK (horizon_days > 0)
CREATE INDEX ix_forecast_runs_tenant_recent
ON forecast_runs (tenant_id, created_at DESC);
CREATE INDEX ix_forecast_runs_status
ON forecast_runs (tenant_id, status, created_at)
WHERE status IN ('QUEUED', 'RUNNING', 'FAILED');
CREATE INDEX ix_forecast_reproducibility
ON forecast_runs (tenant_id, dataset_hash, model_name, model_version);
```

### 14.3 `forecast_series`

Một run có nhiều chuỗi SKU-kho: `id`, `tenant_id`, `forecast_run_id`,
`warehouse_id`, `product_id`, `status`, `observation_count`, `confidence_level`,
`fallback_used`, `fallback_reason`, `model_artifact_uri`, `artifact_checksum`.

```sql
CREATE UNIQUE INDEX ux_forecast_run_series
ON forecast_series (tenant_id, forecast_run_id, warehouse_id, product_id);
CREATE INDEX ix_forecast_series_lookup
ON forecast_series (tenant_id, warehouse_id, product_id, forecast_run_id);
```

### 14.4 `forecast_results`

Các cột: `id`, `tenant_id`, `forecast_series_id`, `forecast_date`,
`predicted_quantity`, `lower_bound`, `upper_bound`, `actual_quantity NULL`,
`created_at`, `actual_updated_at`.

```sql
CHECK (predicted_quantity >= 0)
CHECK (lower_bound IS NULL OR lower_bound >= 0)
CHECK (upper_bound IS NULL OR upper_bound >= lower_bound)
CREATE UNIQUE INDEX ux_forecast_result_date
ON forecast_results (tenant_id, forecast_series_id, forecast_date);
CREATE INDEX ix_forecast_dashboard_date
ON forecast_results (tenant_id, forecast_date, forecast_series_id);
```

### 14.5 `forecast_metrics`

Các cột: `id`, `tenant_id`, `forecast_series_id`, `metric_name` (`MAPE`, `RMSE`),
`metric_value`, `evaluation_start_date`, `evaluation_end_date`, `zero_actual_policy`,
`sample_count`, `calculated_at`.

```sql
CREATE UNIQUE INDEX ux_forecast_metric_window
ON forecast_metrics
(tenant_id, forecast_series_id, metric_name, evaluation_start_date, evaluation_end_date);
CREATE INDEX ix_forecast_metric_compare
ON forecast_metrics (tenant_id, metric_name, calculated_at DESC);
```

Model và baseline phải chạy trên cùng dataset/window. Forecast chỉ tư vấn, không
tạo stock receipt hoặc thay đổi threshold.

## 15. `route-optimizer-service` - `logix_route_optimizer`

### 15.1 Lựa chọn persistence cho MVP

Service có thể stateless: nhận request, chạy OR-Tools và trả proposal; Transport
lưu RoutePlan authoritative. Redis cache distance matrix theo `input_hash` có TTL.

Nếu cần tái lập, benchmark và theo dõi job độc lập như BRD yêu cầu, dùng database
metadata riêng sau đây. Không lưu authority approve/dispatch tại đây.

### 15.2 `optimization_runs`

Các cột: `id`, `tenant_id`, `route_request_id`, `trip_id`, `status`, `input_hash`,
`input_snapshot_uri`, `solver_name`, `solver_version`, `objective`, `parameters
jsonb`, `stop_count`, `vehicle_capacity_weight`, `vehicle_capacity_volume`,
`started_at`, `completed_at`, `latency_ms`, `error_code`, `fallback_reason`,
`correlation_id`, `created_at`.

```sql
CREATE UNIQUE INDEX ux_optimization_request
ON optimization_runs (tenant_id, route_request_id);
CREATE INDEX ix_optimization_trip_recent
ON optimization_runs (tenant_id, trip_id, created_at DESC);
CREATE INDEX ix_optimization_status_age
ON optimization_runs (tenant_id, status, created_at)
WHERE status IN ('QUEUED', 'RUNNING', 'FAILED');
CREATE INDEX ix_optimization_reproduce
ON optimization_runs (tenant_id, input_hash, solver_name, solver_version);
```

### 15.3 `optimization_stops`

Snapshot input/output: `id`, `tenant_id`, `optimization_run_id`, `trip_stop_id`,
`input_sequence`, `optimized_sequence`, `demand_weight`, `demand_volume`,
`latitude`, `longitude`, `distance_from_previous`.

```sql
CREATE UNIQUE INDEX ux_optimization_stop
ON optimization_stops (tenant_id, optimization_run_id, trip_stop_id);
CREATE UNIQUE INDEX ux_optimization_sequence
ON optimization_stops (tenant_id, optimization_run_id, optimized_sequence)
WHERE optimized_sequence IS NOT NULL;
```

### 15.4 `optimization_metrics`

Các cột: `id`, `tenant_id`, `optimization_run_id`, `metric_name`, `metric_value`,
`unit`, `baseline_type` (`INPUT_ORDER`, `NEAREST_NEIGHBOR`, `OPTIMIZED`),
`created_at`.

```sql
CREATE UNIQUE INDEX ux_optimization_metric
ON optimization_metrics
(tenant_id, optimization_run_id, metric_name, baseline_type);
```

Kết quả phải chứng minh route bắt đầu/kết thúc depot, mỗi stop đúng một lần và
không vượt capacity trước khi trả `SUCCEEDED`.

## 16. Quan hệ xuyên service

Các ID dưới đây là logical reference, không phải database FK:

| Consumer | ID tham chiếu | Authority |
|---|---|---|
| Order | `customer_id`, `delivery_address_id`, `warehouse_id`, `product_id` | Master Data |
| Inventory | `order_id`, `order_line_id`; `warehouse_id`, `product_id` | Order; Master Data |
| Fulfillment | `order_id`, `reservation_group_id`, `warehouse_id` | Order; Inventory; Master Data |
| Transport | `shipment_id`, `warehouse_id`, `vehicle_id`, `driver_id` | Fulfillment; Master Data |
| Forecast | `warehouse_id`, `product_id`, `source_order_id` | Master Data; Order |
| Agent | Business entity ID trong tool metadata | Owning business service |
| Audit | `entity_id`, `actor_id` | Owning service; Identity |

Để giữ tính đúng khi master data đổi:

- validate ID đồng bộ khi command cần kết quả tức thời;
- lưu snapshot bất biến cần thiết trên order/shipment/trip;
- dùng event để cập nhật projection nếu cần;
- không cascade delete xuyên service;
- không join qua database link hoặc shared ORM entity.

## 17. Mapping event vào persistence

| Event | Ghi authoritative/outbox tại | Consumer persistence chính |
|---|---|---|
| `StockReceived` | Inventory | Order inbox; Notification projection |
| `InventoryAdjusted` | Inventory | Audit inbox/read model |
| `OrderCreated` | Order | Audit/Notification inbox |
| `OrderConfirmed` | Order | Inventory inbox + reservation transaction |
| `OrderPendingStock` | Order | Notification inbox |
| `InventoryReserved` | Inventory | Order inbox + status transition |
| `ShipmentReady` | Fulfillment | Transport integration/read path |
| `TripPlanned` | Transport | Route Optimizer inbox/job |
| `RouteOptimized` | Route Optimizer | Transport inbox + proposed RoutePlan |
| `RouteApproved` | Transport | Audit/outbox consumers |
| `TripDispatched` | Transport | Inventory inbox + stock issue; Fulfillment inbox |
| `DeliveryCompleted` | Transport | Fulfillment và Order inbox |
| `DeliveryFailed` | Transport | Fulfillment, Order, Notification inbox |
| `ForecastCompleted` | Forecast | Notification/dashboard projection |
| `AgentExecutionCompleted` | Agent | Audit/metrics consumer |

Business effect và insert inbox phải cùng transaction. Consumer nhận event có
`aggregate_version` nhỏ hơn hoặc bằng version đã áp dụng phải bỏ qua an toàn hoặc
ghi outcome `STALE`; không được làm state lùi.

## 18. Transaction và concurrency quan trọng

### 18.1 Confirm order

Không có distributed ACID giữa Order và Inventory. Luồng cần trạng thái trung gian
hoặc command result rõ ràng:

1. Order kiểm tra version/idempotency và ghi intent xác nhận.
2. Inventory nhận command với tenant, order ID/version và toàn bộ lines.
3. Inventory lock balance theo thứ tự product ID.
4. Nếu một line thiếu, không ghi reservation nào.
5. Nếu đủ, tạo một reservation group, các reservation lines, cập nhật balances và
   outbox `InventoryReserved` trong một transaction.
6. Order consume kết quả idempotently và chuyển `CONFIRMED` hoặc `PENDING_STOCK`.

### 18.2 Cancel trước dispatch

Inventory chỉ release reservation `ACTIVE`; update group, lines, balances và
outbox trong một transaction. `RELEASED` hoặc `ISSUED` trả kết quả idempotent hoặc
từ chối theo rule, không release lần hai.

### 18.3 Dispatch

Transport dùng unique `(tenant_id, trip_id, dispatch_version)`. Inventory consume
`TripDispatched`, khóa active reservation, giảm đồng thời on-hand và reserved,
tạo movement `ISSUE` và inbox record trong cùng transaction. Duplicate event tìm
thấy inbox/idempotency key thì không trừ kho lần hai.

### 18.4 State transition

Mọi command quan trọng dùng điều kiện version:

```sql
UPDATE sales_orders
SET status = :next_status,
    version = version + 1,
    updated_at = now()
WHERE tenant_id = :tenant_id
  AND id = :id
  AND version = :expected_version
  AND status = :expected_status;
```

Nếu affected rows bằng 0, trả conflict/stale command, không retry mù.

## 19. Chiến lược index và kiểm chứng hiệu năng

### 19.1 Access pattern bắt buộc

| Use case BRD | Index chủ đạo |
|---|---|
| Tìm order theo status/kho/thời gian | `sales_orders(tenant_id, warehouse_id, status, created_at)` |
| Retry pending FIFO | Partial `sales_orders(... confirmed_at)` |
| Xem available SKU-kho | Unique `inventory_balances(tenant_id, warehouse_id, product_id)` |
| Ledger tồn kho | `stock_movements(tenant_id, warehouse_id, product_id, occurred_at DESC)` |
| Shipment ready theo kho | Partial `shipments(tenant_id, warehouse_id, ready_at)` |
| Trip hiện tại của driver | Partial `delivery_trips(tenant_id, driver_id, planned_start_at)` |
| Stop theo thứ tự | `trip_stops(tenant_id, trip_id, approved_sequence)` |
| Notification chưa đọc | Partial recipient unread index |
| Audit filter | Composite tenant + actor/action/entity + time |
| Forecast SKU-kho | Demand/result index theo tenant + warehouse + product + date |
| Agent tool success rate | `tool_calls(tenant_id, tool_name, status, finished_at)` |

### 19.2 Nguyên tắc benchmark

- Seed tối thiểu dữ liệu forecast 180 ngày như BRD.
- Dùng phân bố dữ liệu gần thực tế, không chỉ vài chục row.
- Chạy `ANALYZE` trước khi đo.
- Lưu query, parameters, plan, row count, p50/p95 và cấu hình máy.
- Kiểm tra index scan, số buffer đọc, sort spill và lock wait.
- Không coi index tồn tại là bằng chứng hiệu năng; phải có benchmark tái lập.
- Kiểm tra write amplification cho Inventory, Audit và outbox trước khi thêm index.

### 19.3 Partitioning

Chưa cần partition cho MVP nếu dataset nhỏ. Ứng viên khi benchmark chứng minh cần:

- `audit_logs` theo tháng `occurred_at`;
- `stock_movements` theo tháng/quý;
- `demand_observations` theo tháng;
- `outbox_events` theo thời gian nếu retention lớn.

Không partition theo tenant mặc định vì số tenant thay đổi và gây nhiều partition.

## 20. Migration, backup và retention

### 20.1 Migration

- NestJS service dùng một migration tool thống nhất sau ADR (Prisma/TypeORM/Drizzle).
- FastAPI dùng SQLAlchemy 2 + Alembic.
- Mỗi service chỉ chạy migration database của mình.
- Migration có thứ tự, review được và chạy được trên database sạch.
- Production không dùng ORM auto-sync schema.
- Thay đổi destructive áp dụng expand-migrate-contract, không drop ngay cột đang dùng.
- CI phải chạy migration lên PostgreSQL sạch và kiểm tra schema drift.

### 20.2 Backup/restore

- Backup PostgreSQL có mã hóa và lịch phù hợp môi trường.
- Restore drill phải xác minh theo từng database service.
- Object storage artifact có versioning/checksum khi cần tái lập.
- Redis không cần backup cho cache tái tạo; nếu dùng durable execution state thì
  phải có ADR và recovery test.

### 20.3 Retention đề xuất cần xác nhận

| Dữ liệu | Nguyên tắc |
|---|---|
| Session hết hạn | Purge sau cửa sổ điều tra bảo mật đã duyệt |
| Inbox/outbox đã xử lý | Giữ qua cửa sổ replay/dedup, sau đó archive/purge |
| Notification | Theo chính sách sản phẩm/tenant |
| Agent message/tool payload | Tối thiểu cần thiết, redacted, có expiry |
| Forecast/optimization runs | Giữ đủ để benchmark và tái lập báo cáo |
| Audit | Theo chính sách khóa luận/doanh nghiệp; không xóa qua business API |
| Business row đã soft delete | Ẩn khỏi truy vấn thường; chỉ purge sau cửa sổ retention và kiểm tra tham chiếu đã được duyệt |

## 21. Bảo mật dữ liệu

1. TLS cho kết nối database ở môi trường triển khai.
2. Credential riêng/service và rotate qua secret manager.
3. Không log connection string, token, password, raw LLM secret.
4. Password/refresh token chỉ lưu hash phù hợp.
5. PII trong audit, Agent I/O và event phải được allowlist/redact.
6. Backup và artifact được mã hóa.
7. Query luôn parameterized; không nối chuỗi SQL từ input.
8. Database role ứng dụng không có quyền tạo schema/superuser.
9. Audit role không có update/delete qua business path.
10. Negative test bắt buộc chứng minh tenant A không đọc/sửa tenant B dù biết ID.

## 22. Checklist triển khai database cho từng service

Trước khi service được coi là sẵn sàng:

- [ ] Database/schema/role riêng đã được tạo.
- [ ] Migration đầu tiên chạy được trên PostgreSQL sạch.
- [ ] Tất cả business table có tenant scope đúng boundary.
- [ ] Bảng mutable có `deleted_at`; repository thường lọc `deleted_at IS NULL`.
- [ ] Bảng append-only không có API update/delete/soft-delete và chỉ purge qua retention role.
- [ ] Unique constraint nghiệp vụ chứa `tenant_id` khi cần.
- [ ] Không có FK, view hoặc query xuyên service database.
- [ ] Repository bắt buộc nhận tenant context.
- [ ] Optimistic version có trên aggregate quan trọng.
- [ ] Outbox/inbox/idempotency được dùng cho business effect tương ứng.
- [ ] State `CHECK` và quantity/capacity constraint đã được mã hóa.
- [ ] Index khớp access pattern đã công bố.
- [ ] `EXPLAIN (ANALYZE, BUFFERS)` được lưu cho query quan trọng.
- [ ] Unit test constraint và transaction rollback.
- [ ] Integration test duplicate/out-of-order event.
- [ ] Negative test cross-tenant.
- [ ] Backup/restore và retention owner được xác định.
- [ ] Health readiness kiểm tra database mà không lộ thông tin nhạy cảm.

## 23. Truy vết BRD

| Thiết kế | Yêu cầu BRD chính |
|---|---|
| Tenant-scoped key/index và negative test | BR-TEN-001, BR-TEN-005, NFR-SEC-001 |
| User status, session revocation | BR-TEN-006, FR-TEN-002 |
| Disable master data | BR-TEN-004 |
| Balance generated available + constraints | BR-INV-001, NFR-DAT-001 |
| Movement append-only, reason, actor | BR-INV-002, BR-INV-003 |
| Reservation group transaction | BR-ORD-003, AT-02, AT-03 |
| Pending FIFO index | BR-ORD-004 |
| Release/issue idempotency | BR-ORD-006, BR-TRIP-007, NFR-REL-001 |
| Unique shipment/order | BR-SHP-001 |
| Trip warehouse/capacity/schedule | BR-TRIP-001 đến BR-TRIP-003 |
| Unique stop/sequence | BR-TRIP-004, FR-ROUTE-001 |
| Proposed/approved/override route metadata | BR-TRIP-005, BR-AI-005 |
| Failed reason + delivery attempt | BR-DEL-002 |
| Confirmation context/consume | BR-AI-003, FR-AGT-002 |
| Sanitized Agent execution/tool call | FR-AGT-003, BR-AUD-002 |
| Provider config không chứa business logic | FR-AGT-004, FR-AGT-005, NFR-AI-004 |
| Forecast completed demand projection | BR-AI-004, FR-FC-001 |
| Baseline, MAPE/RMSE, reproducibility | FR-FC-002, FR-FC-003, AT-08 |
| Optimization input hash/solver/metrics | BR-AI-005, FR-TRIP-003 |
| Immutable audit query indexes | BR-AUD-001, BR-AUD-002, FR-AUD-001 |
| Outbox/inbox/versioning | NFR-REL-001, NFR-REL-002, NFR-DAT-001 |

## 24. Các quyết định còn cần ADR

1. ORM/migration tool thống nhất cho các NestJS service.
2. Một database/service hay một schema/service trên cùng database vật lý.
3. UUIDv4 hay UUIDv7 và nơi sinh ID.
4. Có bật PostgreSQL RLS hay chỉ tenant-filter + test ở MVP.
5. PostGIS cho tọa độ hay numeric latitude/longitude ở giai đoạn đầu.
6. Route Optimizer stateless hay lưu optimization metadata riêng.
7. Scheduling dùng exclusion constraint hay application transaction lock.
8. Retention cụ thể cho audit, event, notification và Agent conversation.
9. Ngưỡng dữ liệu để bật partitioning.
10. Chính sách snapshot/raw input cho forecast và route nhằm cân bằng tái lập với
    bảo mật và dung lượng.

Cho tới khi ADR được duyệt, implementation nên chọn phương án ít phức tạp nhất có
thể chứng minh invariant: PostgreSQL chung cluster, database/schema và credential
tách theo service, tenant-filter bắt buộc, migration riêng, Route Optimizer
stateless, PostGIS chỉ bật khi truy vấn không gian thực sự được triển khai.
