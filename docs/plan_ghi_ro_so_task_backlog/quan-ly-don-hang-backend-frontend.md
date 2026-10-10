# Mô tả task: Quản lý đơn hàng Backend + Frontend

**Dự án:** LogiX — nền tảng logistics và quản lý chuỗi cung ứng B2B đa tenant.  
**Ngày khảo sát:** 10/10/2026.  
**Trạng thái tài liệu:** Bản mô tả nghiệp vụ và đánh giá hiện trạng từ tài liệu/code; chưa phải API contract được phê duyệt.  
**Snapshot khảo sát:** Backend `40b892d`; Frontend `b8f6fdd`. Hai working tree sạch tại thời điểm ghi nhận.

> **Kết luận chính:** Task này không phải viết lại toàn bộ hệ thống từ đầu. Dự án đã có nền tảng danh tính, dữ liệu nền, quản lý tồn kho, schema Order và khung giao diện. Tuy nhiên, Order Service hiện chưa triển khai nghiệp vụ quản lý đơn và Frontend chưa có màn hình Orders. Có thể làm trước một lát cắt dùng được: **tạo bản nháp → xem/lọc → sửa hợp lệ → hủy bản nháp**. Luồng **xác nhận đơn thật** chỉ hoàn tất khi tích hợp được Inventory Reservation.

## 1. Scope Baseline — căn cứ và giới hạn khảo sát

### 1.1. Tài liệu nguồn

Tài liệu sử dụng ba lớp bằng chứng, không đánh đồng chúng:

| Lớp | Nguồn | Dùng để kết luận |
|---|---|---|
| Định hướng đồ án | [Đề cương](E:/GraduateProject/LogiX/LogiX-Backend/docs/plan_ghi_ro_so_task_backlog/de_cuong_do_an.md) | Vì sao phải có luồng đơn hàng; mối quan hệ với microservices, event-driven và Agentic AI. |
| Yêu cầu nghiệp vụ | [BRD](E:/GraduateProject/LogiX/LogiX-Backend/docs/plan_ghi_ro_so_task_backlog/brd.md), đặc biệt mục 6.2, 7.2, 8.1, 9.2, 10, 13 và 14 | Trạng thái, quy tắc một kho, giữ hàng toàn bộ, quyền thao tác và nghiệm thu. |
| Thiết kế và code | [Architecture index](E:/GraduateProject/LogiX/LogiX-Backend/docs/architecture/README.md), schema/migration, controller/service, gateway và các feature Frontend | Cái gì đã có trong repository; cái gì còn thiếu; điểm chưa thống nhất cần chốt. |

Các liên kết nguồn dùng đường dẫn tuyệt đối vì artifact và workspace nằm trên hai ổ đĩa khác nhau. Tài liệu đặt trong thư mục artifact của phiên làm việc, không thêm vào repository.

**Quy mô phạm vi:** 5 yêu cầu Order Must của BRD (`FR-ORD-001` đến `FR-ORD-005`), 7 quy tắc Order (`BR-ORD-001` đến `BR-ORD-007`) và 9 trạng thái SalesOrder được đối chiếu. Khảo sát code tập trung vào Order, Gateway, các phần Master Data/Inventory cần cho Order, và các điểm nối Frontend tương ứng; không phải audit toàn bộ dự án.

### 1.2. Cách đọc các nhãn

- **BRD bắt buộc:** yêu cầu đã nêu rõ trong tài liệu nghiệp vụ.
- **Code hiện có:** quan sát được trong source hoặc migration.
- **Đề xuất:** hướng triển khai/phân pha để nhóm thảo luận, không phải quyết định đã thông qua.
- **Chưa kiểm chứng:** chưa có bằng chứng runtime hoặc chưa chạy kiểm thử tương ứng trong lượt khảo sát này.

**Giới hạn kiểm chứng:** Tài liệu được tạo từ đọc tài liệu và source. Không khởi chạy Backend, không gọi API thật, không truy vấn database và không kiểm tra trạng thái migration đã áp dụng. Việc có migration không có nghĩa database đang chạy đã được migrate; việc có test không có nghĩa test đã pass.

## 2. Hiểu hệ thống trước khi hiểu task

### 2.1. LogiX phục vụ ai?

Theo BRD, LogiX phục vụ doanh nghiệp phân phối B2B có kho hàng và đội giao hàng nội bộ. Một tenant là một tổ chức/doanh nghiệp sử dụng nền tảng.

Ví dụ: doanh nghiệp A phân phối hàng cho đại lý, quản lý hai kho và các tài xế của mình. Nhân viên đơn hàng tiếp nhận yêu cầu của đại lý, nhân viên kho chuẩn bị hàng, điều phối viên gom hàng vào chuyến, tài xế cập nhật kết quả giao.

Tenant B có dữ liệu riêng. Mã đơn `SO-001` có thể xuất hiện ở cả A và B; người của A không được đọc/sửa đơn của B.

Đây **không phải mặc định một website thương mại điện tử** với checkout, thanh toán, khuyến mãi và marketplace. Tích hợp external order là hướng mở rộng, không phải điều kiện để hoàn thành task Order B2B.

### 2.2. Ba khái niệm dễ nhầm

| Khái niệm | Câu hỏi mà nó trả lời | Service sở hữu |
|---|---|---|
| SalesOrder — đơn bán hàng | Khách nào cần sản phẩm gì, bao nhiêu, giao tới đâu, lấy từ kho nào? | Order Service |
| Shipment — đơn vị hàng giao | Hàng của đơn này đã được giữ/chuẩn bị tới đâu, đã sẵn sàng và thuộc chuyến nào? | Fulfillment Service |
| DeliveryTrip — chuyến giao | Xe và tài xế nào giao các shipment nào, theo tuyến nào? | Transport Service |

Trong MVP:

```text
Một SalesOrder → đúng một kho → tối đa một Shipment
Nhiều Shipment READY cùng kho → một DeliveryTrip
```

