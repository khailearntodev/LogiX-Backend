BỘ GIÁO DỤC VÀ ĐÀO TẠO
TRƯỜNG ĐẠI HỌC CÔNG NGHỆ THÔNG TIN
KHOA CÔNG NGHỆ PHẦN MỀM
 
BUSINESS REQUIREMENTS DOCUMENT
ĐỀ TÀI: XÂY DỰNG NỀN TẢNG LOGISTICS VÀ QUẢN LÝ CHUỖI CUNG ỨNG THÔNG MINH TÍCH HỢP AGENTIC AI. 

Nhóm thực hiện: 
-	Nguyễn Quang Khải (23520677) 
-	Lê Bùi Quốc Huy (23520610)
Cán bộ hướng dẫn: TS. Đỗ Thị Thanh Tuyền.
Thời gian phát triển: 01/09/2026 - 30/12/2026.
 
Kiểm soát Cấu trúc tài liệu
●	Bối cảnh, mục tiêu và phạm vi kinh doanh.
●	Stakeholder, vai trò và quyền nghiệp vụ.
●	Mô hình miền, quy trình Order-to-Delivery và các trạng thái.
●	Business rule, yêu cầu chức năng, sự kiện nghiệp vụ và yêu cầu AI.
●	Yêu cầu phi chức năng, tiêu chí nghiệm thu, rủi ro và truy vết mục tiêu.
1. Tóm tắt điều hành
Sản phẩm là một nền tảng multi-tenant dành cho doanh nghiệp phân phối B2B có kho và đội giao hàng riêng. Nền tảng liên kết các nghiệp vụ đơn hàng, tồn kho, chuẩn bị hàng, shipment, điều phối chuyến giao và theo dõi kết quả giao hàng. Lớp Agentic AI hỗ trợ người dùng bằng ngôn ngữ tự nhiên, nhưng không thay thế các thành phần tính toán có thể kiểm chứng.
Nguyên tắc sản phẩm: Luồng logistics lõi phải chạy độc lập khi AI hoặc dịch vụ mô hình không sẵn sàng. LLM chỉ phân tích ý định và điều phối; dự báo do mô hình chuỗi thời gian thực hiện, tối ưu tuyến do bộ giải tối ưu thực hiện, và quyết định vận hành quan trọng phải được con người phê duyệt.
1.1 Vấn đề cần giải quyết
●	Dữ liệu đơn hàng, tồn kho và vận chuyển phân tán, khó theo dõi xuyên suốt.
●	Xử lý tồn kho thiếu và điều phối giao hàng phụ thuộc nhiều vào thao tác thủ công.
●	Doanh nghiệp thiếu công cụ dự báo nhu cầu theo sản phẩm và kho.
●	Thứ tự giao nhiều điểm chưa được tối ưu theo tải trọng và khoảng cách.
●	Khó truy vết quyết định AI, sự kiện bất đồng bộ và thao tác nhạy cảm trong môi trường nhiều tenant.
1.2 Trạng thái mục tiêu
●	Mọi nghiệp vụ từ xác nhận đơn đến hoàn tất giao hàng được theo dõi bằng trạng thái rõ ràng.
●	Tồn kho được quản lý theo công thức on-hand, reserved và available; không cho phép âm kho.
●	Điều phối viên tạo chuyến từ nhiều shipment, nhận tuyến đề xuất và chủ động phê duyệt.
●	Quản lý xem được dashboard vận hành, cảnh báo thiếu hàng và kết quả AI.
●	Mỗi tool call, thay đổi trạng thái quan trọng và lỗi xử lý được audit theo tenant và người dùng.
2. Bối cảnh và mục tiêu kinh doanh
2.1 Hồ sơ doanh nghiệp giả định
Thành phần	Định nghĩa baseline
Loại hình	Doanh nghiệp phân phối hàng tiêu dùng đóng gói theo mô hình B2B.
Khách hàng	Cửa hàng, đại lý và điểm bán lẻ; chưa có tài khoản tự phục vụ trong MVP.
Kho	Một hoặc nhiều kho; mỗi đơn được thực hiện toàn bộ từ đúng một kho.
Đội xe	Phương tiện và tài xế nội bộ; chưa hỗ trợ sàn vận tải hay đối tác 3PL.
Hàng hóa	SKU theo đơn vị cơ sở, trọng lượng và thể tích; không quản lý lô, hạn dùng hay cold-chain.
Tenant	Một doanh nghiệp phân phối độc lập, có dữ liệu, người dùng, cấu hình và công cụ AI tách biệt.

 
Hình 1. Bối cảnh nghiệp vụ mục tiêu
2.2 Mục tiêu và chỉ số thành công
ID	Mục tiêu	Chỉ số nghiệm thu	Ưu tiên
BO-01	Chuẩn hóa luồng Order-to-Delivery	Các bước trong kịch bản demo có trạng thái và audit truy vết được.	Must
BO-02	Bảo đảm tính đúng của tồn kho	Không âm kho; sự kiện trùng không tạo tác động kép; hủy trước xuất kho giải phóng reservation.	Must
BO-03	Hỗ trợ dự báo nhu cầu	Báo cáo và so sánh tối thiểu với baseline trung bình trượt hoặc naive forecast.	Must
BO-04	Tối ưu hoạt động giao hàng	Đo mức giảm tổng quãng đường/chi phí so với thứ tự nhập hoặc nearest-neighbor baseline.	Must
BO-05	Agent thực thi đáng tin cậy	Tool Success Rate tối thiểu 90% trên tập kịch bản đã khóa; thao tác ghi cần xác nhận.	Must
BO-06	Cách ly tenant	Không có truy cập chéo tenant trong bộ negative test và mọi truy vấn nghiệp vụ gắn tenant context.	Must
BO-07	Chứng minh khả năng mở rộng	Có bằng chứng load test, event latency và ít nhất một kịch bản scale-out trong môi trường thử nghiệm.	Should
BO-08	Mở rộng nguồn đơn	Nếu qua quality gate, import được đơn e-commerce qua adapter mà không sửa luồng fulfillment lõi.	Could
3. Phạm vi sản phẩm
3.1 Trong phạm vi MVP
Năng lực	Phạm vi	Ưu tiên
Tenant & Identity	Provision tenant; quản lý người dùng; RBAC; tenant context.	Must
Master Data	Khách hàng B2B, địa chỉ giao, sản phẩm, kho, phương tiện, tài xế.	Must
Inventory	Nhập kho, điều chỉnh có lý do, giữ/nhả hàng, xuất kho, cảnh báo tồn thấp.	Must
Order	Tạo, xác nhận, chờ hàng, chuẩn bị, hủy trước xuất kho và theo dõi trạng thái.	Must
Shipment	Một order tạo một shipment; xác nhận sẵn sàng giao và theo dõi kết quả.	Must
Delivery Trip	Gom nhiều shipment cùng kho, gán xe/tài xế, phê duyệt tuyến và dispatch.	Must
Driver Experience	Xem chuyến được giao; cập nhật bắt đầu, đến điểm, thành công hoặc thất bại.	Must
Forecast	Dự báo nhu cầu SKU-kho, baseline, lưu phiên chạy và chỉ số đánh giá.	Must
Route Optimization	Tối ưu thứ tự điểm giao theo khoảng cách và sức chứa; cho phép phê duyệt/override.	Must
Planner Agent	Tra cứu, tạo bản nháp và kích hoạt công cụ theo quyền; yêu cầu xác nhận với hành động nhạy cảm.	Must
Dashboard & Notification	Chỉ số vận hành, cảnh báo tồn thấp, giao thất bại và lỗi AI.	Should
Audit & Reliability	Audit, idempotency, timeout, retry, fallback và quan sát luồng sự kiện.	Must

