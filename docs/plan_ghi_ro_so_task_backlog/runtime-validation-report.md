# GĐ5D — Runtime validation và benchmark

**Ngày:** 2026-10-17. **Kết luận: FAIL / chưa nghiệm thu GĐ5D.**

Nguồn yêu cầu: [kế hoạch chính §7.5–7.7](./ke-hoach-trien-khai-quan-ly-don-hang.md)
và [SC-001–012](./quan-ly-don-hang-backend-frontend.md).
Không dùng browser theo xác nhận của người dùng. Việc bỏ browser không phải do
thiếu công cụ và không được coi là nghiệm thu UI.

## 1. Kết quả và phạm vi

| Nhóm | Kết quả | Exit code | Bằng chứng |
|---|---|---:|---|
| Unit/regression nguồn | PASS | 0 | 449 tests: Order 245, Inventory 48, Fulfillment 94, Master Data 10, Gateway 1, auth 31, messaging 16, Identity catalogue 1, logger 3 |
| Build/lint/source typecheck | PASS | 0 | Năm service, messaging; logger build/typecheck và lint bằng oxlint có sẵn của workspace |
| Frontend `pnpm validate` | PASS | 0 | Lint, typecheck, production build; không chứng minh browser |
| Functional API/integration sau sửa logger | PASS | 0 | 72 assertion có tên qua Gateway/PostgreSQL/Kafka thật, gồm setup và assertion dùng lại trong race |
| Supplement mở rộng | FAIL | 1 | Đã qua 97 assertion trước khi timeout ở kiểm tra persisted outbox retry; không gọi toàn suite PASS |
| Benchmark lần đầu | FAIL | 1 | Đủ 600 giây; có 500 và p95 create vượt mục tiêu; trùng thời gian build Frontend |
| Benchmark độc lập | FAIL | TERMINATED | Đủ 600 giây và ghi FAIL; observer tiếp tục retry nên caller được dừng sau cleanup, không có normal exit code |
| Browser/visual | UNVERIFIED | N/A | Người dùng yêu cầu không chạy |

Các số unit là **449 test nguồn riêng biệt**, không cộng lặp các lần chạy hay
test sinh ra trong thư mục build. Baseline 446 đã chạy trước sửa logger;
ba regression logger chạy sau sửa. Không có thay đổi nghiệp vụ Order/Inventory/
Fulfillment trong batch này.

### Thay đổi code đã xác minh

Logger dùng chung trước đây che `Authorization` và cookie nhưng bỏ sót
`x-internal-service-token`. Đã thêm đường dẫn redaction cho header này trong
[logger.module.ts](../../libs/logger/src/logger.module.ts), không thay token,
guard, quyền hoặc auth protocol.

[Regression lâu dài](../../libs/logger/src/logger.module.spec.ts) kiểm tra
development/production, không còn token thô, vẫn giữ correlation và các đường
redaction cũ. Trước sửa: 2 failed / 1 passed, exit 1, đúng lỗi cần phát hiện.
Sau sửa: 3 passed, exit 0; typecheck/build và lint đều exit 0.
Lệnh source-only cuối: `pnpm --filter @logix/logger exec vitest run src`,
tránh đếm lại bản test đã compile trong `dist`.

Lệnh `pnpm --filter @logix/logger lint` hiện không resolve được binary oxlint
trong package đó. Đã dùng binary có sẵn, không thêm dependency:
`pnpm --filter order-service exec oxlint <absolute-path-to-libs-logger-src>`.
Đây là thay thế cách gọi công cụ, không bỏ kiểm tra lint.

## 2. Môi trường và cách cô lập

- Windows, Node v22.19.0; Docker daemon 29.7.2 hoạt động.
- Nest AppModule thật của Master Data, Inventory, Order, Fulfillment và Gateway;
  mỗi host có port riêng và được xác minh bằng route thực trả 2xx.
- PostgreSQL 17 dùng server local có sẵn, nhưng mỗi service có **database QA
  riêng**, tạo/migrate bằng role của chính service. Không đọc DB chéo trong
  application code; harness chỉ kiểm tra persistence và tiêm lỗi QA.
- Kafka 4.1.1 container riêng, 2 CPU / 1536 MiB; ba topic, mỗi topic ba partition;
  group/client riêng. Không dừng, reset offset hay xóa topic của broker dùng chung.
- UUID tenant/actor riêng, JWT QA ký bằng secret ngẫu nhiên chỉ tồn tại trong
  process QA. Không đăng nhập/seed Identity, không đổi tài khoản hay role thật.
- Master Data và Inventory API thật; hai SKU, một kho, customer/ship-to giả lập.
  Stock được nhập qua Gateway; không cần AI/model service.