**Shipment Pool không đồng nghĩa một shipment chứa nhiều order.** Nếu dùng thuật ngữ “pool”, nên hiểu là tập shipment chờ được điều phối. Việc gom nhiều shipment thành chuyến thuộc Transport; không được làm sai quan hệ một order — tối đa một shipment của BRD.

### 2.3. SalesOrder đứng ở đâu trong luồng?

```text
Identity và quyền
        ↓
Master Data: khách hàng, địa chỉ, SKU, kho
        ↓
SalesOrder DRAFT
        ↓ yêu cầu xác nhận
Inventory kiểm tra và giữ TẤT CẢ dòng hàng
        ├─ thiếu hàng → PENDING_STOCK → chờ nhập/retry
        └─ đủ hàng → CONFIRMED
                         ↓
                 PICKING → READY_TO_SHIP
                         ↓
                    Trip dispatch
                         ↓
             IN_DELIVERY → COMPLETED / DELIVERY_FAILED
```

Order là điểm khởi đầu của chuỗi logistics. Nếu đơn chứa sai kho, sai địa chỉ hoặc sai số lượng thì các bước giữ hàng, chuẩn bị hàng và tối ưu tuyến đều có đầu vào sai.

### 2.4. Vai trò của AI

Theo đề cương, AI giúp diễn giải yêu cầu và điều phối công cụ; không thay thế business service.

- Người dùng vẫn phải tạo/quản lý đơn qua giao diện bình thường khi AI không hoạt động.
- Nếu Agent tạo draft, nó cũng phải sử dụng contract và validation của Order.
- Confirm/cancel qua Agent cần preview và xác nhận rõ ràng; không được ghi trực tiếp database.
- Dữ liệu order COMPLETED về sau phục vụ dự báo nhu cầu; đơn hủy không phải doanh số hoàn tất.

Vì vậy, **API nghiệp vụ đúng và độc lập với AI** là nền tảng cho Agent, không phải chờ Agent xong mới làm Order.

## 3. Hiện trạng code: đã có gì và chưa có gì?

### 3.1. Backend Order Service

| Thành phần | Bằng chứng | Hiện trạng và ý nghĩa |
|---|---|---|
| Khung ứng dụng | [AppModule](E:/GraduateProject/LogiX/LogiX-Backend/apps/order-service/src/app.module.ts) | Có config, logger, database và global exception filter. Chưa đăng ký module nghiệp vụ Order hoặc messaging trong module này. |
| HTTP controller | [AppController](E:/GraduateProject/LogiX/LogiX-Backend/apps/order-service/src/app.controller.ts), [AppService](E:/GraduateProject/LogiX/LogiX-Backend/apps/order-service/src/app.service.ts) | Chỉ có GET root trả `Hello World!`; chưa có API tạo/sửa/list/confirm/cancel order. |
| Bootstrap | [main.ts](E:/GraduateProject/LogiX/LogiX-Backend/apps/order-service/src/main.ts) | Cổng mặc định 3002, logger và shutdown hook. Chưa cấu hình prefix API/ValidationPipe trong file này. |
| Mô hình dữ liệu | [schema.prisma](E:/GraduateProject/LogiX/LogiX-Backend/apps/order-service/prisma/schema.prisma) | Có SalesOrder, OrderLine, OrderStatusHistory, OrderShortage, OutboxEvent và InboxEvent. Đây là nền persistence, chưa phải nghiệp vụ đang chạy. |
| Ràng buộc database | [Migration khởi tạo](E:/GraduateProject/LogiX/LogiX-Backend/apps/order-service/prisma/migrations/20260905130100_init_orders/migration.sql) | Có CHECK trạng thái/số lượng, unique mã đơn trong tenant, unique SKU trong đơn, partial index idempotency/FIFO/shortage. Một số ràng buộc SQL không thể suy ra chỉ từ Prisma schema. |
| Nền event persistence | [Migration lifecycle/event](E:/GraduateProject/LogiX/LogiX-Backend/apps/order-service/prisma/migrations/20260905134000_add_lifecycle_event_foundation/migration.sql) | Có bảng outbox/inbox và index. Chưa quan sát được Order publisher worker hay business consumer trong source Order. |
| Kiểm thử | [Unit test](E:/GraduateProject/LogiX/LogiX-Backend/apps/order-service/src/app.controller.spec.ts), [E2E test](E:/GraduateProject/LogiX/LogiX-Backend/apps/order-service/test/app.e2e-spec.ts) | Các test khảo sát chỉ kiểm tra `Hello World!`. Chưa chứng minh tenant isolation, state machine hoặc các thao tác Order. |

**Kết luận:** Order Service đang ở mức **scaffold + schema/migration**, không phải phân hệ CRUD hoàn chỉnh chỉ thiếu UI.

### 3.2. Gateway

[Gateway AppModule](E:/GraduateProject/LogiX/LogiX-Backend/apps/api-gateway/src/app.module.ts) hiện đăng ký proxy cho:

- Auth/IAM.
- Inventory.
- Customers, products, warehouses, vehicles.

Chưa có proxy Order được đăng ký trong module khảo sát.

Điều này có nghĩa: viết controller ở Order Service thôi chưa đủ để Frontend gọi qua Gateway. Task phải bao gồm đường đi request, context và lỗi upstream.

### 3.3. Các thành phần có thể tái sử dụng

**Master Data đã có phần nghiệp vụ thật:**

- [CustomersController](E:/GraduateProject/LogiX/LogiX-Backend/apps/master-data-service/src/master-data/customers/customers.controller.ts): tạo, list, detail, update, disable/enable.
- [CustomerAddressesController](E:/GraduateProject/LogiX/LogiX-Backend/apps/master-data-service/src/master-data/customers/customer-addresses.controller.ts): list/tạo/sửa/địa chỉ mặc định/disable/enable theo customer.
- [CustomerService](E:/GraduateProject/LogiX/LogiX-Backend/apps/master-data-service/src/master-data/customers/services/customer.service.ts): query có tenant scope; có dữ liệu trạng thái để chọn dữ liệu hợp lệ.
- Có các module products, warehouses và vehicles trong Master Data.