3.2 Ngoài phạm vi
●	Website bán hàng, giỏ hàng, checkout, thanh toán, khuyến mãi và quản lý catalog thương mại điện tử.
●	Hợp đồng 3PL, báo giá, hóa đơn, COD, đối soát và marketplace vận tải.
●	Procurement chuyên sâu, quản lý nhà cung cấp, purchase order và kế hoạch bổ sung tự động.
●	WMS chuyên sâu: sơ đồ bin/kệ, batch/lot, serial, hạn dùng, kiểm kê luân phiên và cold-chain.
●	GPS thời gian thực, ETA prediction, traffic live, geofencing và proof-of-delivery bằng chữ ký/ảnh.
●	Giao một phần, split order đa kho, chuyển kho tự động và tối ưu mạng lưới nhiều depot.
●	Đổi trả, reverse logistics, hoàn tiền và xử lý khiếu nại.
3.3 Mục tiêu mở rộng: E-commerce fulfillment
●	Nhận đơn qua API/webhook hoặc CSV mô phỏng; không kết nối thật với sàn.
●	Chuẩn hóa external order thành SalesOrder nội bộ bằng OrderChannelAdapter.
●	Lưu order_source, external_channel, external_order_id và idempotency_key.
●	Tái sử dụng toàn bộ reservation, shipment, trip, route và delivery flow của B2B.
●	Có thể gửi callback trạng thái mô phỏng; không làm thanh toán, refund hay returns.
4. Stakeholder, vai trò và quyền nghiệp vụ
Vai trò	Mục tiêu	Trách nhiệm chính
Platform Admin	Vận hành nền tảng	Tạo/khóa tenant, theo dõi health và cấu hình nền tảng; không xem dữ liệu nghiệp vụ tenant mặc định.
Tenant Admin	Quản trị doanh nghiệp	Quản lý người dùng, role, master data và cấu hình tenant.
Order Staff	Nhân viên đơn hàng	Quản lý khách hàng, tạo/xác nhận/hủy đơn trong giới hạn cho phép.
Warehouse Staff	Nhân viên kho	Nhập kho, chuẩn bị hàng, điều chỉnh có lý do và xác nhận shipment ready.
Dispatcher	Điều phối vận chuyển	Gom shipment, gán xe/tài xế, chạy tối ưu, phê duyệt và dispatch chuyến.
Driver	Tài xế	Chỉ xem chuyến của mình và cập nhật trạng thái giao hàng.
Manager	Quản lý	Xem dashboard, báo cáo, kết quả AI và audit ở chế độ đọc.
System Scheduler	Tác nhân hệ thống	Chạy forecast, retry job và kiểm tra cảnh báo theo lịch.

4.1 Ma trận quyền cấp cao
Năng lực	Người thao tác	Người xem/phối hợp	Kiểm soát
Tenant/User	Platform Admin	Tenant Admin	Platform Admin chỉ quản lý metadata tenant.
Customer/Product/Warehouse	Tenant Admin	Order Staff/Warehouse Staff theo miền	Driver không có quyền.
Inventory	Warehouse Staff	Tenant Admin/Manager đọc	Điều chỉnh bắt buộc có lý do.
Order	Order Staff	Tenant Admin/Manager đọc	Hủy chỉ trước dispatch.
Shipment	Warehouse Staff	Dispatcher/Order Staff đọc	Shipment ready mới được gom chuyến.
Trip/Route	Dispatcher	Driver chỉ cập nhật chuyến được gán	Route phải được phê duyệt trước dispatch.
Forecast/Analytics	Manager/Tenant Admin	Order/Warehouse Staff đọc phù hợp	Không tự tạo nhập kho.
Agent	Mọi role nghiệp vụ	Theo tool permission	Không vượt quyền gốc; hành động nhạy cảm cần xác nhận.
Audit	Tenant Admin/Manager	Platform Admin chỉ xem health metadata	Log không sửa/xóa qua UI nghiệp vụ.