- QA relay: interval 100 ms, batch 100, retry 100–2000 ms, transaction 15000 ms.
  Reconciler: age 60000 ms, interval 5000 ms. Đây là profile đo được công bố,
  **không phải thay đổi env local hoặc cấu hình production**.

Đã viết bốn file journey tạm: lifecycle, race/replay/recovery, supplement và
benchmark; dùng driver chung setup → action → read-back → cleanup.
Legacy source regressions được giữ và chạy bằng Vitest hiện có; không thêm
framework test hoặc dependency sản phẩm.

## 3. Bằng chứng functional và recovery

Lệnh cuối sau sửa logger:

```text
node qa5d-runtime.mjs --functional-only
exit_code: 0
run: qa5d_1792227358381
```

Thời gian: 08:55:58.381–08:57:09.074 UTC. Năm log service sau sửa không còn JWT
thô hoặc marker dữ liệu cá nhân QA; 95 header token nội bộ được che.
Run ID thực tế và thời gian được lưu trong kết quả JSON của phiên; không dùng
run ID làm input của product code. Tổng 72 assertion không phải 72 HTTP request.
Các request kiểm tra mã lỗi không được cộng thành test riêng.

Các luồng đã quan sát:

- Draft create/list/search/detail/update/cancel; không thay on-hand/reserved.
  Mười replay cùng key trả một Order, đổi body với cùng key trả 409.
  Hai edit cùng version có một thành công và một 409.
- Thiếu token/claim/quyền bị chặn; Order tenant khác không đọc/sửa/hủy được.
  Supplement kiểm tra từng command Shipment với 401/403/tenant 404.
- Tiêm lỗi insert line trong DB QA: không để lại Order header hoặc outbox.
  Totals decimal, timeline và version được đọc lại từ persistence.
- Thiếu một trong nhiều SKU: PENDING_STOCK, có shortage, không reserve một phần.
- Confirm → pool → picking → ready → dispatch → ISSUE đúng một lần →
  delivered → Order COMPLETED. Có exact dispatch replay và public grant fields.
- Shipment giữ snapshot cũ khi Master Data đổi. Pool filter, date validation,
  stale version và confirmation/reason không hợp lệ trả lỗi rõ ràng.
- Cancel ở PENDING_PICK/PICKING/READY trước grant giải phóng stock;
  sau grant bị chặn ngay cả khi Order projection vẫn READY.
  DELIVERY_FAILED giữ reason đã trim, không được hủy hoặc mở giao lại.
- 12 cặp cancel/dispatch đồng thời: cả 12 lượt này cancel thắng; không suy ra
  tính công bằng. Supplement thêm bốn lịch dispatch thắng, cancel fresh-version
  nhận 409. Không có đôi bên cùng thành công.
- Replay lịch sử event Order/Shipment bằng event ID cũ và mới không tạo thêm
  shipment/reservation/ISSUE, không kéo Order COMPLETED lùi trạng thái.
- Dừng consumer Fulfillment QA, confirm Order, bật lại: shipment xuất hiện.
  Pause broker QA ngắn: business write/outbox vẫn durable, tự publish và hội tụ
  khi broker hoạt động lại.
- Supplement: mất HTTP response sau khi Order commit grant, intent vẫn PENDING;
  restart Fulfillment tự replay intent gốc, một dispatch event và một ISSUE.
- Supplement: trigger lỗi ở SKU thứ hai đã được consumer thật chạm tới;
  rollback toàn bộ balances/movements/group, bỏ trigger thì Kafka tự retry thành
  công cho cả hai SKU.
- Hai endpoint `/internal` không được Gateway public route.
- Mã Order giống nhau được DB chấp nhận ở hai tenant; public reads vẫn cách ly.
  Fixture kiểm tra uniqueness này được tạo trực tiếp trong DB QA, không phải
  bằng chứng create cross-tenant qua UI.

**Giới hạn quan trọng:** Supplement có các assertion trên đã đạt nhưng **toàn
command vẫn exit 1** ở ca outbox bên dưới. Không dùng partial pass để miễn lỗi.

## 4. Các blocker còn lại

