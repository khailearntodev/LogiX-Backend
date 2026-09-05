ĐẠI HỌC QUỐC GIA TP. HỒ CHÍ MINH
TRƯỜNG ĐẠI HỌC
CÔNG NGHỆ THÔNG TIN	CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM
Độc Lập - Tự Do - Hạnh Phúc


ĐỀ CƯƠNG CHI TIẾT

TÊN ĐỀ TÀI TIẾNG VIỆT: XÂY DỰNG NỀN TẢNG LOGISTICS VÀ QUẢN LÝ CHUỖI CUNG ỨNG THÔNG MINH TÍCH HỢP AGENTIC AI.
TÊN ĐỀ TÀI TIẾNG ANH: DEVELOPMENT OF AN INTELLIGENT LOGISTICS AND SUPPLY CHAIN MANAGEMENT PLATFORM INTEGRATED WITH AGENTIC AI.
Cán bộ hướng dẫn: TS. Đỗ Thị Thanh Tuyền
Thời gian thực hiện: Từ ngày 07/09/2026 đến ngày 28/12/2026.
Sinh viên thực hiện:
Nguyễn Quang Khải - 23520677
Lê Bùi Quốc Huy - 23520610
Nội dung đề tài:
1.  Tổng quan đề tài 
Trong hoạt động logistics và quản lý chuỗi cung ứng, doanh nghiệp phải phối hợp nhiều nghiệp vụ như quản lý đơn hàng, tồn kho và vận chuyển. Theo bối cảnh của đề tài, các quy trình và dữ liệu nghiệp vụ còn có xu hướng phân tán, khiến việc tổng hợp thông tin và phối hợp giữa các khâu chưa hiệu quả. Đặc biệt, hoạt động dự báo nhu cầu tồn kho và điều phối tuyến đường giao hàng vẫn phụ thuộc nhiều vào phán đoán và thao tác thủ công.
Hai vấn đề nổi bật được đề tài tập trung là: (1) dự báo nhu cầu tồn kho chưa chính xác, có thể dẫn đến tồn kho dư thừa hoặc thiếu hụt; và (2) điều phối tuyến đường giao hàng chưa tối ưu, làm gia tăng chi phí vận chuyển. Ngoài ra việc kết nối các hệ thống nghiệp vụ theo cách truyền thống có thể làm tăng độ trễ và hạn chế khả năng mở rộng khi dữ liệu phát sinh liên tục.
Bên cạnh đó với sự phát triển của Agentic AI mở ra khả năng cho phép người dùng tương tác với hệ thống bằng ngôn ngữ tự nhiên và điều phối nhiều chức năng thông qua một giao diện thống nhất. Tuy nhiên, các mô hình ngôn ngữ không nên được sử dụng như nguồn duy nhất cho các kết quả định lượng cần độ chính xác cao. Vì vậy, đề tài lựa chọn hướng kết hợp AI với các công cụ chuyên biệt: AI đảm nhiệm việc phân tích và điều phối, còn kết quả dự báo hoặc tối ưu được tạo bởi các thành phần có thể kiểm chứng.
Từ thực trạng trên, nhu cầu đặt ra là xây dựng một nền tảng có khả năng hợp nhất dữ liệu và các quy trình logistics, đồng thời khai thác xử lý sự kiện theo thời gian thực để hỗ trợ các tác vụ phân tích và ra quyết với sự hỗ trợ của Agentic AI. Vì vậy đó chính là lý do nhóm thực hiện đề tài “Xây dựng nền tảng Logistics và quản lý chuỗi cung ứng thông minh tích hợp Agentic AI”
2. Mục tiêu của đề tài  
Đề tài hướng đến xây dựng một nền tảng quản lý chuỗi cung ứng và logistics thông minh, có khả năng tích hợp Agentic AI vào các quy trình nghiệp vụ mà vẫn bảo đảm tính độc lập, mở rộng, độ tin cậy và khả năng tái sử dụng của hệ thống.
Các mục tiêu cụ thể gồm:
•	Xây dựng nền tảng logistics phân tán theo kiến trúc Microservices và Event-driven, hỗ trợ quản lý các nghiệp vụ cốt lõi gồm đơn hàng, tồn kho và vận chuyển, đồng thời đáp ứng yêu cầu về khả năng mở rộng và vận hành trong môi trường enterprise.
•	Thiết kế và triển khai Agentic AI Layer theo hướng engine-agnostic, tách biệt lớp AI khỏi luồng nghiệp vụ cốt lõi và chuẩn hóa giao tiếp giữa Agent với hệ thống thông qua các interface và data contract.
•	Bảo đảm độ tin cậy và an toàn của Agentic Layer thông qua các cơ chế Timeout, Retry, Fallback, Idempotency và Multi-tenant Isolation.
•	Triển khai ba nhóm AI Agent cho các bài toán chính: điều phối nghiệp vụ, dự báo nhu cầu và tối ưu tuyến đường; trong đó các quyết định định lượng được thực hiện thông qua các mô hình hoặc công cụ có thể kiểm chứng, hạn chế việc LLM trực tiếp sinh kết quả quyết định.
•	Cải thiện quy trình logistics thông qua việc hợp nhất dữ liệu, xử lý sự kiện theo thời gian thực và hỗ trợ tự động hóa hoạt động dự báo, điều phối và tối ưu hóa.
•	Đánh giá hiệu quả hệ thống bằng các chỉ số định lượng và baseline phù hợp, tập trung vào độ chính xác dự báo, hiệu quả tối ưu tuyến đường, độ tin cậy của Agentic Layer, độ trễ xử lý sự kiện và khả năng mở rộng của hệ thống.
•	Chứng minh khả năng tái sử dụng và mở rộng của Agentic Layer, cho phép bổ sung Agent hoặc thay đổi công nghệ AI mà không làm thay đổi đáng kể luồng nghiệp vụ cốt lõi.
3. Phương pháp thực hiện 
Đề tài được thực hiện theo hướng kết hợp phân tích nghiệp vụ, thiết kế kiến trúc phần mềm phân tán, phát triển nền tảng logistics và tích hợp Agentic AI, với quy trình gồm các bước chính sau:
3.1. Phân tích bài toán và thiết kế kiến trúc
•	Phân tích các nghiệp vụ cốt lõi của chuỗi cung ứng và logistics, tập trung vào quản lý người dùng, đơn hàng, tồn kho, vận chuyển và phân tích.
•	Phân chia hệ thống thành các miền nghiệp vụ và các thành phần có trách nhiệm rõ ràng, phù hợp với phạm vi của đề tài và nguồn lực của nhóm.
•	Xác định các luồng xử lý đồng bộ và bất đồng bộ, các sự kiện nghiệp vụ, interface và data contract giữa các thành phần.
•	Xác định các yêu cầu phi chức năng gồm khả năng mở rộng, độ tin cậy, bảo mật, cách ly dữ liệu giữa các tenant và khả năng vận hành.
3.2. Xây dựng nền tảng nghiệp vụ và hạ tầng hệ thống
•	Phát triển các thành phần nghiệp vụ phục vụ quản lý đơn hàng, tồn kho, vận chuyển, phương tiện và thông báo.
•	Xây dựng cơ chế giao tiếp giữa các thành phần theo mô hình phân tán, hỗ trợ xử lý bất đồng bộ và cập nhật trạng thái theo sự kiện.
•	Tổ chức dữ liệu và các cơ chế lưu trữ, truy cập và trao đổi phù hợp với yêu cầu của từng loại nghiệp vụ.
•	Triển khai hệ thống trong môi trường container và orchestration, hỗ trợ mở rộng ngang, quản lý cấu hình và tự động hóa triển khai.
•	Xây dựng các cơ chế giám sát, ghi nhận hoạt động và theo dõi trạng thái hệ thống.
3.3. Thiết kế và triển khai Agentic AI Layer
•	Xây dựng Agentic Layer theo kiến trúc phân tách giữa tiếp nhận yêu cầu, điều phối, xử lý nền, thực thi Agent và trả kết quả.
•	Chuẩn hóa context, interface và data contract giữa người dùng, hệ thống nghiệp vụ và Agent.
•	Tích hợp các cơ chế Timeout, Retry, Fallback và Idempotency nhằm bảo đảm độ tin cậy trong quá trình xử lý.
•	Thực hiện Multi-tenant Isolation đối với dữ liệu, quyền truy cập và việc sử dụng công cụ của Agent.
•	Thiết kế theo hướng engine-agnostic, cho phép thay đổi mô hình hoặc framework AI mà không làm thay đổi đáng kể luồng nghiệp vụ cốt lõi.
3.4. Phát triển và kiểm chứng các AI Agent
•	Xây dựng Planner Agent để phân tích yêu cầu và điều phối các công cụ hoặc tác vụ nghiệp vụ phù hợp.
•	Xây dựng Demand Forecast Agent để dự báo nhu cầu dựa trên dữ liệu chuỗi thời gian và đối chiếu với phương pháp baseline.
•	Xây dựng Route Optimizer Agent để xây dựng phương án tuyến đường dựa trên dữ liệu vận chuyển và các ràng buộc nghiệp vụ.
•	Hạn chế việc Agent tự sinh các kết quả định lượng quan trọng; các tác vụ yêu cầu tính chính xác được thực hiện thông qua mô hình hoặc công cụ có thể kiểm chứng.
•	Xây dựng tập tình huống kiểm thử phù hợp cho từng Agent và đánh giá khả năng lựa chọn, gọi và phối hợp công cụ.
3.5. Kiểm thử và đánh giá hệ thống
•	Thực hiện kiểm thử chức năng đối với các nghiệp vụ chính và các luồng tích hợp giữa hệ thống với Agentic Layer.
•	Đánh giá Agentic Layer về khả năng thực thi công cụ, độ trễ xử lý và khả năng thay đổi thành phần AI.
•	Đánh giá khả năng dự báo dựa trên các chỉ số sai số và so sánh với baseline.
•	Đánh giá hiệu quả tối ưu tuyến đường thông qua các chỉ số phù hợp và so sánh với phương pháp đối chứng.
•	Đánh giá hệ thống về độ trễ xử lý sự kiện, thời gian phản hồi, khả năng mở rộng, độ ổn định và hành vi khi có lỗi.
•	Thực hiện load test, idempotency test và kiểm tra các cơ chế retry/fallback, isolation và auto-scaling.
3.6. Phân tích kết quả và đối chiếu với mục tiêu
•	Tổng hợp kết quả thực nghiệm của hệ thống và các AI Agent so với baseline và các yêu cầu đặt ra.
•	Phân tích mức độ cải thiện về độ chính xác, hiệu quả tối ưu, độ trễ, khả năng mở rộng và độ tin cậy.
•	Đánh giá khả năng tích hợp Agentic AI vào quy trình logistics mà không làm ảnh hưởng đến luồng nghiệp vụ cốt lõi.
•	Từ kết quả thực nghiệm, xác định các giới hạn của hệ thống và khả năng mở rộng trong các hướng phát triển tiếp theo.
4. Các nội dung chính và giới hạn của đề tài 
Nội dung chính
•	Nền tảng quản lý và phân quyền
o	Quản lý người dùng và phân quyền theo vai trò.
o	Hỗ trợ các vai trò nghiệp vụ chính như quản trị, nhân viên kho và tài xế.
o	Quản lý thông báo và các hoạt động liên quan đến tài khoản, quyền truy cập.
•	Quản lý chuỗi cung ứng
o	Quản lý vòng đời đơn hàng.
o	Quản lý nhập, xuất và tồn kho.
o	Cảnh báo tồn kho thấp.
o	Cung cấp dữ liệu nghiệp vụ cho các chức năng phân tích và dự báo.
•	Quản lý logistics
o	Quản lý shipment, phương tiện và trạng thái vận chuyển ở mức cơ bản.
o	Phân công phương tiện phù hợp cho shipment.
o	Tiếp nhận và áp dụng phương án tuyến đường do hệ thống tối ưu đề xuất.
•	Phân tích và giám sát
o	Cung cấp dashboard cho các chỉ số vận hành chính.
o	Hiển thị kết quả dự báo và tối ưu hóa.
o	Ghi nhận hoạt động hệ thống, audit và các chỉ số phục vụ giám sát.
•	Agentic AI
o	Planner Agent: phân tích yêu cầu và điều phối các tác vụ hoặc công cụ phù hợp.
o	Demand Forecast Agent: dự báo nhu cầu dựa trên dữ liệu chuỗi thời gian.
o	Route Optimizer Agent: xây dựng phương án tối ưu tuyến đường dựa trên dữ liệu và các ràng buộc vận chuyển.
•	Event-driven và tích hợp hệ thống
o	Xây dựng cơ chế xử lý sự kiện bất đồng bộ và đồng bộ hóa trạng thái giữa các thành phần.
o	Sử dụng các sự kiện nghiệp vụ chính để kết nối quy trình logistics với các chức năng AI và thông báo.
•	Vận hành và khả năng mở rộng
o	Triển khai hệ thống trong môi trường container và orchestration.
o	Hỗ trợ mở rộng ngang và tự động điều chỉnh tài nguyên theo tải.
o	Theo dõi trạng thái, hiệu năng và khả năng chịu tải của hệ thống.
•	Reliability và Multi-tenant
o	Áp dụng Timeout, Retry, Fallback và Idempotency cho các luồng xử lý phù hợp.
o	Bảo đảm cách ly dữ liệu và quyền truy cập giữa các tenant.
o	Chuẩn hóa interface giữa Agent và hệ thống để hỗ trợ thay đổi hoặc mở rộng thành phần AI.
5. Giới hạn của đề tài
•	Đề tài tập trung vào ba nhóm AI Agent gồm Planner, Demand Forecast và Route Optimizer.
•	Nghiệp vụ logistics được giới hạn ở các chức năng cốt lõi cần thiết để chứng minh khả năng tích hợp và đánh giá Agentic AI; không triển khai các nghiệp vụ logistics chuyên sâu ngoài phạm vi đề tài.
•	Phần quản lý phương tiện được thực hiện ở mức cơ bản, chủ yếu phục vụ phân công và các ràng buộc của bài toán tối ưu tuyến đường.
6. Nền tảng công nghệ 
•	Infrastructure: Docker, Kubernetes.
•	Message Broker: Apache Kafka.
•	Backend: NestJS, FastAPI.
•	Frontend: NextJS với Tailwind CSS.
•	Data Storage: PostgreSQL, Redis.
•	Agentic AI: LangGraph, LLM SDK/API, Tool Calling.
•	Demand Forecasting: Prophet.
•	Route Optimization: Google OR-Tools.
•	Source Control & CI/CD: Git/GitHub và pipeline CI/CD.
7.Demo dự kiến
Demo tập trung vào một luồng nghiệp vụ xuyên suốt:
Người dùng đăng nhập → tạo/cập nhật dữ liệu nghiệp vụ → phát sinh sự kiện → hệ thống kích hoạt chức năng AI phù hợp → kết quả được cập nhật về hệ thống → dashboard và thông báo phản ánh trạng thái xử lý.
Các kịch bản chính gồm:
•	Tạo đơn hàng và cập nhật tồn kho, từ đó kích hoạt quá trình dự báo nhu cầu.
•	Tạo shipment, từ đó hệ thống xây dựng phương án tuyến đường tối ưu dựa trên các ràng buộc vận chuyển.
•	Người dùng gửi yêu cầu nghiệp vụ bằng ngôn ngữ tự nhiên, Planner Agent phân tích và điều phối công cụ phù hợp.
•	Hệ thống hiển thị trạng thái đơn hàng, tồn kho, shipment, kết quả AI, thông báo và các chỉ số vận hành.
Phương pháp đánh giá dự kiến
•	Agentic Layer
o	Đánh giá tỷ lệ thực thi công cụ thành công trên tập kịch bản kiểm thử.
o	Đánh giá độ trễ xử lý và khả năng thay đổi thành phần AI thông qua interface chuẩn.
•	Demand Forecast Agent
o	Đánh giá bằng các chỉ số sai số như MAPE và RMSE.
o	So sánh với một hoặc một số phương pháp baseline phù hợp.
•	Route Optimizer Agent
o	Đánh giá mức độ cải thiện về quãng đường hoặc chi phí vận chuyển.
o	So sánh với phương pháp đối chứng phù hợp.
•	System
o	Đánh giá event processing latency, response time và khả năng chịu tải.
o	Kiểm tra khả năng auto-scaling dưới tải.
o	Kiểm thử idempotency, retry/fallback và multi-tenant isolation.
Các ngưỡng và tập benchmark cụ thể sẽ được xác định sau khi hoàn thiện thiết kế, dữ liệu và môi trường thực nghiệm.
Hướng phát triển:
Sau khi hoàn thiện phạm vi của khóa luận, hệ thống có thể tiếp tục được mở rộng theo các hướng sau:
•	Mở rộng năng lực Agentic AI: bổ sung các Agent mới phục vụ những bài toán logistics khác như dự báo thời gian giao hàng, tư vấn tồn kho, phát hiện bất thường và hỗ trợ lập kế hoạch chuỗi cung ứng.
•	Mở rộng khả năng tối ưu hóa và ra quyết định: bổ sung các bài toán tối ưu nhiều mục tiêu như chi phí vận chuyển, thời gian giao hàng, năng lực phương tiện và mức tồn kho, đồng thời hỗ trợ các ràng buộc nghiệp vụ phức tạp hơn.
•	Phát triển khả năng quan sát và phân tích nâng cao: mở rộng từ dashboard vận hành sang phân tích xu hướng, phát hiện bất thường và hỗ trợ ra quyết định dựa trên dữ liệu lịch sử.
•	Nghiên cứu và bổ sung các module chuyên sâu hơn: Digital Twin (xây dựng mô hình không gian ảo để mô phỏng và đánh giá các kịch bản vận hành chuỗi cung ứng), ETA Prediction (mô hình học máy dự báo thời gian giao hàng) và Inventory Advisor (hỗ trợ tư vấn và phát hiện bất thường trong quản lý tồn kho).
•	Mở rộng mô hình triển khai đa doanh nghiệp: tăng cường khả năng Multi-tenant theo hướng đáp ứng các yêu cầu khác nhau về dữ liệu, quyền truy cập, cấu hình nghiệp vụ và chính sách của từng doanh nghiệp.
•	Phát triển Digital Twin cho logistics: xây dựng mô hình mô phỏng chuỗi cung ứng và vận hành logistics để đánh giá các kịch bản, dự đoán tác động và hỗ trợ ra quyết định trước khi áp dụng vào hệ thống thực tế.
•	Tích hợp dữ liệu thời gian thực và dữ liệu bên ngoài: mở rộng khả năng tiếp nhận các nguồn dữ liệu như vị trí phương tiện, tình trạng giao thông, nhu cầu thị trường và các yếu tố môi trường để cải thiện chất lượng dự báo và tối ưu hóa.
•	Mở rộng khả năng thay thế và lựa chọn thành phần AI: cho phép sử dụng nhiều mô hình hoặc nền tảng AI khác nhau, bao gồm các mô hình chạy cục bộ hoặc trên hạ tầng riêng, mà không làm thay đổi đáng kể kiến trúc nghiệp vụ và Agentic Layer.
•	Mở rộng khả năng triển khai ở quy mô lớn: nghiên cứu các cơ chế phân bổ tài nguyên, auto-scaling, fault tolerance và tối ưu hiệu năng khi số lượng tenant, người dùng, sự kiện và tác vụ AI tăng lên.
•	Mở rộng đánh giá thực nghiệm: sử dụng các bộ dữ liệu thực tế hơn và các kịch bản tải lớn hơn để đánh giá độ chính xác, khả năng tối ưu, độ tin cậy và khả năng mở rộng của hệ thống trong các điều kiện gần với môi trường doanh nghiệp.
Kế hoạch thực hiện:
Đề tài được thực hiện theo 6 giai đoạn. Hai sinh viên có trách nhiệm chính theo từng nhóm công việc, đồng thời phối hợp trong các giai đoạn tích hợp, kiểm thử, đánh giá và hoàn thiện hệ thống.
Giai đoạn 1 – Phân tích và thiết kế
Cả hai sinh viên phối hợp thực hiện:
•	Phân tích yêu cầu, nghiệp vụ và phạm vi của hệ thống.
•	Xác định kiến trúc tổng thể, các thành phần nghiệp vụ và mối quan hệ giữa chúng.
•	Thiết kế các luồng xử lý đồng bộ và bất đồng bộ, domain event, interface và data contract.
•	Thiết kế Agentic Layer, cơ chế Tool Calling, Reliability, Multi-tenant và các tiêu chí đánh giá.
•	Xác định dữ liệu, baseline và kịch bản kiểm thử phục vụ đánh giá.
Đầu ra: tài liệu yêu cầu, kiến trúc hệ thống, data contract, luồng nghiệp vụ và kế hoạch benchmark.
Giai đoạn 2 – Phát triển nền tảng nghiệp vụ và hạ tầng
Sinh viên 1 – Nguyễn Quang Khải phụ trách chính:
•	Phát triển các chức năng nghiệp vụ cốt lõi gồm người dùng, phân quyền, đơn hàng, tồn kho, vận chuyển, phương tiện và thông báo.
•	Xây dựng cơ chế giao tiếp giữa các thành phần và xử lý sự kiện nghiệp vụ.
•	Thiết lập môi trường container và orchestration.
•	Xây dựng cấu hình triển khai, quản lý môi trường và khả năng mở rộng hệ thống.
•	Thiết lập các cơ chế giám sát và ghi nhận hoạt động hệ thống.
Sinh viên 2 phối hợp trong việc xác định interface, event contract và các điểm tích hợp với Agentic Layer.
Đầu ra: nền tảng nghiệp vụ có thể chạy độc lập, các interface tích hợp và môi trường triển khai ban đầu.
Giai đoạn 3 – Phát triển Agentic AI và các AI Agent
Sinh viên 2 – Lê Bùi Quốc Huy phụ trách chính:
•	Xây dựng Agentic Layer và cơ chế điều phối, thực thi Agent, Tool Calling.
•	Phát triển Planner Agent, Demand Forecast Agent và Route Optimizer Agent.
•	Chuẩn bị và xử lý dữ liệu phục vụ dự báo và tối ưu.
•	Xây dựng các mô hình hoặc thuật toán phù hợp cho từng bài toán.
•	Xây dựng baseline và bộ kịch bản kiểm thử cho các Agent.
Sinh viên 1 phối hợp trong việc cung cấp interface, dữ liệu nghiệp vụ và các luồng sự kiện cần thiết cho Agent.
Đầu ra: các Agent và Tool có thể thực thi độc lập, bộ dữ liệu và baseline phục vụ đánh giá.
Giai đoạn 4 – Tích hợp và hoàn thiện hệ thống
Cả hai sinh viên phối hợp thực hiện:
•	Tích hợp nền tảng nghiệp vụ với Agentic Layer thông qua các interface và cơ chế giao tiếp đã thiết kế.
•	Kết nối các Agent với các luồng nghiệp vụ và sự kiện tương ứng.
•	Hoàn thiện Multi-tenant Isolation, Timeout, Retry, Fallback và Idempotency.
•	Kiểm tra tính nhất quán dữ liệu và độ ổn định của các luồng xử lý bất đồng bộ.
•	Kiểm tra khả năng mở rộng và khả năng thay đổi thành phần AI thông qua các interface đã chuẩn hóa.
Đầu ra: hệ thống tích hợp hoàn chỉnh và các luồng nghiệp vụ chính hoạt động xuyên suốt.
Giai đoạn 5 – Kiểm thử và đánh giá
Cả hai sinh viên phối hợp thực hiện:
•	Kiểm thử chức năng và các luồng tích hợp chính.
•	Thực hiện load test, idempotency test và kiểm tra các cơ chế retry/fallback.
•	Đánh giá Agentic Layer về độ tin cậy, khả năng thực thi Tool và khả năng thay đổi thành phần AI.
•	Đánh giá Demand Forecast Agent bằng các chỉ số sai số và baseline tương ứng.
•	Đánh giá Route Optimizer Agent bằng các chỉ số hiệu quả tối ưu và baseline.
•	Đánh giá hệ thống về event processing latency, response time và khả năng auto-scaling.
•	Tổng hợp và phân tích kết quả thực nghiệm.
Đầu ra: bộ kết quả benchmark, báo cáo kiểm thử và đánh giá hệ thống.
Giai đoạn 6 – Demo và hoàn thiện
Cả hai sinh viên phối hợp thực hiện:
•	Hoàn thiện phiên bản demo tích hợp.
•	Xây dựng và kiểm tra các kịch bản demo end-to-end.
•	Chuẩn hóa dữ liệu, môi trường và tài liệu phục vụ trình diễn.
•	Hoàn thiện kết quả đánh giá, tài liệu kỹ thuật và báo cáo khóa luận.
•	Chuẩn bị nội dung và kịch bản bảo vệ.
Đầu ra: phiên bản demo cuối cùng, báo cáo khóa luận, tài liệu kỹ thuật và nội dung bảo vệ.
Phân công tổng quát
•	Sinh viên 1: phụ trách chính nền tảng nghiệp vụ, tích hợp hệ thống, hạ tầng triển khai và vận hành.
•	Sinh viên 2: phụ trách chính Agentic AI, AI/ML, dữ liệu và đánh giá AI.
•	Cả hai: cùng tham gia thiết kế, tích hợp, kiểm thử, benchmark, demo và hoàn thiện khóa luận.
•	Công nghệ và framework cụ thể được lựa chọn trong quá trình triển khai dựa trên yêu cầu kỹ thuật, khả năng tích hợp, hiệu năng và phạm vi thực hiện.
Xác nhận của CBHD
(Ký tên và ghi rõ họ tên)




TS. Đỗ Thị Thanh Tuyền	TP. HCM, ngày 07 tháng 09 năm 2026
Sinh viên
(Ký tên và ghi rõ họ tên)

	Sinh viên 1



Nguyễn Quang Khải 	Sinh viên 2 



Lê Bùi Quốc Huy