5. Mô hình miền nghiệp vụ
Thực thể	Ý nghĩa	Quan hệ chính
Tenant	Doanh nghiệp phân phối sử dụng nền tảng.	1-N User, Warehouse, Customer, Product, Vehicle
Customer	Cửa hàng/đại lý B2B đặt hàng.	1-N CustomerAddress, SalesOrder
Product	SKU được phân phối.	1-N InventoryBalance, OrderLine
Warehouse	Điểm lưu và xuất hàng.	1-N InventoryBalance, SalesOrder, DeliveryTrip
InventoryBalance	Số on-hand, reserved, available theo SKU-kho.	Thuộc Product + Warehouse + Tenant
StockMovement	Bút toán nhập, xuất, điều chỉnh hoặc đảo.	Tham chiếu nghiệp vụ và người thao tác
SalesOrder	Yêu cầu giao hàng cho một khách, một địa chỉ và một kho.	1-N OrderLine; 0-1 Shipment
InventoryReservation	Lượng hàng giữ cho order đã xác nhận.	Gắn OrderLine và InventoryBalance
Shipment	Đơn vị hàng sẵn sàng vận chuyển của một order.	Thuộc một DeliveryTrip hoặc chưa phân chuyến
DeliveryTrip	Một chuyến xe xuất phát từ một kho, gồm nhiều shipment.	1 Vehicle, 1 Driver, N TripStop
TripStop	Một điểm giao trong chuyến.	Tham chiếu Shipment và thứ tự tuyến
RoutePlan	Phương án thứ tự điểm giao và chỉ số tối ưu.	Một DeliveryTrip có nhiều phiên bản, một bản approved
ForecastRun	Một lần chạy mô hình/baseline.	1-N ForecastResult
ForecastResult	Dự báo theo ngày cho SKU-kho.	Có actual để đánh giá sau này
AgentExecution	Một yêu cầu Planner và chuỗi tool call.	Gắn User, Tenant, Conversation, Audit
Notification	Thông báo cho user/role về sự kiện cần chú ý.	Gắn tenant và đối tượng nghiệp vụ
AuditLog	Bản ghi bất biến của hành động quan trọng.	Actor, action, entity, before/after, correlation

Quan hệ quyết định: Một SalesOrder chỉ lấy hàng từ một Warehouse; MVP không split order. Một SalesOrder tạo tối đa một Shipment. Một DeliveryTrip gom nhiều Shipment cùng kho và có một RoutePlan được Dispatcher phê duyệt.
5.1 Công thức tồn kho
available_quantity = on_hand_quantity - reserved_quantity
●	Xác nhận order thành công làm tăng reserved, chưa giảm on-hand.
●	Khi shipment được xuất kho/dispatch, on-hand và reserved cùng giảm theo lượng đã giữ.
●	Hủy order trước dispatch giải phóng reserved; không tạo stock movement xuất.
●	Mọi thay đổi on-hand phải tạo StockMovement và không được làm available âm.
6. Quy trình nghiệp vụ mục tiêu
 
