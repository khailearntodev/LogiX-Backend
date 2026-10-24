# Execution Plan: Planner Graph, Tool Registry Wiring & Confirmation Gate

Date: 2026-10-18

## Status

Active (chờ review trước khi triển khai)

## Outcome

Agent-service có **một** luồng chat duy nhất, gọi tool qua `ToolRegistry` (lọc
theo quyền của actor), và dừng chờ người dùng xác nhận trước mọi thao tác ghi.
Quan sát được:

1. User hỏi dữ liệu (tồn kho, sản phẩm) → agent gọi tool đọc qua registry, trả
   lời có căn cứ.
2. User yêu cầu "xác nhận đơn X" → agent gọi `confirm-preview`, phát event
   interrupt kèm preview và `approval_id`, graph checkpoint và dừng.
3. User `APPROVE` qua `POST /api/v1/agent/executions/{id}/decisions` → agent
   kiểm lại actor/tenant/version rồi gọi `POST /orders/:id/confirm`, stream kết
   quả. `REJECT` hoặc hết hạn → huỷ, không có side effect.
4. Tool bị thiếu quyền không xuất hiện trong danh sách tool của model.

## Context

- Backlog: `ai-copilot-task-backlog.tmp.md` (Issue 2 và 3).
- Thiết kế: [ai-services-technical-design.md](../../architecture/ai-services-technical-design.md)
  §8.3 (graph state), §8.4 (planner graph), §8.6 (tool registry), §8.7
  (confirmation protocol), §8.8 (API), §8.9 (persistence).
- Plan liên quan: [2026-09-27-agentic-ai-foundation.md](2026-09-27-agentic-ai-foundation.md),
  [2026-10-11-agent-chat-vertical-slice.md](2026-10-11-agent-chat-vertical-slice.md).
- Hiện trạng (đã đối chiếu code 2026-10-18):
  - Luồng **official** `modules/agent/` (`create_agent`, 3 tool `@tool` viết
    cứng, gọi Gemini thẳng, có middleware retry/lỗi, `RunLogHandler`).
    Endpoint `/api/v1/agent/official/runs`.
  - Luồng **custom** `modules/planner/chat_graph.py` (1 node, qua
    `ModelGateway`, **không gọi được tool**: `ModelGatewayChatModel` thiếu
    `bind_tools` và làm mất `tool_calls`). Endpoint `/api/v1/agent/runs`, là
    endpoint FE đang trỏ tới.
  - `ToolRegistry` + catalog `inventory`/`master_data` (chỉ READ) đã có và test
    xong nhưng chưa được graph nào dùng.
  - Bảng `agent_executions`, `tool_calls`, `confirmation_requests`,
    `conversations`, `conversation_messages` đã có model + migration.
  - JWT identity-service mang `role`, `permissions`; `list_for(actor)` dùng được.
  - order-service có `GET :id/confirm-preview`, `POST :id/confirm {version}`,
    `POST :id/cancel`.
  - `psycopg`, `langgraph-checkpoint-postgres`, `HumanInTheLoopMiddleware` đã cài.
  - Docker không chạy trong phiên lập plan: chưa kiểm chứng được với Postgres thật.

## Scope

In scope:

- Chọn luồng official làm nền, gộp luồng custom vào (một endpoint chat).
- Nối `ToolRegistry` vào graph, thay 3 tool viết cứng.
- Graph tường minh: `verify_context → filter_tools → agent(model) → policy →
  execute | preview → confirm(interrupt) → revalidate → execute → agent`.
- Tool ghi đầu tiên: `confirm_order` (preview → confirm với `version`).
- Bảng `confirmation_requests`: tạo, ràng buộc tenant/user/action/target/version,
  hết hạn, dùng một lần (`CONSUMED`).
- Endpoint `POST /api/v1/agent/executions/{id}/decisions` (stream SSE).
- Postgres checkpointer cho pause/resume; ghi `agent_executions`,
  `tool_calls`, `conversation_messages`.
- Test: graph routing, permission filtering, gate, thread/tenant isolation.

Out of scope:

- `cancel_order` và các tool ghi khác (làm sau khi gate ổn).
- Tool Forecast / Route Optimizer (Issue 4).
- `ModelGateway.stream()` (token streaming thật).
- Sửa Frontend (xem Risks: contract interrupt cần phối hợp).
- Kafka/outbox publish `AgentExecutionCompleted`.
- Idempotency-key HTTP header ở mức API (chỉ idempotency trong gate).

## Approach

### Phase 0 — Chốt contract (không viết code nghiệp vụ)

1. Xác nhận cách `ag-ui-langgraph` phát interrupt (event `CUSTOM`
   `on_interrupt`?) và cách resume qua `Command(resume=...)` trên bản 0.0.47.
2. Xác nhận field `version` của order trong `confirm-preview` và response
   của `GET /orders/:id`.
3. Ghi contract event interrupt + body `/decisions` vào plan (mục Decisions).
   FE dùng contract này để làm UI xác nhận.