| # | Phát hiện | Bằng chứng | Trạng thái |
|---|---|---|---|
| D-01 | Token nội bộ xuất hiện trong HTTP log | Header `x-internal-service-token` bị bỏ sót; đã có negative/positive regression và kiểm tra runtime sau sửa | Đã sửa |
| D-02 | Producer retry có thể sống lâu hơn transaction giữ lock outbox | Kafka produce timeout/retry; transaction 15000 ms đã hết hạn khi query markPublished chạy sau 75086 ms, Prisma P2028 | Chưa sửa |
| D-03 | Không quan sát được attemptCount/lastError commit trong 75 giây outage | Cả broker pause/blackhole và stop/start riêng đều timeout ở assertion persisted relay failure | Chưa đạt |
| D-04 | 500 và pool/transaction-start timeout dưới profile tải | Lượt đầu 51 non-2xx; lượt độc lập 69 non-2xx, log `Unable to start a transaction in the given time` | Chưa sửa/chưa chốt root cause toàn bộ |
| D-05 | Broker QA Kafka 4.1.1 coordinator lỗi nội bộ | `ArrayIndexOutOfBoundsException: Histogram recorded value cannot be negative` tại CoordinatorRuntimeMetricsImpl; coordinator unavailable | Blocker hạ tầng, chưa có benchmark ổn định |

Không kết luận mất business event: write vẫn có outbox durable. Tuy nhiên
**chưa chứng minh được persisted retry/backoff và phục hồi đầy đủ trong outage
dài**, nên SC-011 chưa được nghiệm thu. Không có waiver cho các lỗi này.

Không tự tách sinh mã Order khỏi transaction: QĐ-7 và §4.3 của kế hoạch yêu cầu
counter, header/lines, history, outbox nằm trong transaction tạo đơn. Chưa có
profiling lock đủ để quy toàn bộ lỗi pool cho counter; không đổi policy theo suy đoán.
Không tăng timeout hoặc tắt consumer chỉ để biến benchmark thành PASS.

Lỗi Kafka histogram chưa được quy nguyên nhân cho ứng dụng hoặc clock host;
log hiện chỉ đủ kết luận broker/coordinator không khỏe. Lệnh restart broker QA
được thử sau đo nhưng container đã được harness xóa, không restart gì.

## 5. Benchmark SC-012

**Cả hai lượt:** autocannon 8, 100 kết nối/VU, pipelining 1, 600 giây,
giới hạn tổng **100 request/giây** (pacing khoảng một request/VU/giây).
Mỗi connection lặp list → detail → create → confirm, create key riêng và confirm
dùng ID/version thực của create. Inventory/Master Data/consumers đều bật.
Generator chạy cùng máy; PostgreSQL server dùng chung; không phải bài đo
saturation không giới hạn hay chứng nhận capacity cho production.

| Chỉ số | Lượt đầu, có build trùng thời gian | Lượt độc lập, không có build/test song song |
|---|---:|---:|
| Duration thực | 600.72 s | 600.97 s |
| Request hoàn thành | 55,193 | 44,465 |
| List / detail / create / confirm | 13,850 / 13,818 / 13,782 / 13,743 | 11,170 / 11,149 / 11,095 / 11,051 |
| Non-2xx | 51 | 69 |
| Transport errors / timeout của autocannon | 0 / 0 | 0 / 0 |
| p95 API gộp đo tại client | 1,876.59 ms | **2,837.45 ms** |
| p95 list | 944.13 ms | 1,369.25 ms |
| p95 detail | 1,536.46 ms | **2,368.69 ms** |
| p95 create | **2,676.44 ms** | **3,976.31 ms** |
| p95 confirm | 1,078.74 ms | 1,550.57 ms |
| p99 list / detail / create / confirm | 1,231.60 / 2,291.48 / 3,457.43 / 1,392.33 ms | 1,757.04 / 2,855.33 / 4,870.31 / 2,028.62 ms |
| Autocannon corrected p90 / p97.5 / p99 | 1,457 / 2,620 / 4,815 ms | 1,977 / 3,063 / 3,660 ms |
| Confirmed Orders | 13,757 | 11,040 |
| Publish→effect samples | 13,719 | 8,733 |
| Publish→effect p95 / max quan sát | 1,251 / 8,401 ms | 1,203 / 37,613 ms |

API percentile theo endpoint đo từ gửi request đến response; histogram
coordinated-omission-corrected của autocannon được công bố riêng, không đánh đồng
với percentile endpoint. Không có API error nào bị loại để làm đẹp latency.

Publish→effect dùng **Kafka record timestamp** của OrderConfirmed tới lần đọc
DB thành công đầu tiên thấy Shipment đã commit, qua consumer quan sát có group
riêng; là upper bound có sampling mỗi giây, không phải `createdAt`/`publishedAt`
proxy. Không đo toàn bộ Inventory ISSUE hay thời gian browser.
Consumer quan sát bị coordinator failure ở lượt độc lập; số mẫu thiếu đuôi và
có thể thiên lệch. **Không dùng p95 quan sát thấp hơn 3 giây để tuyên bố SC-012
đạt.** Các lượt đo đều trước sửa logger; chưa có benchmark sau sửa logger.