Hình 2. Luồng Order-to-Delivery chuẩn
6.1 Thiết lập tenant và dữ liệu nền
1.	Platform Admin tạo tenant và tài khoản Tenant Admin ban đầu.
2.	Tenant Admin tạo role/user, kho, sản phẩm, khách hàng, địa chỉ giao, phương tiện và hồ sơ tài xế.
3.	Hệ thống kiểm tra mã duy nhất trong tenant và khóa bản ghi đang được tham chiếu thay vì xóa cứng.
4.	Warehouse Staff nhập tồn đầu kỳ hoặc ghi nhận phiếu nhập kho; hệ thống tạo StockMovement và cập nhật balance.
6.2 Xử lý đơn hàng và tồn kho
5.	Order Staff tạo SalesOrder ở trạng thái DRAFT, chọn customer, delivery address, warehouse và các SKU.
6.	Hệ thống tính tổng số lượng, trọng lượng, thể tích và kiểm tra dữ liệu bắt buộc.
7.	Khi người dùng xác nhận, hệ thống khóa kiểm tra toàn bộ dòng hàng theo nguyên tắc all-or-nothing.
8.	Nếu đủ available cho mọi dòng, hệ thống tạo reservation và chuyển order sang CONFIRMED.
9.	Nếu thiếu bất kỳ dòng nào, hệ thống không giữ một phần; order chuyển PENDING_STOCK và phát thông báo.
10.	Khi StockReceived phát sinh, hệ thống thử lại order PENDING_STOCK theo thứ tự confirmed_at trước; order đủ toàn bộ mới được giữ hàng.
11.	Warehouse Staff nhận danh sách confirmed order, chuẩn bị hàng và đánh dấu READY_TO_SHIP.
12.	Hệ thống tạo một Shipment cho order; order không được split trong MVP.
6.3 Điều phối chuyến và giao hàng
13.	Dispatcher chọn các shipment READY cùng warehouse để tạo DeliveryTrip DRAFT.
14.	Dispatcher gán vehicle và driver đang hoạt động; hệ thống kiểm tra lịch trùng và sức chứa.
15.	Route Optimizer nhận depot, điểm giao, tải trọng và distance matrix để sinh RoutePlan PROPOSED.
16.	Dispatcher xem quãng đường, tải và thứ tự điểm; có thể phê duyệt hoặc override kèm lý do.
17.	Sau khi route APPROVED, Dispatcher dispatch chuyến. Hệ thống xuất kho theo reservation và chuyển trip sang IN_PROGRESS.
18.	Driver lần lượt cập nhật ARRIVED, DELIVERED hoặc FAILED cho các điểm thuộc chuyến của mình.
19.	DELIVERED làm shipment hoàn tất và order COMPLETED. FAILED bắt buộc có reason và cho phép Dispatcher lên lịch giao lại.
20.	Khi tất cả điểm có kết quả cuối, DeliveryTrip chuyển COMPLETED và cập nhật dashboard.
6.4 Dự báo nhu cầu
21.	Scheduler hoặc người có quyền khởi tạo ForecastRun cho tập SKU-kho và khoảng dữ liệu lịch sử.
22.	Hệ thống tổng hợp số lượng order đã hoàn tất theo ngày; loại bỏ order hủy và dữ liệu không thuộc tenant.
23.	Mô hình tạo forecast 7 ngày và khoảng tin cậy; baseline tạo dự báo naive/trung bình trượt trên cùng dữ liệu.
24.	Kết quả, tham số, phiên bản mô hình và thời gian chạy được lưu để tái lập.
25.	Dashboard hiển thị forecast, actual và MAPE/RMSE khi đủ actual; kết quả chỉ mang tính tư vấn, không tự tạo phiếu nhập.
6.5 Tương tác qua Planner Agent
26.	Người dùng gửi yêu cầu tự nhiên; hệ thống gắn tenant, user, role và conversation context.
27.	Planner phân loại ý định, chỉ nhìn thấy tool mà role hiện tại được phép dùng.
28.	Yêu cầu đọc được thực thi trực tiếp; tạo draft hoặc chạy phân tích có thể thực thi và trả kết quả.
29.	Confirm order, cancel order, approve route và dispatch là hành động nhạy cảm, bắt buộc hiển thị bản xem trước và nhận xác nhận rõ ràng.
30.	Tool thực thi business rule giống API/UI; LLM không được bỏ qua validation hoặc ghi trực tiếp database.
31.	Mỗi bước được audit bằng correlation_id; nếu AI lỗi, luồng nghiệp vụ UI/API vẫn hoạt động.
7. Business Rules
7.1 Tenant, danh tính và dữ liệu nền
ID	Quy tắc
BR-TEN-001	Mọi bản ghi nghiệp vụ bắt buộc thuộc đúng một tenant; truy cập chéo tenant bị từ chối mặc định.
BR-TEN-002	Platform Admin chỉ quản lý tenant metadata và health; quyền xem dữ liệu doanh nghiệp phải là quyền hỗ trợ đặc biệt có audit.
BR-TEN-003	Mã customer, SKU, warehouse, vehicle và order phải duy nhất trong phạm vi tenant, không cần duy nhất toàn hệ thống.
BR-TEN-004	Bản ghi master data đang được tham chiếu chỉ được khóa/disable, không xóa cứng.
BR-TEN-005	Mọi hành động từ UI, API, event consumer và Agent đều phải mang tenant context có thể kiểm chứng.
BR-TEN-006	User bị khóa không được tạo phiên mới; token/phiên hiện tại phải bị từ chối theo chính sách thu hồi.

7.2 Đơn hàng và tồn kho
ID	Quy tắc
BR-INV-001	available = on_hand - reserved và không được nhỏ hơn 0.
BR-INV-002	Mỗi thay đổi on-hand phải có StockMovement, reference, actor và timestamp.
BR-INV-003	Điều chỉnh thủ công bắt buộc có reason; điều chỉnh giảm không được vượt available trừ quy trình kiểm kê được phê duyệt ngoài MVP.
BR-INV-004	Low-stock được xác định theo threshold riêng của SKU-kho; cảnh báo không tự tạo nhập hàng.
BR-ORD-001	Một order có đúng một customer, delivery address, warehouse và currency; MVP chỉ dùng một currency cấu hình theo tenant.
BR-ORD-002	Một order chỉ được lấy toàn bộ hàng từ một warehouse; không split đa kho và không giao một phần.
BR-ORD-003	Xác nhận order giữ tất cả dòng hàng theo giao dịch all-or-nothing; thiếu một dòng thì không giữ dòng nào.
BR-ORD-004	Order thiếu hàng chuyển PENDING_STOCK; hệ thống thử lại theo FIFO khi có StockReceived hoặc theo thao tác retry có quyền.
BR-ORD-005	Order chỉ được sửa customer, address, warehouse hoặc quantity khi còn DRAFT/PENDING_STOCK và chưa có reservation; thay đổi phải chạy lại validation.
BR-ORD-006	Hủy trước dispatch giải phóng reservation; sau dispatch không được cancel mà phải xử lý delivery failed/return ngoài phạm vi MVP.
BR-ORD-007	Order COMPLETED chỉ khi shipment tương ứng DELIVERED; order không có shipment không thể hoàn tất.