Order cần tham chiếu các ID này **qua API/contract**, không tạo lại một bảng Product/Customer riêng rồi coi đó là nguồn dữ liệu chính.

**Inventory đã có quản lý tồn, nhưng chưa có luồng Reservation hoàn chỉnh trong module khảo sát:**

- [InventoryModule](E:/GraduateProject/LogiX/LogiX-Backend/apps/inventory-service/src/inventory/inventory.module.ts) đăng ký balance, stock movement và stock receipt.
- [InventoryBalanceService](E:/GraduateProject/LogiX/LogiX-Backend/apps/inventory-service/src/inventory/services/inventory-balance.service.ts) có list/get tồn theo tenant, warehouse và product.
- [StockReceiptService](E:/GraduateProject/LogiX/LogiX-Backend/apps/inventory-service/src/inventory/services/stock-receipt.service.ts) tạo phiếu nhập trong transaction và xử lý replay bằng idempotency key.
- [StockMovementService](E:/GraduateProject/LogiX/LogiX-Backend/apps/inventory-service/src/inventory/services/stock-movement.service.ts) cập nhật balance/movement và ghi outbox trong cùng transaction.
- Chưa có ReservationService hoặc reservation controller được đăng ký trong InventoryModule khảo sát.

Không được dùng API “đọc available” thay cho “reserve”: số đọc được có thể bị đơn khác sử dụng ngay sau đó.

**Fulfillment:** [Source Fulfillment](E:/GraduateProject/LogiX/LogiX-Backend/apps/fulfillment-service/src) hiện có các file khung app/database/generated; chưa thấy module lifecycle Shipment trong cây source được khảo sát. Vì vậy chưa có căn cứ để coi luồng chuẩn bị/giao hàng đã sẵn sàng.

### 3.4. Frontend

| Thành phần | Bằng chứng | Kết luận |
|---|---|---|
| Feature hiện có | [features](E:/GraduateProject/LogiX/LogiX-Frontend/src/features) | Identity, master-data, inventory, chat; chưa có feature orders/shipment. |
| Workspace routes | [Workspace](<E:/GraduateProject/LogiX/LogiX-Frontend/src/app/(workspace)>) | Có inventory, master-data, organization, settings; chưa có route Orders/Shipment. |
| Menu | [AppSidebar](E:/GraduateProject/LogiX/LogiX-Frontend/src/components/shared/app-sidebar.tsx) | Có master-data và inventory; chưa có link màn hình Order thật. |
| Chặn route theo quyền | [WorkspaceGuard](E:/GraduateProject/LogiX/LogiX-Frontend/src/components/shared/workspace-guard.tsx) | Đã có rule `/orders` với `order:sales-order:read` hoặc `order:sales-order:create`. Đây là chuẩn bị quyền ở UI, không phải màn hình/API đã tồn tại. |
| Khách hàng/địa chỉ | [customers.api.ts](E:/GraduateProject/LogiX/LogiX-Frontend/src/features/master-data/api/customers.api.ts) | Có hàm API cho customer và address, kèm parse schema. Có thể tái sử dụng cho form đơn. Chưa có route khách hàng riêng trong workspace được khảo sát. |
| Transport dùng chung | [http-client.ts](E:/GraduateProject/LogiX/LogiX-Frontend/src/lib/api/http-client.ts) | Có authFetch, token sessionStorage, refresh single-flight và xử lý response. Không nên thêm cơ chế token/refresh riêng cho Orders. |
| Quy tắc contract | [Frontend API Contract](E:/GraduateProject/LogiX/LogiX-Frontend/docs/product/frontend-api-contract.md) | Feature API sở hữu mapping; UI không sở hữu business rule; sensitive action cần preview/xác nhận. Không suy diễn DTO từ mock. |

**Lưu ý phân quyền:** Rule route ở UI chỉ hỗ trợ UX. Backend vẫn phải kiểm tra quyền cho từng command. Thư viện [libs/auth](E:/GraduateProject/LogiX/LogiX-Backend/libs/auth/src) có guard/decorator, và Inventory đã sử dụng PermissionsGuard. Danh sách permission chính thức và cách gán role cho Order phải được đối chiếu trước khi triển khai; không suy ra quyền thao tác chỉ từ nhãn “Order Staff”.

## 4. User Scenarios & Testing — người dùng cần làm được gì?

### 4.1. P1 — Tạo bản nháp đơn hàng

**Người dùng:** Order Staff có quyền tạo đơn.  
**Mục đích:** Ghi nhận một yêu cầu giao hàng hợp lệ, chưa cam kết giữ hàng.

Luồng:

1. Mở Quản lý đơn hàng, chọn tạo mới.
2. Chọn customer đang hoạt động.
3. Chọn một địa chỉ giao thuộc customer đó.
4. Chọn một warehouse.
5. Chọn một hoặc nhiều SKU và nhập quantity.
6. Xem tổng quantity/weight/volume, lưu bản nháp.
7. Xem detail với trạng thái DRAFT.

**Nghiệm thu độc lập:**

- Given người dùng có quyền và dữ liệu nền hợp lệ, When lưu đơn, Then có một DRAFT và đúng các dòng hàng; tồn kho chưa thay đổi.
- Given địa chỉ không thuộc customer, When gửi request trực tiếp, Then Backend từ chối và không tạo đơn.
- Given quantity bằng 0 hoặc âm, When lưu, Then hiển thị lỗi tương ứng và không có bản ghi đơn dở dang.

### 4.2. P1 — Tìm, xem và sửa đơn

Người dùng tìm theo mã/customer/warehouse/status/thời gian; mở detail; sửa khi trạng thái và reservation cho phép.

**Nghiệm thu độc lập:**