Một lần chuẩn bị đo lại dừng trước benchmark vì `fetch failed`; không có số tải
của lượt đó. Harness sau đó dùng connection đóng riêng cho setup/probe để tránh
tái sử dụng socket idle; autocannon vẫn dùng 100 connection persistent.
Một fixture nullable JSON lúc đầu sai SQL NULL/JSON null đã sửa; lỗi fixture
không phải thay đổi schema hoặc production code.

## 6. Đối chiếu SC

| SC | Bằng chứng | Kết luận |
|---|---|---|
| 001 | Draft CRUD/search/API thật và rollback | API đạt trong functional; UI chưa nghiệm thu |
| 002 | Tenant negative Order/Shipment; DB uniqueness theo tenant | Đạt phạm vi API/DB đã kiểm tra; không thay thế toàn ma trận UI |
| 003 | Mười create replay; edit race một winner, một 409 | Đạt functional |
| 004 | Draft create/edit/cancel giữ balances | Đạt functional |
| 005 | Timeline/version/trace; lỗi insert line rollback header/outbox | Đạt phạm vi đã kiểm tra |
| 006 | GĐ5C logic/handler/build | UI loading/error/conflict/toast chưa nghiệm thu browser |
| 007 | Functional chạy không có AI/model service | API đạt; thao tác người dùng trên UI chưa nghiệm thu |
| 008 | Full/shortage all-or-nothing, cancel/release | Đạt functional; giữ bằng chứng FIFO GĐ4, không tuyên bố đo lại mọi case GĐ4 |
| 009 | Exact command replay; event ID cũ/mới; one Shipment/ISSUE | Đạt phạm vi replay đã kiểm tra |
| 010 | Grant-aware cancel; delivered/failed; projection monotonic | Đạt functional |
| 011 | Consumer restart, outage ngắn, lost grant response, ISSUE rollback retry | **Chưa đạt toàn bộ:** outage dài/persisted relay retry và lỗi broker còn blocker |
| 012 | Hai lượt 100 VU/600 giây có báo cáo latency/lỗi | **Chưa đạt mục tiêu / chưa có benchmark khỏe** |

## 7. Cleanup và ranh giới vận hành

- Toàn bộ database QA của từng service, broker/topic/group QA và application host
  đã dọn. Query `pg_database` theo namespace QA không còn database; Docker không
  còn container QA. Process caller của lượt đo có Kafka observer retry sau khi
  báo cáo được ghi đã được dừng bằng đúng shell ID, không kill theo tên process.
  Lượt này đã đặt exit code dự kiến 1 nhưng không tự thoát; không ghi nhận nó
  như một command kết thúc bình thường với exit 1.
- Một lượt outage dài cần force-stop host Order sau graceful shutdown timeout;
  không coi đó là phục hồi/graceful-shutdown PASS.
- Log trước sửa chỉ chứa JWT QA tạm, nhưng vẫn là lỗi redaction cần sửa.
  Không sao chép log/token vào repository; log và script/dependency tải tạm
  được xóa sau trích bằng chứng. Kết quả JSON không chứa token/secret giữ trong
  session evidence; permanent logger regression được giữ.
- Không sửa ignored env, không đổi secret, không tạo user/role thật, không
  backfill Shipment demo. Dữ liệu demo Công ty Ahihi giữ nguyên.
- Kafka/PostgreSQL dùng chung không bị dừng; Frontend port 3009/PID 27336
  vẫn giữ nguyên. Không tạo commit.

## 8. Verdict và phần việc tiếp theo

```yaml
environment:
  docker: AVAILABLE — daemon 29.7.2; dedicated QA broker encountered coordinator failure
  node: AVAILABLE — v22.19.0
  playwright: NOT_ATTEMPTED_USER_REQUEST
  infra-tier: PRIMARY — real PostgreSQL and isolated Docker Kafka, no in-memory fallback
  browser-tier: SKIPPED — user explicitly excluded browser; UI remains unverified
startup: PASS — real Nest hosts and route 2xx readiness, about 1.5–3.2 seconds in final functional run
integration: PASS — exit_code: 0, assertions: 72, failed: 0, functional lifecycle/replay/short-outage recovery only
e2e: FAIL — exit_code: 1, extended outage/persisted retry and measured load assertions failed; browser unverified
overall: FAIL — G5-D02/G5-D03 remain blocked; no waiver, no phase-five sign-off
```

Thứ tự tiếp theo: giới hạn producer retry/request budget phù hợp transaction
relay và cả batch; đo contention/transaction wait bằng profiling; ổn định broker
QA; chạy lại đầy đủ outage/recovery và 100 VU/600 giây sau sửa. Giữ QĐ-7 và
quy tắc ordering/idempotency, không thay thiết kế lock/claim nếu chưa duyệt.
UI vẫn cần nghiệm thu riêng nếu người dùng mở lại phạm vi browser.