7.3 Shipment, chuyến giao và tuyến
ID	Quy tắc
BR-SHP-001	MVP áp dụng quan hệ một order - tối đa một shipment; shipment chỉ tạo khi order đã được giữ hàng đầy đủ.
BR-SHP-002	Shipment READY mới được thêm vào trip và không được thuộc đồng thời hai trip chưa hủy.
BR-TRIP-001	Một trip xuất phát từ một warehouse và chỉ chứa shipment của warehouse đó.
BR-TRIP-002	Một trip có đúng một vehicle và một driver tại thời điểm dispatch; cả hai phải ACTIVE và không trùng lịch với trip đang chạy.
BR-TRIP-003	Tổng weight/volume của shipment không vượt capacity cấu hình; dữ liệu thiếu capacity khiến trip không được dispatch.
BR-TRIP-004	Mỗi delivery address xuất hiện như một stop; mỗi shipment phải được phục vụ đúng một lần trong route approved.
BR-TRIP-005	Route Optimizer chỉ đề xuất. Dispatcher phải approve; override bắt buộc có reason và lưu cả phương án gốc.
BR-TRIP-006	Dispatch chỉ khi trip đã có vehicle, driver, approved route và toàn bộ shipment READY.
BR-TRIP-007	Xuất kho xảy ra đúng một lần khi dispatch; request/event lặp lại không được trừ tồn lần hai.
BR-DEL-001	Driver chỉ thao tác trip được gán cho mình và chỉ cập nhật stop theo transition hợp lệ.
BR-DEL-002	Delivery FAILED bắt buộc có reason; shipment có thể được dispatcher đưa vào trip giao lại mà không xuất kho lần hai.

7.4 AI, thông báo và audit
ID	Quy tắc
BR-AI-001	LLM không trực tiếp tính forecast hoặc route; bắt buộc gọi tool/mô hình chuyên biệt.
BR-AI-002	Tool permission bằng hoặc hẹp hơn quyền của user; Agent không có service account toàn quyền để vượt RBAC.
BR-AI-003	Hành động nhạy cảm phải có preview và explicit confirmation trong cùng tenant/user context.
BR-AI-004	Forecast chỉ dùng dữ liệu đã hoàn tất và thuộc tenant; kết quả không tự tạo order nhập hàng.
BR-AI-005	Route result lưu input hash, solver/version, objective và metrics để tái lập và so sánh.
BR-AI-006	Nếu model/tool không sẵn sàng, hệ thống trả trạng thái rõ ràng và cho phép nghiệp vụ thủ công tiếp tục.
BR-NOT-001	Thông báo được tạo cho pending stock, low stock, driver assignment, route ready, delivery failed và AI job failed.
BR-AUD-001	Audit bắt buộc cho login nhạy cảm, role change, inventory adjustment, order confirmation/cancel, route approval/override, dispatch và tool call.
BR-AUD-002	Audit log không được sửa/xóa qua API nghiệp vụ và phải có actor, tenant, action, entity, timestamp, correlation_id và outcome.

8. Mô hình trạng thái
8.1 SalesOrder
Trạng thái	Chủ thể	Ý nghĩa	Chuyển tiếp cho phép
DRAFT	Order Staff	Tạo mới hoặc chỉnh sửa	PENDING_STOCK, CONFIRMED, CANCELED
PENDING_STOCK	Hệ thống/Order Staff	Xác nhận nhưng chưa đủ toàn bộ hàng	CONFIRMED, CANCELED
CONFIRMED	Hệ thống	Đã giữ đủ hàng	PICKING, CANCELED
PICKING	Warehouse Staff	Đang chuẩn bị hàng	READY_TO_SHIP, CANCELED
READY_TO_SHIP	Warehouse Staff	Shipment đã sẵn sàng	IN_DELIVERY, CANCELED
IN_DELIVERY	Dispatcher/System	Trip đã dispatch	COMPLETED, DELIVERY_FAILED
DELIVERY_FAILED	Driver/Dispatcher	Giao thất bại, chờ xếp lại chuyến	IN_DELIVERY
COMPLETED	System	Giao thành công	Kết thúc
CANCELED	Order Staff	Hủy trước dispatch	Kết thúc

8.2 Shipment
Trạng thái	Ý nghĩa	Chuyển tiếp
CREATED	Sinh từ order đã giữ hàng	READY, CANCELED
READY	Đã đóng gói/sẵn sàng	ASSIGNED, CANCELED
ASSIGNED	Đã thuộc một trip	IN_TRANSIT, READY
IN_TRANSIT	Trip đã dispatch	DELIVERED, FAILED
FAILED	Giao thất bại	ASSIGNED
DELIVERED	Giao thành công	Kết thúc
CANCELED	Hủy trước dispatch	Kết thúc

8.3 DeliveryTrip
Trạng thái	Ý nghĩa	Chuyển tiếp
DRAFT	Dispatcher đang chọn shipment	PLANNED, CANCELED
PLANNED	Đã có vehicle/driver và route proposed	APPROVED, DRAFT, CANCELED
APPROVED	Dispatcher phê duyệt route	IN_PROGRESS, PLANNED, CANCELED
IN_PROGRESS	Đã xuất kho và khởi hành	COMPLETED
COMPLETED	Mọi stop có kết quả cuối	Kết thúc
CANCELED	Hủy trước dispatch	Kết thúc