- Given có nhiều đơn, When áp dụng bộ lọc và chuyển trang, Then kết quả/pagination nhất quán với bộ lọc.
- Given DRAFT chưa có reservation, When sửa SKU/quantity/kho, Then Backend validation lại và tính lại tổng.
- Given hai người mở cùng version, When người thứ hai lưu sau người thứ nhất, Then nhận conflict rõ ràng; không ghi đè âm thầm.

### 4.3. P1 — Yêu cầu xác nhận đơn

Người dùng xem preview, xác nhận hành động; Inventory quyết định có thể giữ toàn bộ hàng hay không.

**Nghiệm thu khi Reservation đã tích hợp:**

- Given đủ available cho mọi dòng, When xác nhận, Then toàn bộ dòng được giữ đúng một lần và Order trở thành CONFIRMED.
- Given thiếu một SKU, When xác nhận, Then không giữ bất kỳ dòng nào; Order trở thành PENDING_STOCK và hiển thị thiếu hàng.
- Given Inventory lỗi kết nối, When yêu cầu xác nhận, Then UI không báo “đã xác nhận”, và hệ thống không tự coi đó là “thiếu hàng”.

**Giá trị độc lập:** Tạo/xem/sửa draft có thể bàn giao trước. Confirm là một luồng tích hợp, không phải nút đổi `status`.

### 4.4. P1 — Hủy hợp lệ

- Given DRAFT chưa giữ hàng, When người có quyền xác nhận hủy, Then Order CANCELED và có lịch sử.
- Given đơn đã giữ hàng nhưng chưa dispatch, When hủy, Then chỉ coi toàn bộ luồng hủy hoàn tất khi reservation được giải phóng và shipment liên quan xử lý hợp lệ.
- Given đã dispatch, When gọi cancel dù qua API trực tiếp, Then Backend từ chối; giao thất bại không phải hủy đơn.

### 4.5. P2 — Theo dõi thiếu hàng và lịch sử

- Given PENDING_STOCK, When mở detail, Then biết SKU nào thiếu, required/available snapshot và thời điểm kiểm tra.
- Given order có nhiều lần đổi trạng thái, When xem timeline, Then thấy thứ tự, actor, thời điểm và lý do phù hợp.
- Given nhập thêm hàng, When task Reservation/async đã hoạt động, Then retry theo FIFO và cập nhật UI từ trạng thái Backend thực.

## 5. Requirements — phạm vi và yêu cầu

### 5.1. Phân pha để tránh “hoàn thành giả”

| Phần | Nằm trong task gộp này | Phụ thuộc |
|---|---|---|
| Tạo/list/detail/sửa draft | Hoàn thiện Backend + Frontend end-to-end | Master Data, Identity, Gateway |
| Hủy draft chưa reservation | Hoàn thiện end-to-end | State machine, authorization |
| Confirm/retry/hiển thị thiếu hàng | Order command, mapping và UI thuộc task này; nghiệm thu tích hợp cùng Reservation | Giữ hàng transaction, contract kết quả, async |
| Hủy sau giữ hàng | Order-side command/UI; hoàn tất cùng luồng release và Fulfillment | Reservation release, shipment cancellation |
| Timeline lifecycle sau xác nhận | Thiết kế contract/projection; chỉ cập nhật từ kết quả service sở hữu | Fulfillment/Transport |
| Màn hình Shipment/Shipment Pool đầy đủ | Để task Fulfillment/Shipment sau | Shipment API/lifecycle |

Không tách việc tích hợp khỏi trách nhiệm bàn giao: milestone đầu chỉ được gọi là **Order Draft MVP**, không gọi “Sales Order hoàn chỉnh” nếu confirm/cancel có reservation chưa chạy được.

### 5.2. Functional Requirements