### Phase 1 — Hợp nhất luồng và nối ToolRegistry

1. `modules/agent/tools.py`: bỏ 3 tool viết cứng; dùng
   `tools_for_actor(registry, ToolContext)`. Tool dựng **mỗi request** từ actor
   đã verify (token không đi vào checkpoint, theo §8.3).
2. Một endpoint chat duy nhất `/api/v1/agent/runs` (đúng URL FE đang gọi); gỡ
   `/official/runs` và luồng `chat_graph.py` khi test tương đương đã chuyển.
3. Giữ `RunLogHandler`, middleware retry/lỗi, `ThreadRegistry`.
4. Test cũ của hai luồng chuyển sang luồng hợp nhất, không xoá bỏ kiểm tra nào.

### Phase 2 — Graph tường minh và policy

1. `modules/planner/state.py`: `PlannerState` (theo §8.3, không chứa token).
2. `modules/planner/nodes.py`: node xác định `verify_context`, `filter_tools`,
   `policy`; node LLM `agent`; node `execute`.
3. Edge điều kiện: có tool call? → có tool `is_sensitive`? → `preview`,
   ngược lại `execute`; kết quả tool → quay lại `agent` hoặc kết thúc.
4. `policy`: validate tham số bằng `input_model`, chặn tool ngoài danh sách đã
   lọc quyền.
5. Giới hạn vòng lặp (số bước tối đa) lấy từ config.

### Phase 3 — Tool ghi `confirm_order` và preview

1. Catalog `order`: `get_order` (READ) và `confirm_order` (WRITE,
   `required_permission` từ hằng số permission của order-service).
2. `ToolSpec` bổ sung hook `preview` (gọi `GET confirm-preview`); chỉ tool
   `is_sensitive` mới có.
3. `ServiceClient` dùng `POST` không retry (đã có).

### Phase 4 — Confirmation gate và `/decisions`

1. `modules/confirmations/service.py`: tạo `ConfirmationRequest`
   (`PENDING`, `expires_at` từ config, `context_hash` = hash của
   tenant+user+action+target+version+tham số đã sanitize).
2. Node `confirm`: `interrupt({approval_id, preview, action, target})`;
   checkpoint do Postgres saver giữ.
3. `POST /api/v1/agent/executions/{id}/decisions`: auth → kiểm execution thuộc
   actor → kiểm approval `PENDING`, chưa hết hạn, `context_hash` khớp → đổi
   `CONFIRMED`/`REJECTED` → resume graph bằng `Command(resume=...)` → stream SSE.
4. Node `revalidate`: gọi lại preview, so `version`; lệch → `STALE`, không
   thực thi, báo user preview lại.
5. Sau thực thi: `CONSUMED`; `REJECTED`/`EXPIRED` → huỷ không side effect.
6. Client không được gửi `command`/`resume` qua AG-UI (giữ quy tắc bỏ
   `forwardedProps`).

### Phase 5 — Persistence

1. `AsyncPostgresSaver` thay `InMemorySaver` khi có `DATABASE_URL`; không có
   thì **fail closed** ở môi trường non-development (không fallback im lặng).
2. Ghi `agent_executions` (RUNNING → WAITING_CONFIRMATION → SUCCEEDED/FAILED),
   `tool_calls` (input/output đã sanitize), `conversation_messages`.
3. Thread ownership chuyển từ in-memory sang kiểm theo bảng `conversations`
   (tenant + user).

### Phase 6 — Validation và tài liệu

1. Test theo mục Validation.
2. README agent-service (env mới), cập nhật contract trong
   `docs/architecture/`, ADR ngắn nếu chốt bỏ luồng custom.

## Risks And Recovery

- **Interrupt/resume qua AG-UI ở `ag-ui-langgraph` 0.0.x chưa chắc đúng như
  kỳ vọng.** Mitigation: Phase 0 spike trước; dự phòng là tự phát event
  `CUSTOM` bằng `ag_ui.core` (graph không đổi).
- **FE chưa có UI xác nhận.** Backend phát event + `/decisions`; FE cần làm
  `useInterrupt`/component xác nhận. Phối hợp contract ở Phase 0; tới khi FE
  xong, test bằng `curl`.
- **Không có Postgres trong phiên này** (Docker tắt). Test dùng
  `InMemorySaver` + fake repository; phần chạy trên Postgres thật được ghi rõ
  là *chưa kiểm chứng* trong Result cho tới khi chạy được.
- **Gỡ luồng custom làm mất `ModelGateway`** (profile, fallback, LiteLLM).
  Mitigation: bước riêng cuối plan để thêm `bind_tools` + map `tool_calls` cho
  `ModelGatewayChatModel`; trong lúc đó dùng `init_chat_model` như luồng official.
- **Permission claim thiếu → không có tool nào** (đúng hướng fail closed).
  Mitigation: log cảnh báo khi `list_for` trả rỗng; kiểm bằng token thật.