9. Yêu cầu chức năng
9.1 Tenant, Identity và Master Data
ID	Yêu cầu	Actor	Ưu tiên
FR-TEN-001	Provision, activate, suspend tenant và khởi tạo Tenant Admin.	Platform Admin	Must
FR-TEN-002	Quản lý user, role và quyền trong tenant; khóa/mở tài khoản.	Tenant Admin	Must
FR-MDM-001	CRUD/disable customer và nhiều delivery address có tọa độ.	Order Staff	Must
FR-MDM-002	CRUD/disable product với SKU, đơn vị, weight, volume và low-stock threshold theo kho.	Tenant Admin	Must
FR-MDM-003	CRUD/disable warehouse với địa chỉ và tọa độ depot.	Tenant Admin	Must
FR-MDM-004	CRUD/disable vehicle với capacity và trạng thái hoạt động.	Dispatcher	Must
FR-MDM-005	Quản lý driver profile và liên kết với user role Driver.	Tenant Admin	Must

9.2 Inventory và Order
ID	Yêu cầu	Actor	Ưu tiên
FR-INV-001	Ghi nhận nhập kho và tạo stock movement idempotent.	Warehouse Staff	Must
FR-INV-002	Tra cứu on-hand, reserved, available theo warehouse/SKU.	Authorized User	Must
FR-INV-003	Điều chỉnh tồn kho với reason và audit.	Warehouse Staff	Must
FR-INV-004	Tự phát hiện low-stock và gửi notification.	System	Should
FR-ORD-001	Tạo và chỉnh sửa order draft với customer, address, warehouse và items.	Order Staff	Must
FR-ORD-002	Xác nhận order và reserve all-or-nothing.	Order Staff	Must
FR-ORD-003	Đưa order thiếu hàng vào pending và retry khi nhận thêm hàng.	System	Must
FR-ORD-004	Hủy order trước dispatch và giải phóng reservation.	Order Staff	Must
FR-ORD-005	Tìm kiếm/lọc order theo mã, customer, warehouse, status và thời gian.	Authorized User	Must

9.3 Fulfillment và vận chuyển
ID	Yêu cầu	Actor	Ưu tiên
FR-SHP-001	Chuyển confirmed order sang picking, ready và tạo shipment.	Warehouse Staff	Must
FR-SHP-002	Hiển thị danh sách shipment ready theo warehouse và tải trọng.	Dispatcher	Must
FR-TRIP-001	Tạo trip từ nhiều shipment cùng warehouse.	Dispatcher	Must
FR-TRIP-002	Gán vehicle/driver và kiểm tra capacity, status, lịch trùng.	Dispatcher	Must
FR-TRIP-003	Yêu cầu route optimization và lưu proposed plan cùng metrics.	Dispatcher	Must
FR-TRIP-004	Approve hoặc override route với reason.	Dispatcher	Must
FR-TRIP-005	Dispatch idempotent, xuất kho đúng một lần và phát sự kiện.	Dispatcher	Must
FR-DRV-001	Driver xem trip hiện tại và danh sách stop theo thứ tự.	Driver	Must
FR-DRV-002	Driver cập nhật arrived/delivered/failed và reason.	Driver	Must
FR-TRIP-006	Hoàn tất trip và cập nhật order/shipment tương ứng.	System	Must

9.4 AI, dashboard, thông báo và audit
ID	Yêu cầu	Actor	Ưu tiên
FR-FC-001	Chạy forecast 7 ngày theo SKU-kho từ dữ liệu daily fulfilled demand.	Manager/System	Must
FR-FC-002	Chạy baseline trên cùng tập dữ liệu và tính MAPE/RMSE khi đủ actual.	System	Must
FR-FC-003	Hiển thị forecast, confidence interval, actual và model metadata.	Manager	Must
FR-ROUTE-001	Tối ưu depot-to-stops-to-depot, phục vụ mỗi stop đúng một lần và không vượt capacity.	System Tool	Must
FR-AGT-001	Planner hiểu yêu cầu và chỉ expose tool đúng role/tenant.	Authorized User	Must
FR-AGT-002	Planner trả preview và xin xác nhận trước hành động nhạy cảm.	Authorized User	Must
FR-AGT-003	Lưu agent execution, tool input/output đã lọc dữ liệu nhạy cảm và outcome.	System	Must
FR-DAS-001	Dashboard order, inventory, trip, delivery, forecast và AI health.	Manager	Should
FR-NOT-001	Notification center và trạng thái read/unread cho các sự kiện đã định nghĩa.	Authorized User	Should
FR-AUD-001	Tra cứu audit theo actor, action, entity, thời gian và correlation.	Tenant Admin/Manager	Must
9.5 Agentic Layer Architecture
ID	Yêu cầu	Actor	Ưu tiên
FR-AGT-004 	Cung cấp interface trung gian (abstraction layer) cho mọi tương tác với LLM, đảm bảo Business Layer không phụ thuộc trực tiếp vào LLM SDK cụ thể. 	System	Must
FR-AGT-005 	Hỗ trợ cấu hình dynamic để thay đổi model (v.d., chuyển từ GPT-4 sang Claude 3 hoặc local model) qua file cấu hình hoặc biến môi trường mà không cần biên dịch lại mã nguồn. 	System	Must
10. Sự kiện nghiệp vụ và tích hợp
Event	Producer	Tác động nghiệp vụ	Idempotency key
StockReceived	Inventory	Retry order pending; kiểm tra low-stock	receipt_id
InventoryAdjusted	Inventory	Audit/dashboard refresh	movement_id
OrderCreated	Order	Audit/notification tùy cấu hình	order_id
OrderConfirmed	Order	Bắt đầu fulfillment	order_id + version
OrderPendingStock	Order	Thông báo Order Staff/Manager	order_id + shortage_hash
InventoryReserved	Inventory	Cập nhật trạng thái order	reservation_group_id
ShipmentReady	Fulfillment	Hiển thị cho Dispatcher	shipment_id
TripPlanned	Transport	Cho phép gọi Route Optimizer	trip_id + version
RouteOptimized	Route Tool	Lưu proposed route/metrics	route_request_id
RouteApproved	Transport	Cho phép dispatch	route_plan_id
TripDispatched	Transport	Xuất kho, thông báo Driver	trip_id + dispatch_version
DeliveryCompleted	Driver/Transport	Complete shipment/order	stop_id + attempt
DeliveryFailed	Driver/Transport	Thông báo Dispatcher, cho phép reschedule	stop_id + attempt
ForecastCompleted	Forecast Tool	Dashboard/notification	forecast_run_id
AgentExecutionCompleted	Agentic Layer	Audit/metrics	agent_execution_id