| ID | Yêu cầu có thể kiểm thử | Căn cứ | Phân pha |
|---|---|---|---|
| REQ-001 | Chỉ người có quyền được thao tác; mọi đọc/ghi được kiểm tra tenant ở Backend, kể cả ID biết trước. | BR-TEN-001/005; NFR-SEC-001/002 | Ngay |
| REQ-002 | Tạo DRAFT có một customer, một delivery address thuộc customer, một warehouse, một currency; ít nhất một SKU với quantity dương. | FR-ORD-001; BR-ORD-001 | Ngay |
| REQ-003 | Không cho đơn lấy từ nhiều kho, giao một phần hoặc tạo nhiều dòng trùng product trái với ràng buộc dữ liệu. | BR-ORD-002; unique OrderLine | Ngay |
| REQ-004 | Kiểm tra customer/address/product/warehouse theo tenant và trạng thái sử dụng; Backend không tin snapshot/tổng do trình duyệt gửi. | BR-TEN-001/004/005; BR-ORD-005 | Ngay |
| REQ-005 | Backend lưu SKU/name/unit snapshot và tính total quantity/weight/volume nhất quán từ các dòng. | BRD 6.2; schema OrderLine | Ngay |
| REQ-006 | Mã đơn duy nhất trong tenant; replay cùng lệnh tạo hợp lệ không sinh đơn thứ hai, xung đột payload được xử lý rõ ràng theo contract. | BR-TEN-003; NFR-REL-001 | Ngay |
| REQ-007 | Tìm/lọc theo mã, customer, warehouse, status và thời gian; phân trang ổn định. | FR-ORD-005 | Ngay |
| REQ-008 | Xem detail và lịch sử trạng thái; timeline không được coi là thay thế toàn bộ Audit Service. | BRD 8.1; OrderStatusHistory; NFR-AUD-001 | Ngay |
| REQ-009 | Chỉ sửa customer/address/warehouse/quantity khi DRAFT hoặc PENDING_STOCK và chưa có reservation; validation lại sau sửa. | BR-ORD-005 | DRAFT ngay; pending cùng Reservation |
| REQ-010 | Command sửa/đổi trạng thái kiểm tra version; conflict không ghi đè hoặc làm lùi trạng thái. | NFR-DAT-001 | Ngay |
| REQ-011 | Confirm có preview và xác nhận rõ ràng; chỉ chuyển CONFIRMED sau khi Inventory xác nhận giữ đủ mọi dòng. | FR-ORD-002; BR-ORD-003; contract Frontend | Tích hợp Reservation |
| REQ-012 | Thiếu bất kỳ SKU nào thì không giữ dòng nào; chuyển PENDING_STOCK và lưu/hiển thị thiếu hàng. | FR-ORD-003; BR-ORD-003/004 | Tích hợp Reservation |
| REQ-013 | Retry pending theo FIFO khi nhận hàng hoặc thao tác có quyền; event trùng không gây giữ hàng nhiều lần. | BR-ORD-004; NFR-REL-001 | Tích hợp async |
| REQ-014 | Hủy chỉ trước dispatch; nếu đã reservation thì giải phóng; sau dispatch từ chối cancel. | FR-ORD-004; BR-ORD-006 | Draft ngay; còn lại tích hợp |
| REQ-015 | Không cho người dùng tùy ý gán PICKING/READY/IN_DELIVERY/COMPLETED; COMPLETED chỉ sau shipment DELIVERED. | BR-ORD-007; BRD 8.1 | Tích hợp lifecycle |
| REQ-016 | Business change và bản ghi history/outbox liên quan được lưu nguyên tử trong database của service sở hữu. | Thiết kế database/event; NFR-REL-001 | Nền ngay, xử lý event liên task |
| REQ-017 | UI có loading/empty/error/no-permission, lỗi theo trường, cảnh báo conflict và retry phù hợp; thất bại không hiện thành công. | Contract Frontend; NFR-REL-002 | Ngay |
| REQ-018 | Đơn hàng dùng được qua UI/API khi AI/model không hoạt động; Agent không có quyền cao hơn user. | Đề cương; BRD 6.5; NFR-SEC-002 | Ngay |
| REQ-019 | Confirm/cancel gửi lặp hoặc event sai thứ tự không tạo reservation/shipment hoặc side effect kép. | NFR-REL-001; NFR-DAT-001 | Tích hợp |
| REQ-020 | Trạng thái hiển thị và nút hành động phản ánh kết quả Backend thực, có đủ tiếng Việt/Anh theo cơ chế i18n hiện có. | State machine BRD; mẫu Frontend | Ngay và tích hợp |

### 5.3. Ngoài phạm vi

Không tự đưa vào task:

- Payment, công nợ, hóa đơn, thuế, khuyến mãi, chiết khấu.
- Giá bán/tổng tiền nếu chưa có quyết định nghiệp vụ riêng.
- Đơn đa kho, partial reservation, partial fulfillment/split order.
- 3PL, reverse logistics, hoàn hàng sâu, live GPS/geofencing.
- Tự động tạo đơn từ forecast.
- Triển khai lại IAM, Product hoặc Warehouse.
- Toàn bộ trip/route/dispatch UI và AI tool orchestration.

Currency có trong schema **không chứng minh đã có nghiệp vụ tính tiền**. OrderLine hiện không có unitPrice; không nên vẽ form giá rồi ép Backend theo mock.

### 5.4. Key Entities — dữ liệu trọng tâm

| Entity | Ý nghĩa | Những thuộc tính cần hiểu |
|---|---|---|
| SalesOrder | Header của yêu cầu bán/giao | tenant, orderNumber, customerId, deliveryAddressId, warehouseId, currency, status, totals, version, timestamps |
| OrderLine | Một sản phẩm trong đơn | productId, quantity, SKU/name/unit snapshot, unitWeight, unitVolume |
| OrderStatusHistory | Timeline của đơn | from/to, actor, reason, correlationId, orderVersion |
| OrderShortage | Snapshot thiếu hàng | requiredQuantity, availableQuantity, warehouse/product, detected/resolved |
| OutboxEvent | Sự kiện đã cam kết trong database, chờ publish | type/version, aggregate/version, correlation, payload, attempts, publishedAt |
| InboxEvent | Dấu đã xử lý event | eventId, consumerName, outcome, aggregateVersion |

Customer/Product/Warehouse và reservation là **tham chiếu liên service**, không phải entity Order sở hữu.

## 6. Quy tắc nghiệp vụ giải thích bằng ví dụ

### 6.1. Reserve khác xuất kho

Kho có SKU A: `on_hand = 100`, `reserved = 20`, nên `available = 80`.

Đơn mới cần 30 A:

- Lưu DRAFT: các số tồn không đổi.
- Reserve thành công: `on_hand = 100`, `reserved = 50`, `available = 50`.
- Dispatch và xuất đúng 30: `on_hand = 70`, `reserved = 20`, `available = 50`.
- Nếu hủy trước dispatch thay vì xuất: `on_hand = 100`, `reserved = 20`, `available = 80`.

Confirm không được trừ on-hand. Việc xuất kho đúng một lần khi dispatch thuộc luồng Inventory/Transport.

### 6.2. All-or-nothing

Đơn cần A: 30, B: 10; available A: 80, B: 5.

**Kết quả BRD yêu cầu:** đơn PENDING_STOCK; A không được giữ 30, B không được giữ 5. Không có “PARTIAL” như một kết quả giữ hàng MVP.

Khi B được nhập thêm, hệ thống xét lại toàn bộ đơn theo FIFO. Available của A tại lúc retry có thể đã khác; không được dựa vào số đọc ở lần trước.

### 6.3. Snapshot và tổng

Ví dụ hai dòng:

| SKU | Quantity | Weight/đơn vị | Volume/đơn vị |
|---|---:|---:|---:|
| A | 10 | 2 | 0,01 |
| B | 5 | 3 | 0,02 |

Tổng quantity = 15; tổng weight = 35; tổng volume = 0,20 theo đơn vị dữ liệu nền đã thống nhất.