- **Race hai lần Approve.** Mitigation: unique index `ux_pending_tool_confirmation`
  và `ux_confirmation_context_consumed` đã có; chuyển trạng thái trong một
  transaction.
- Recovery: mọi thay đổi là additive trừ việc gỡ endpoint cũ; revert commit
  khôi phục hai luồng cũ. Schema DB không đổi (dùng bảng sẵn có).

## Progress

### Phase 0: Contract

- [x] Spike interrupt/resume với `ag-ui-langgraph` 0.0.47.
- [x] Xác nhận `version` của order qua preview/get.
- [x] Ghi contract event interrupt + `/decisions` vào Decisions.

### Phase 1: Hợp nhất luồng, nối registry

- [x] Tool dựng từ `ToolRegistry` theo actor mỗi request.
- [x] Một endpoint `/api/v1/agent/runs`.
- [x] Chuyển test hai luồng sang luồng hợp nhất.
- [x] Gỡ `/official/runs` và `chat_graph.py` (hợp nhất endpoint `POST /api/v1/agent/runs`).

### Phase 2: Graph và policy

- [x] `PlannerState`.
- [x] Node verify_context / filter_tools / policy / execute.
- [x] Edge điều kiện và giới hạn số bước.
- [x] Test routing xác định với model giả.

### Phase 3: `confirm_order`

- [x] Catalog order: `get_order`, `confirm_order`.
- [x] Hook preview trong `ToolSpec`.
- [x] Test tool (thành công, 403, 409, version lệch).

### Phase 4: Gate và `/decisions`

- [x] Service tạo/đổi trạng thái `ConfirmationRequest`.
- [x] Node confirm (interrupt) + revalidate.
- [x] Endpoint `/decisions` + SSE.
- [x] Test: approve, reject, expire, stale, replay, người khác, tenant khác.

### Phase 5: Persistence

- [x] Postgres saver, fail closed ngoài development.
- [x] Ghi executions, tool_calls, messages.
- [x] Thread ownership theo DB.

### Phase 6: Tài liệu và kiểm tra

- [x] README + contract + ADR.
- [x] `pytest apps/agent-service/tests`, `ruff`, repo proof.

## Decisions

- 2026-10-18: Dùng luồng official làm nền, vì luồng custom không gọi được tool
  (adapter thiếu `bind_tools`/`tool_calls`) và luồng official đã có tool loop,
  middleware lỗi, logging.
- 2026-10-18 (mặc định, chờ review): xác nhận qua endpoint riêng
  `/decisions` (design §8.8), không qua `forwardedProps`, để giữ quy tắc bỏ
  input điều khiển từ client.
- 2026-10-18 (mặc định, chờ review): tool ghi đầu tiên là `confirm_order`
  (order-service đã có preview + version); `cancel_order` làm sau.
- 2026-10-18 (mặc định, chờ review): Postgres checkpointer; không lưu access
  token trong checkpoint, tool dựng lại từ token của request resume.

## Validation

- Focused proof:
  - Graph routing: không tool → kết thúc; tool đọc → execute; tool ghi →
    preview → interrupt.
  - Permission filtering: tool thiếu quyền không vào danh sách model; gọi
    trực tiếp bị từ chối.
  - Gate: approve/reject/expire/stale/replay; approval không dùng lại cho
    tenant, actor, action, target khác.
  - Token không nằm trong state/checkpoint.
- Integration or end-to-end proof:
  - Qua gateway thật với identity + order-service + inventory + master-data:
    chat đọc dữ liệu; yêu cầu xác nhận đơn → interrupt → `/decisions` →
    đơn `CONFIRMED`.
  - Cross-tenant: thread/execution/approval của tenant khác → 404 / 403.
- Repository-required checks:
  - `pytest apps/agent-service/tests` (153 passed / 153 tests).
  - `ruff check apps/agent-service` (All checks passed).
  - `ruff format --check apps/agent-service` (All formatted).

## Result

- Triển khai thành công StateGraph LangGraph cho Planner Agent (`build_planner_graph`) gồm 5 nodes: `agent` -> `preview` -> `confirm` (interrupt) -> `revalidate_and_execute` -> `execute_tool`.
- Tích hợp động `ToolRegistry` lọc theo Actor permissions (đã bổ sung catalog `list_orders`, `get_order`, và hành động nhạy cảm `confirm_order` với cơ chế preview).
- Triển khai `ConfirmationService` quản lý vòng đời yêu cầu phê duyệt (PENDING, CONFIRMED, REJECTED, EXPIRED, CONSUMED) với hashing SHA-256 bảo vệ toàn vẹn ngữ cảnh.
- Hợp nhất endpoint SSE chính tại `POST /api/v1/agent/runs` và endpoint phê duyệt `POST /api/v1/agent/executions/{execution_id}/decisions`.
- Đảm bảo an toàn bảo mật tuyệt đối: Access token JWT không bao giờ được ghi vào checkpoint hay state của LangGraph.
- Hoàn thành toàn bộ test suites với 153/153 tests passed, code chuẩn hóa Ruff lint & format không lỗi.