10.1 Event envelope tối thiểu
●	event_id, event_type, event_version, occurred_at và producer.
●	tenant_id bắt buộc; actor_id khi có người dùng khởi tạo.
●	correlation_id và causation_id để truy vết chuỗi xử lý.
●	aggregate_type, aggregate_id và aggregate_version để chống cập nhật sai thứ tự.
●	payload theo schema có version; consumer phải idempotent.
11. Yêu cầu đối với AI và công cụ định lượng
11.1 Planner Agent
Nhóm	Ví dụ	Chính sách
Tra cứu	Order status, stock, shipment, trip, forecast	Có thể thực thi trực tiếp theo RBAC
Tạo bản nháp	Draft order hoặc draft trip	Trả dữ liệu đã chuẩn hóa để người dùng kiểm tra
Phân tích	Run forecast hoặc route proposal	Không thay đổi trạng thái vận hành cuối
Hành động nhạy cảm	Confirm/cancel order, approve route, dispatch	Bắt buộc preview + explicit confirmation
Không hỗ trợ	Ghi DB trực tiếp, bỏ validation, tự bịa số liệu	Từ chối hoặc chuyển về luồng UI/API

Lưu ý kiến trúc: "Sử dụng mẫu thiết kế Strategy Pattern hoặc Adapter Pattern cho mọi kết nối với LLM/AI framework. Các class thực thi logic nghiệp vụ chỉ gọi các phương thức qua interface chung, không phụ thuộc vào thư viện bên thứ ba. 
11.2 Demand Forecast
Thành phần	Baseline BRD
Đơn vị dự báo	Một chuỗi theo tenant + warehouse + SKU.
Dữ liệu	Số lượng order COMPLETED theo ngày; khuyến nghị seed tối thiểu 180 ngày.
Horizon	7 ngày cho MVP; có thể cấu hình trong giới hạn kỹ thuật.
Mô hình	Prophet hoặc mô hình tương đương; không cố định implementation trong BRD.
Đối chứng	Naive forecast và/hoặc moving average 7 ngày.
Chỉ số	MAPE và RMSE; với chuỗi có actual bằng 0 cần quy tắc xử lý được ghi trong báo cáo.
Fallback	Dữ liệu không đủ thì dùng baseline và đánh dấu confidence thấp; không trả con số do LLM tự sinh.
Tác động	Chỉ tư vấn; không tự tạo nhập kho hoặc thay đổi threshold.

11.3 Route Optimization
Thành phần	Baseline BRD
Đầu vào	Depot, danh sách stop, tọa độ/distance matrix, demand weight/volume và vehicle capacity.
Ràng buộc bắt buộc	Mỗi stop đúng một lần; cùng warehouse; không vượt capacity; route bắt đầu/kết thúc tại depot.
Mục tiêu	Tối thiểu hóa tổng quãng đường hoặc chi phí quy đổi.
Ràng buộc tùy chọn	Time window và service time chỉ triển khai khi MVP ổn định.
Đối chứng	Thứ tự nhập ban đầu và/hoặc nearest-neighbor.
Phê duyệt	Dispatcher approve/override; lưu lý do và cả proposed route.
Fallback	Không có distance matrix/solver lỗi thì giữ trip ở PLANNED và cho phép điều phối thủ công.

12. Dashboard, thông báo và báo cáo
Nhóm	Thông tin tối thiểu
Order	Số đơn theo trạng thái, pending stock, completed/canceled theo kỳ.
Inventory	On-hand/reserved/available, low-stock SKU và biến động nhập-xuất.
Transport	Trip theo trạng thái, số stop, delivery success/failure và tổng quãng đường.
Forecast	Forecast so với actual, MAPE/RMSE và danh sách SKU có xu hướng tăng.
Agent	Số execution, tool success/failure, latency và yêu cầu cần xác nhận.
System	Event latency, retry/dead-letter, API latency và instance/replica trong bài test.