Snapshot lưu lại thông tin cần thiết của sản phẩm trong đơn; thay đổi tên sản phẩm sau này không được âm thầm làm sai lịch sử đơn đã chốt. Chính sách refresh snapshot khi sửa draft/cập nhật master data cần được quy định, không để UI và Backend mỗi bên hiểu một kiểu.

Decimal và BigInt trong Prisma không nên được đưa thẳng sang JSON DTO. Contract phải quyết định representation; code Master Data hiện trả weight/volume dưới dạng chuỗi để bảo toàn độ chính xác. Frontend có thể tính preview, nhưng Backend là nguồn quyết định tổng đã lưu.

## 7. State machine — trạng thái không chỉ là nhãn UI

| Trạng thái BRD | Ý nghĩa | Ai/điều gì làm chuyển tiếp | Chuyển tiếp cho phép |
|---|---|---|---|
| DRAFT | Đơn nháp, chưa giữ hàng | Order Staff yêu cầu xác nhận/hủy | PENDING_STOCK, CONFIRMED, CANCELED |
| PENDING_STOCK | Đã yêu cầu xác nhận nhưng thiếu hàng | Retry có quyền hoặc hệ thống | CONFIRMED, CANCELED |
| CONFIRMED | Đã giữ đủ toàn bộ hàng | Fulfillment bắt đầu chuẩn bị | PICKING, CANCELED |
| PICKING | Đang chuẩn bị hàng | Warehouse Staff | READY_TO_SHIP, CANCELED |
| READY_TO_SHIP | Shipment sẵn sàng | Dispatch hợp lệ | IN_DELIVERY, CANCELED |
| IN_DELIVERY | Đã dispatch | Kết quả giao hàng | COMPLETED, DELIVERY_FAILED |
| DELIVERY_FAILED | Giao thất bại, chờ giao lại | Điều phối chuyến lại | IN_DELIVERY |
| COMPLETED | Shipment delivered | System | Kết thúc |
| CANCELED | Hủy trước dispatch | Order Staff/System theo luồng hủy | Kết thúc |

Frontend không cung cấp một dropdown “chọn bất kỳ trạng thái”. Nó hiển thị command hợp lệ: lưu, yêu cầu xác nhận, retry, hủy. Các trạng thái sau đến từ service/event sở hữu nghiệp vụ.

PENDING_STOCK được sửa khi chưa reservation theo BR-ORD-005, nhưng không tự suy ra thao tác đó sẽ chuyển về DRAFT. Policy trạng thái và vị trí FIFO sau sửa cần được chốt.

## 8. Frontend cần những màn hình nào?

### 8.1. Danh sách đơn hàng

Đề xuất màn hình Orders gồm:

- Mã đơn, customer, warehouse, trạng thái, thời điểm tạo và tổng quantity/weight/volume cần thiết.
- Tìm mã; lọc customer/kho/trạng thái/khoảng thời gian; phân trang.
- Nút tạo mới theo quyền.
- Loading, danh sách rỗng, lỗi kết nối và retry.
- Điều hướng detail; không chỉ là bảng mock.

### 8.2. Form tạo/sửa

- Customer selector; chọn lại customer thì địa chỉ cũ phải được xóa hoặc kiểm tra lại.
- Address selector chỉ hiển thị địa chỉ của customer đã chọn.
- Warehouse selector đúng một kho.
- Product selector và quantity; xử lý SKU trùng bằng chính sách đã chốt.
- Preview tổng tải; không mặc định “tổng tiền”.
- Chặn gửi lặp khi đang submit; không thay thế Backend idempotency.
- Hiển thị lỗi dữ liệu nền đã bị disable/version thay đổi kể từ lúc mở form.
- Không mất dữ liệu nhập chỉ vì một request thất bại.

Nếu chưa có màn hình quản lý customer, có thể chọn từ dữ liệu đã có qua API; việc bổ sung CRUD customer UI là dependency riêng nếu demo yêu cầu người dùng tự tạo khách hàng.

### 8.3. Detail và lịch sử

- Header đơn, customer/address/kho, trạng thái.
- Lines và snapshot, totals.
- Timeline.
- Shortage khi pending.
- Nút theo quyền và trạng thái.
- Shipment liên quan chỉ hiển thị từ contract đã có; không tạo số shipment giả để “đủ giao diện”.

### 8.4. Preview confirm/cancel

Preview cho người dùng kiểm tra nội dung, kho, quantity và tác động. Kết quả đọc available tại preview chỉ có tính tham khảo; bước thực thi vẫn phải lock/reserve đúng ở Inventory.

Nếu backend xử lý bất đồng bộ, UI phân biệt “đã tiếp nhận yêu cầu” với “đã giữ đủ hàng”. Cách biểu diễn command pending, polling/subscription và timeout là contract cần chốt.

## 9. Backend cần bổ sung những phần nào?

Phần này là **bản đồ khoảng trống triển khai**, không phải API specification đã phê duyệt.

1. **Order domain/module:** command/query, validation, state transition, mapper và persistence theo mẫu service hiện có; không dồn hết vào AppService.
2. **Authentication và authorization:** lấy tenant/user từ context xác thực; dùng cơ chế guard/permission hiện có; không tin tenantId do người dùng tự gửi.
3. **Master Data integration:** xác minh customer-address relation, tenant, status và dữ liệu sản phẩm/kho qua contract; lỗi upstream phải rõ ràng.
4. **Draft transaction:** lưu header/lines/totals/history/outbox liên quan nguyên tử.
5. **List/detail/filter:** chỉ dữ liệu tenant hiện tại, stable paging, error envelope và response mapping.
6. **Version/idempotency:** tránh double create và lost update; quy định replay với payload khác.
7. **Gateway:** expose contract Order và forward context/error/timeout nhất quán.
8. **Reservation adapter/contract:** gửi toàn bộ dòng, nhận kết quả đủ/thiếu/lỗi; không truy cập inventory database trực tiếp.
9. **Lifecycle integration:** xử lý reserve/release/fulfillment/delivery idempotently, không làm lùi trạng thái.
10. **Outbox/inbox execution:** bảng có sẵn nhưng vẫn phải có publisher/consumer/retry và bằng chứng hoạt động.
11. **Kiểm thử nghiệp vụ:** thay coverage chỉ `Hello World!` bằng các scenario có ý nghĩa.

Contract cần bao phủ các operation: create draft, list, detail, update, history, preview/confirm, cancel và retry pending. Tên URL, HTTP method, DTO, error code và response command chưa được coi là có sẵn chỉ vì tài liệu này liệt kê operation.

## 10. Những điểm cần chốt trước khi implement đầy đủ

### 10.1. Confirmed event và yêu cầu giữ hàng

**[NEEDS CLARIFICATION: Chốt contract orchestration xác nhận — intent/command trung gian và event kết quả cụ thể là gì?]**

Có độ lệch trong tài liệu:

- BRD và event catalogue: CONFIRMED nghĩa là đã giữ đủ; `OrderConfirmed` bắt đầu fulfillment.
- Bảng mapping tại mục 17 của database design lại ghi `OrderConfirmed` vào Inventory inbox + reservation transaction.
- Mục 18.1 cùng tài liệu mô tả ghi intent, Inventory xử lý, Order nhận kết quả rồi chuyển CONFIRMED/PENDING_STOCK.

Không được publish “đã confirmed” trước khi giữ đủ hàng rồi để Fulfillment hiểu sai. Cần thống nhất contract/ADR; nếu thêm trạng thái kỹ thuật, phải phân biệt với 9 trạng thái nghiệp vụ BRD và cập nhật những nơi liên quan.

### 10.2. FIFO sau yêu cầu xác nhận/sửa pending

**[NEEDS CLARIFICATION: `confirmed_at` dùng thời điểm yêu cầu xác nhận hay thời điểm reserve thành công; sửa đơn pending có mất vị trí FIFO không?]**

BRD dùng `confirmed_at` để retry pending, trong khi CONFIRMED lại là trạng thái sau khi reserve thành công. Nếu đợi reserve xong mới điền trường này thì đơn pending có thể không có khóa thời gian để xếp hàng.

Cần quyết định rõ thời điểm lưu, tie-break và hành vi sau sửa; không tự đổi tên field hoặc chính sách ưu tiên trong quá trình code.

### 10.3. Chính sách hủy giao tranh với dispatch

**[NEEDS CLARIFICATION: Service nào quyết định thắng/thua và phục hồi khi cancel đua với dispatch, hoặc release reservation thành công nhưng Order update thất bại?]**

Đây là giao dịch liên service, không có một transaction PostgreSQL bao trùm mọi database. Chỉ kiểm tra status ở UI không ngăn được race.

Thiết kế cần chứng minh không có trạng thái vừa báo hủy vừa xuất kho, và có retry/reconciliation rõ ràng cho lỗi từng bước.

### 10.4. Các khoảng trống contract phải rà soát

- `OrderCreatedPayload` trong [shared events](E:/GraduateProject/LogiX/LogiX-Backend/libs/messaging/src/interfaces/domain-event.interface.ts) yêu cầu `unitPrice`, nhưng OrderLine schema không có giá. Cần điều chỉnh contract được chấp thuận, không tự gán giá 0 hoặc thêm payment scope.
- `StockReceivedPayload` dùng receiptId và items, trong khi outbox hiện ghi theo StockMovement/InventoryBalance với payload khác. Retry FIFO phải bám contract thực được thống nhất, không chỉ import một TypeScript interface rồi cho rằng đã tương thích.
- Có outbox record không đồng nghĩa Kafka đã nhận event hoặc consumer đã xử lý; cần xác minh publisher và consumer ở task async.
- Trạng thái schema là String với CHECK trong SQL; ứng dụng vẫn phải enforce transition, tenant và permission.
- Frontend contract còn ghi auth transport là vấn đề cần quyết định, trong khi code hiện dùng bearer token/sessionStorage. Khi làm Order nên reuse hiện trạng được xác minh và làm rõ lệch tài liệu, không tự tạo cơ chế thứ hai.
- Currency có trong Order nhưng nguồn cấu hình currency tenant phải được xác minh từ contract Identity/config.

## 11. Thứ tự thực hiện đề xuất

### Milestone A — Contract và dữ liệu nền

Chốt operation/DTO/error/permission/version/idempotency; xác minh customer/address/product/warehouse API và policy currency. Đồng thời chốt ba vấn đề lớn ở mục 10 trước phần tích hợp.

**Kết quả:** Frontend và Backend nói cùng một ngôn ngữ; không tự suy response từ UI.

### Milestone B — Order Draft MVP

Backend tạo/list/detail/sửa/hủy draft, tenant/RBAC/transaction/history; Gateway expose API; Frontend menu/list/form/detail/i18n và lỗi.

**Demo độc lập:** đăng nhập → chọn customer/address/kho/SKU → lưu → tìm/xem → sửa → hủy; tồn không đổi.

### Milestone C — Tích hợp Reservation

Order command/preview → Inventory reserve all-or-nothing → trạng thái confirmed/pending → UI/shortage. Thêm retry và release theo contract.

**Demo:** đơn đủ hàng, đơn thiếu một SKU, gửi trùng, cạnh tranh cùng tồn, nhập thêm và FIFO, hủy giải phóng.

### Milestone D — Kết nối Fulfillment/Shipment

Theo dõi picking/ready/shipment/delivery từ service sở hữu; bổ sung Shipment UI trong task Shipment. Không tự gán COMPLETED để demo nhanh.

Nhóm có thể làm UI draft và Backend draft song song **sau khi contract được chấp thuận**. Không cần chờ toàn bộ Shipment, Transport hoặc AI mới bàn giao Milestone B.

## 12. Success Criteria — thế nào mới được coi là hoàn thành?

### 12.1. Order Draft MVP