13. Yêu cầu phi chức năng
ID	Thuộc tính	Tiêu chí	Ưu tiên
NFR-SEC-001	Tenant isolation	Không truy cập chéo tenant trong negative test; mọi repository/query có tenant filter hoặc cơ chế tương đương.	Must
NFR-SEC-002	Authorization	RBAC áp dụng thống nhất cho UI/API/tool; kiểm tra server-side, không chỉ ẩn giao diện.	Must
NFR-REL-001	Idempotency	Duplicate command/event không tạo thêm reservation, stock issue, shipment hoặc notification ngoài ý muốn.	Must
NFR-REL-002	Retry/fallback	Lỗi tạm thời có retry giới hạn và backoff; lỗi cuối có trạng thái/audit; nghiệp vụ lõi vẫn dùng được khi AI lỗi.	Must
NFR-PER-001	Business API	Mục tiêu p95 ≤ 2 giây cho CRUD/command thông thường dưới 100 virtual users trong bài test 10 phút.	Should
NFR-PER-002	Event processing	Mục tiêu p95 từ publish đến business effect ≤ 3 giây ở tải benchmark đã công bố.	Should
NFR-AI-001	Planner	Tool Success Rate ≥ 90% trên tối thiểu 30 kịch bản cố định; ghi nhận latency theo percentile.	Must
NFR-AI-002	Route	Mục tiêu trả route trong ≤ 10 giây cho tối đa 50 stop trên môi trường benchmark.	Should
NFR-AI-003	Forecast	Batch 100 chuỗi SKU-kho hoàn thành trong ≤ 60 giây trên môi trường benchmark hoặc công bố giới hạn thực tế.	Should
NFR-OBS-001	Observability	Log cấu trúc, metric và trace/correlation cho API, event consumer, agent và tool execution.	Must
NFR-AUD-001	Audit	Audit không chỉnh sửa qua business API; dữ liệu nhạy cảm/token không được ghi thô.	Must
NFR-SCL-001	Scale-out	Demo được ít nhất một workload tăng replica tự động hoặc bằng kịch bản scale có số liệu trước/sau.	Should
NFR-UX-001	Driver UI	Responsive trên màn hình di động; thao tác trạng thái chính hoàn thành trong tối đa 3 bước.	Should
NFR-DAT-001	Consistency	Command quan trọng có optimistic version hoặc kiểm soát tương đương; event out-of-order không làm lùi trạng thái.	Must
NFR-AI-004	Engine-agnostic interface	Mọi giao tiếp giữa Agent và Business Layer phải thông qua một Interface Contract chuẩn hóa; business logic không được chứa logic xử lý prompt cụ thể cho một provider duy nhất.	Must
NFR-AI-005	Model swap reliability	Khả năng thay đổi LLM provider hoặc phiên bản model phải hoàn tất trong ≤ 1 giờ cấu hình và kiểm thử hồi quy (regression test) trên tập test cases cố định mà không thay đổi nghiệp vụ.	Should

14. Kịch bản nghiệm thu nghiệp vụ
ID	Kịch bản	Thực hiện	Kết quả mong đợi
AT-01	Cách ly tenant	Tạo dữ liệu trùng mã ở hai tenant; user tenant A không đọc/sửa được tenant B.	Không rò rỉ; mã được phép trùng giữa tenant.
AT-02	Order đủ hàng	Nhập kho → tạo order → confirm → picking → shipment ready.	Reservation đúng; trạng thái và audit đúng.
AT-03	Order thiếu hàng	Confirm order thiếu một SKU; sau đó nhận thêm hàng.	Không giữ một phần; pending; retry FIFO và confirm khi đủ.
AT-04	Hủy trước dispatch	Hủy confirmed/ready order.	Reservation được nhả; không xuất kho; shipment kết thúc hợp lệ.
AT-05	Chuyến nhiều điểm	Gom ≥5 shipment cùng kho, gán xe/tài xế, optimize và approve.	Không vượt tải; mỗi stop đúng một lần; lưu metrics.
AT-06	Dispatch idempotent	Gửi command/event dispatch lặp lại.	Tồn kho chỉ bị trừ một lần.
AT-07	Giao thành công/thất bại	Driver cập nhật các stop với cả hai kết quả.	Order/shipment đúng; failed có reason và reschedule được.
AT-08	Forecast	Chạy forecast và baseline trên dataset seed.	Có forecast 7 ngày, MAPE/RMSE và metadata tái lập.
AT-09	Planner/RBAC	User hỏi stock, tạo draft; thử yêu cầu dispatch khi không đủ quyền.	Đọc đúng tenant; draft hợp lệ; hành động trái quyền bị từ chối.
AT-10	AI fallback	Ngắt model/solver tạm thời.	Job lỗi rõ ràng; không corrupt dữ liệu; nghiệp vụ thủ công tiếp tục.
AT-11	E-commerce stretch	Import cùng external order hai lần.	Nếu triển khai: chỉ tạo một order và tái sử dụng fulfillment lõi.

15. Rủi ro và biện pháp
ID	Rủi ro	Mức	Biện pháp
R-01	Phạm vi quá rộng cho hai người	Cao	Giữ MVP một kho/order, không partial, không WMS sâu; e-commerce là stretch.
R-02	Thiếu dữ liệu forecast thực tế	Cao	Chuẩn bị synthetic/benchmark dataset 180 ngày; công bố giả định và baseline.
R-03	Khoảng cách/tọa độ không ổn định	Trung bình	Dùng dataset tọa độ cố định và cache distance matrix cho benchmark.
R-04	Kafka gây khó consistency	Cao	Outbox/inbox hoặc cơ chế tương đương; idempotency key; test duplicate/out-of-order.
R-05	Agent gọi sai tool hoặc tham số	Cao	Tool schema chặt, validation, curated test set, explicit confirmation và fallback.
R-06	Kubernetes chiếm thời gian	Trung bình	Docker Compose cho dev; K8s chỉ triển khai workload cần chứng minh scale.
R-07	Tích hợp muộn	Cao	Contract-first; vertical slice Order→Event→Agent/Tool sớm; freeze feature 30/11.
R-08	Benchmark không tái lập	Trung bình	Khóa dataset, seed, cấu hình môi trường, script và version model/solver.
R-09	Rò dữ liệu tenant	Cao	Tenant context bắt buộc, negative test tự động và không cấp Agent quyền toàn cục.