- **SC-001:** Tất cả case tạo/xem/tìm/sửa/hủy draft ở mục 4.1–4.2 và case hủy draft 4.4 chạy thành công qua UI và API thật trên bộ dữ liệu kiểm thử.
- **SC-002:** Người tenant A không đọc/sửa/hủy đơn tenant B trong 100% negative case đã liệt kê; mã giống nhau giữa tenant vẫn được phép.
- **SC-003:** Gửi lại cùng yêu cầu tạo 10 lần theo contract chỉ có một đơn; hai lần sửa đồng thời không mất bản cập nhật.
- **SC-004:** Lưu/sửa/hủy draft không thay đổi on-hand hoặc reserved.
- **SC-005:** Mỗi hành động nghiệp vụ thành công có timeline và thông tin truy vết đúng; không có header thành công nhưng thiếu lines sau lỗi transaction.
- **SC-006:** UI hiện đủ loading/empty/error/forbidden/conflict; không có case thất bại hiển thị toast thành công.
- **SC-007:** Người dùng thực hiện toàn bộ flow draft khi AI bị tắt.

### 12.2. Order hoàn chỉnh sau tích hợp

- **SC-008:** Các case đủ hàng/thiếu hàng/hủy trước dispatch của BRD `AT-02`, `AT-03`, `AT-04` đạt; không reservation một phần.
- **SC-009:** Command/event replay không thêm reservation, shipment hoặc xuất kho lần hai.
- **SC-010:** Cancel sau dispatch bị từ chối; delivery failed không chuyển thành canceled; completed chỉ theo shipment delivered.
- **SC-011:** Lỗi Inventory/Kafka/consumer có dấu vết và cơ chế phục hồi theo contract; trạng thái không lùi khi event tới sai thứ tự.
- **SC-012:** Đo mục tiêu BRD: p95 thao tác API nghiệp vụ ≤ 2 giây ở 100 virtual users/10 phút; p95 publish → business effect ≤ 3 giây trên benchmark công bố. Đây là mục tiêu Should cần đo, không phải kết quả đã đạt.

### 12.3. Bộ kiểm thử tối thiểu cần có

| Nhóm | Case trọng tâm |
|---|---|
| Dữ liệu | Không line, quantity 0/âm, SKU trùng, address sai customer, inactive/cross-tenant master data, tổng tải sai từ client |
| State machine | Sửa DRAFT/pending hợp lệ; chặn sửa khi reserved; chặn jump trạng thái; hủy sau dispatch |
| Quyền | Không token, hết phiên, chỉ read, không create/confirm/cancel, truy cập ID khác tenant |
| Cạnh tranh | Lost update, double submit, hai đơn tranh một balance, cancel/dispatch race |
| Tích hợp | Đủ hàng, thiếu một SKU, retry FIFO, release, upstream timeout, replay và out-of-order |
| UI | Filter/paging, chọn customer đổi address, conflict giữ form, preview/confirm, loading/empty/error, responsive, tiếng Việt/Anh |
| Phục hồi | Crash giữa business change/publish; event đã xử lý nhưng ack mất; reserve thành công nhưng Order chưa cập nhật |

Lệnh lint/typecheck/test/build chứng minh từng lớp kỹ thuật, không thay thế kiểm thử browser/API/transaction. Build Frontend ở lượt xử lý Git trước đã pass, nhưng không chứng minh các luồng Order chưa được triển khai.

## 13. Assumptions — giả định được công khai

- Task dùng mô hình B2B nội bộ và guardrail MVP hiện có, không thêm e-commerce scope.
- Màn hình Orders có một điểm truy cập ở workspace; cách tổ chức page/dialog cụ thể là quyết định UI sau, không ảnh hưởng yêu cầu nghiệp vụ.
- Bộ dữ liệu test có customer/address/product/warehouse hợp lệ; nếu chưa có thì phải bổ sung setup fixture hoặc quy trình chuẩn bị riêng.
- Chính sách SKU trùng phải chọn rõ giữa merge trước gửi hoặc báo lỗi; persistence hiện yêu cầu một product một dòng trong đơn.
- Không thay cơ chế auth/token trong task này trừ khi có quyết định riêng.
- Các mục performance là mục tiêu từ BRD; thời gian người dùng nhập form không được tự đặt thành cam kết nếu chưa đo.
- Các vấn đề contract mục 10 được xử lý trước khi nghiệm thu tích hợp; không dùng giả lập “reserve thành công” trong sản phẩm thật.

## 14. Tóm tắt để trao đổi với nhóm

> **Tên task:** Xây dựng phân hệ Quản lý đơn hàng Backend + Frontend.
>
> **Mục tiêu:** Cho phép người dùng có quyền tạo, tra cứu, sửa đơn đúng điều kiện, yêu cầu xác nhận và hủy hợp lệ; theo dõi trạng thái đơn theo BRD trong đúng tenant.
>
> **Hiện trạng:** Có khung Order Service, schema/migration và shared event types; chưa có Order business API, Gateway routing và màn hình Orders. Master Data/Inventory/Identity/Frontend shell là nền để tái sử dụng, không phải toàn bộ tích hợp đã hoàn thành.
>
> **Bàn giao đầu tiên:** Order Draft MVP chạy thật end-to-end.
>
> **Điểm nối quan trọng:** Confirm không phải đổi nhãn status; phải reserve toàn bộ hàng ở Inventory. Cancel sau reserve phải release, và dispatch là ranh giới không được hủy.
>
> **Không được làm:** Partial reservation, đơn nhiều kho, một shipment gộp nhiều order, tự gán COMPLETED, tự mở scope payment hoặc phụ thuộc AI để core flow hoạt động.
>
> **Điều kiện hoàn thành toàn task:** Contract thống nhất, test nghiệp vụ đạt và các luồng Reservation/Fulfillment cần thiết có bằng chứng tích hợp. Không tuyên bố hoàn thành chỉ vì schema, nút UI hoặc build đã có.
