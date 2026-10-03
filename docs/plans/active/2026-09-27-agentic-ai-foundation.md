# Execution Plan: Agentic AI Foundation — ModelGateway Chuẩn Hóa & Planner Agent

Date: 2026-09-27

## Status

Active

## Outcome

Agent Service có nền tảng Agentic AI hoạt động: (1) ModelGateway chuẩn hóa đa
nhà cung cấp với LiteLLM adapter bổ sung bên cạnh Gemini adapter hiện tại,
(2) Planner Agent điều phối yêu cầu đầu tiên dựa trên LangGraph với
intent classification, permission-filtered tool selection và read-only tool
execution, (3) AgentRegistry với allow-list, (4) execution API và
persistence lifecycle, (5) PostgreSQL checkpointer.

## Context

- [ai-services-technical-design.md](../../architecture/ai-services-technical-design.md)
  — §5 (kiến trúc), §8 (Agent Service), §8.4 (Planner graph), §8.5
  (ModelGateway/LiteLLM), §8.6 (Tool registry), §17 (Testing)
- [service-boundaries.md](../../architecture/service-boundaries.md)
- [database-design.md](../../architecture/database-design.md)
- [ADR 0001](../../decisions/0001-python-persistence-sqlalchemy-alembic.md) —
  SQLAlchemy + Alembic
- [ADR 0002](../../decisions/0002-python-service-source-layout.md) —
  feature-first source layout
- [Completed: Python Service Databases](../completed/2026-09-05-python-service-databases.md)
- [Completed: Python Database Layout Refactor](../completed/2026-09-05-python-database-layout-refactor.md)
- Kế hoạch 8 tuần: tương ứng **Tuần 2 — Agent platform foundation** (§21)

### Tiến độ hiện tại đã hoàn thành

| Thành phần | Trạng thái |
| --- | --- |
| Database schema (9 tables) + Alembic migrations | ✅ Hoàn thành |
| Feature-first source layout (`src/logix_agent/`) | ✅ Hoàn thành |
| `ModelGateway` Protocol (port) | ✅ Hoàn thành |
| `ModelRequest` / `ModelResponse` / `ToolDefinition` contracts | ✅ Hoàn thành |
| `ModelProfile` + `ConfigModelProfileRegistry` | ✅ Hoàn thành |
| Error hierarchy (`ModelGatewayError` tree) | ✅ Hoàn thành |
| `GeminiModelGateway` adapter (google-genai SDK) | ✅ Hoàn thành |
| `FakeModelGateway` (deterministic offline testing) | ✅ Hoàn thành |
| `CapabilityCheckingModelGateway` + `RetryingModelGateway` policies | ✅ Hoàn thành |
| Factory (`create_model_gateway`) | ✅ Hoàn thành |
| FastAPI app + health endpoints (`/health/live`, `/health/ready`, `/health/ai`) | ✅ Hoàn thành |
| pyproject.toml với LangGraph + google-genai dependencies | ✅ Hoàn thành |
| Unit tests (contracts, fake, gemini, profiles, policies, factory, web) | ✅ Hoàn thành |

### Còn thiếu — Mục tiêu của plan này

| Thành phần | Trạng thái |
| --- | --- |
| LiteLLM adapter (`LiteLLMModelGateway`) | ❌ Chưa có |
| Factory hỗ trợ chọn backend `litellm_sdk` | ❌ Chưa có |
| LangGraph Planner graph (nodes, edges, state) | ❌ Chưa có |
| GraphState schema (Pydantic) | ❌ Chưa có |
| AgentRegistry (allow-list, get agent/workflow) | ❌ Chưa có |
| Tool Registry + permission filtering | ❌ Chưa có |
| Execution API (`POST /v1/agent/executions`, `GET ...`) | ❌ Chưa có |
| Execution service / application layer | ❌ Chưa có |
| PostgreSQL checkpointer integration | ❌ Chưa có |
| Prompt / system policy management | ❌ Chưa có |
| Context propagation (tenant, actor, correlation) | ❌ Chưa có |
| Read-only tool stubs (ví dụ `get_order_status`) | ❌ Chưa có |
| Structured logging + telemetry spans | ❌ Chưa có |
| Integration / deterministic graph tests | ❌ Chưa có |

## Scope

In scope:

- **Phase 1: LiteLLM Adapter** — Thêm `LiteLLMModelGateway` adapter hỗ trợ
  đa nhà cung cấp (OpenAI, Anthropic, Azure, Ollama, v.v.) qua LiteLLM SDK,
  cập nhật factory, thêm adapter contract tests.
- **Phase 2: Planner Graph Foundation** — `GraphState` Pydantic schema,
  LangGraph Planner graph với các node xác định (context_verify, normalize,
  filter_tools, classify_intent, create_plan, execute_tool, compose_result),
  `AgentRegistry`, PostgreSQL checkpointer.
- **Phase 3: Tool Registry & Permission** — `ToolDefinition` registry,
  permission filtering theo tenant/role, read-only tool stub adapter.
- **Phase 4: Execution API & Service** — REST API endpoints, execution
  service layer, context propagation, persistence lifecycle.
- **Phase 5: Validation & Integration** — Deterministic graph tests với
  FakeModelGateway, tenant isolation negative tests, structured logging.

Out of scope:

- Confirmation / approval workflow (Tuần 6).
- Sensitive mutation tools (confirm_order, approve_route, dispatch_trip).
- Forecast Service / Route Optimizer Service implementation.
- Kafka event integration (outbox/inbox).
- LiteLLM Proxy deployment.
- RAG, vector database, fine-tuning.
- Frontend integration.

## Approach

### Phase 1 — LiteLLM Adapter (chuẩn hóa đa nhà cung cấp)

1. Thêm `litellm` dependency vào `pyproject.toml`.
2. Tạo `modules/ai/adapters/litellm_gateway.py` implementing `ModelGateway`:
   - Ánh xạ `model_profile` → LiteLLM model identifier qua
     `ModelProfileRegistry`.
   - Gọi `litellm.acompletion()` với async API.
   - Chuẩn hóa response, tool_calls, usage, latency về `ModelResponse`.
   - Áp timeout, bounded retry (ủy quyền cho policy layer).
   - Map LiteLLM exceptions → `ModelGatewayError` hierarchy.
   - Redact provider payload trước log.
3. Cập nhật `factory.py` để hỗ trợ `backend="litellm_sdk"`.
4. Cập nhật `config.py`: thêm settings cho LiteLLM (API keys per provider).
5. Viết adapter contract tests tương đương `test_gemini_gateway.py`.
6. Verify: fake gateway thay được cả Gemini lẫn LiteLLM mà graph không đổi.

### Phase 2 — Planner Graph Foundation

1. Tạo `modules/planner/` package:
   - `state.py` — `PlannerGraphState(TypedDict)` với các field theo §8.3.
   - `nodes.py` — Deterministic nodes:
     - `verify_context` — validate tenant_id, actor_id, correlation_id.
     - `normalize_request` — sanitize, limit size.
     - `filter_tools` — lọc tool theo permission snapshot.
     - `classify_intent` — gọi ModelGateway để phân loại intent.
     - `create_plan` — tạo structured plan (danh sách bước).
     - `validate_policy` — kiểm tra policy, tool arguments.
     - `execute_tool` — gọi tool adapter.
     - `verify_result` — kiểm tra tool result.
     - `compose_result` — tạo grounded response cho user.
   - `graph.py` — Biên dịch LangGraph `StateGraph` với các node và edges
     theo §8.4 flowchart.
   - `prompts.py` — System policy prompts có version.
2. Tạo `modules/registry/`:
   - `agent_registry.py` — `AgentRegistry` với allow-list
     `{"planner": compiled_planner_graph}`.
3. Tích hợp `langgraph-checkpoint-postgres` cho PostgreSQL persistence.
4. Viết deterministic graph tests với `FakeModelGateway`.

### Phase 3 — Tool Registry & Permission Filtering

1. Tạo `modules/tools/`:
   - `registry.py` — `ToolRegistry` class lưu trữ `BusinessToolDefinition`.
   - `definitions.py` — Khai báo tool definitions (name, schema,
     required_permissions, risk_level).
   - `permissions.py` — Logic lọc tool theo tenant + role.
   - `adapters/` — Stub adapters cho read-only tools
     (`get_order_status_stub`, `get_inventory_availability_stub`).
2. Mỗi `BusinessToolDefinition` bao gồm:
   - `name`, `version`, `description`, `input_schema`, `output_schema`.
   - `required_permissions`, `risk_level` (READ/DRAFT/ANALYSIS/SENSITIVE).
   - `idempotency_strategy`, `timeout`, `data_classification`.
3. Tool filter node trong graph chỉ expose tools mà actor có quyền.
4. Tests: unauthorized tool không được đưa vào model tool list.

### Phase 4 — Execution API & Service Layer

1. Tạo `modules/executions/`:
   - `schemas.py` — Pydantic request/response schemas cho API.
   - `service.py` — `ExecutionService` orchestration.
   - `router.py` — FastAPI router:
     - `POST /v1/agent/executions` — tạo execution mới.
     - `GET /v1/agent/executions/{execution_id}` — đọc trạng thái.
2. `ExecutionService`:
   - Validate idempotency key.
   - Trích xuất tenant/actor từ request context (header/token).
   - Tạo `AgentExecution` record (RECEIVED).
   - Lấy agent từ `AgentRegistry`.
   - Chạy graph (RUNNING) và persist kết quả.
   - Cập nhật trạng thái cuối (COMPLETED/FAILED).
3. Context propagation middleware: `tenant_id`, `actor_id`,
   `correlation_id` từ headers.
4. Mount router vào FastAPI app.

### Phase 5 — Validation & Quality

1. Unit tests:
   - Graph routing deterministic tests.
   - Tool permission filtering tests.
   - Context propagation tests.
   - Execution lifecycle tests.
2. Integration tests:
   - Fake gateway end-to-end: request → graph → tool → response.
   - PostgreSQL checkpointer: persist/resume.
3. Negative tests:
   - Cross-tenant tool access denied.
   - Invalid/missing context rejected.
   - Unknown agent_type rejected.
4. Structured logging:
   - correlation_id, tenant_id, execution_id, operation, duration_ms.
5. Chạy `pnpm lint && pnpm typecheck && pnpm test && pnpm build` cho
   toàn repository.

## Risks And Recovery

- **LiteLLM SDK có breaking change hoặc conflict với google-genai**: Cô lập
  trong adapter; pin version trong `pyproject.toml`; nếu conflict nghiêm trọng
  thì giữ Gemini adapter làm primary và ghi LiteLLM là optional.
- **LangGraph API thay đổi giữa các version**: Pin `langgraph>=1.2,<2`;
  graph tests đảm bảo compilation và routing; recovery là rollback graph
  changes và giữ lại ModelGateway layer.
- **PostgreSQL checkpointer incompatible**: Sử dụng
  `langgraph-checkpoint-postgres` official; fallback về in-memory checkpointer
  cho development.
- **Tool permission model chưa đủ thông tin từ Identity Service**: Dùng
  hardcoded permission snapshot cho MVP; thay thế bằng runtime lookup khi
  Identity Service API sẵn sàng.
- **Graph test flaky do LLM call**: Tất cả graph tests dùng
  `FakeModelGateway`; không có external dependency.
- Recovery tổng thể: database schema không thay đổi; mọi code mới là additive;
  rollback = revert commits; service vẫn hoạt động với health endpoints hiện tại.

## Progress

### Phase 1: LiteLLM Adapter

- [ ] Thêm `litellm` dependency vào `pyproject.toml`.
- [ ] Implement `LiteLLMModelGateway` adapter.
- [ ] Map LiteLLM exceptions → `ModelGatewayError` hierarchy.
- [ ] Cập nhật `factory.py` cho backend `litellm_sdk`.
- [ ] Cập nhật `config.py` với LiteLLM settings.
- [ ] Viết adapter contract tests.
- [ ] Verify fake gateway compatibility.

### Phase 2: Planner Graph Foundation

- [ ] Tạo `PlannerGraphState` TypedDict.
- [ ] Implement deterministic graph nodes.
- [ ] Implement LLM-calling nodes (intent, plan).
- [ ] Biên dịch LangGraph StateGraph.
- [ ] Tạo `AgentRegistry` với allow-list.
- [ ] Tích hợp PostgreSQL checkpointer.
- [ ] System policy prompts versioned.
- [ ] Deterministic graph routing tests.

### Phase 3: Tool Registry & Permission

- [ ] Tạo `ToolRegistry` và `BusinessToolDefinition`.
- [ ] Implement permission filtering logic.
- [ ] Tạo read-only tool stub definitions.
- [ ] Tạo stub tool adapters.
- [ ] Unauthorized tool negative tests.

### Phase 4: Execution API & Service

- [ ] Tạo execution Pydantic schemas.
- [ ] Implement `ExecutionService`.
- [ ] Tạo FastAPI router (POST/GET).
- [ ] Context propagation middleware.
- [ ] Mount router vào app.
- [ ] API integration tests.

### Phase 5: Validation & Quality

- [ ] Full deterministic graph end-to-end test.
- [ ] Tenant isolation negative test.
- [ ] Structured logging integration.
- [ ] Repository proof: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.

## Decisions

- 2026-09-27: LiteLLM SDK adapter bổ sung bên cạnh Gemini adapter (không thay
  thế). Factory hỗ trợ cả hai backend qua config. Tuân thủ thiết kế §8.5.3 —
  ModelGateway port giữ nguyên, chỉ thêm adapter mới.
- 2026-09-27: Planner graph dùng LangGraph StateGraph; tenant/RBAC/validation
  nodes là code xác định, không dùng LLM. Tuân thủ §8.4.
- 2026-09-27: MVP chỉ hỗ trợ read-only tool stubs (get_order_status,
  get_inventory_availability). Sensitive mutation tools thuộc scope Tuần 6.
- 2026-09-27: Permission snapshot hardcoded cho MVP; sẽ chuyển sang runtime
  lookup khi Identity Service contract sẵn sàng.
- 2026-09-27: Tất cả graph tests dùng FakeModelGateway. Provider regression
  là suite riêng, không chặn CI.

## Validation

- Focused proof:
  - LiteLLM adapter contract tests: response normalization, tool call mapping,
    error mapping, timeout handling.
  - Graph routing tests: correct node traversal cho read-only intent.
  - Tool permission tests: unauthorized tool filtered out.
  - Execution lifecycle tests: RECEIVED → RUNNING → COMPLETED/FAILED.
  - Context propagation tests: tenant_id/actor_id/correlation_id present.
- Integration proof:
  - End-to-end with FakeModelGateway: request → execution → graph →
    tool → response.
  - PostgreSQL checkpointer: persist and resume.
- Negative tests:
  - Cross-tenant identifier rejected.
  - Missing context rejected.
  - Unknown agent_type → UnsupportedAgentError.
- Repository proof:
  - `pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass.
  - Graph/agent code does not import LiteLLM hoặc google-genai SDK.
  - FakeModelGateway substitutable cho mọi adapter.

## Result

_(Sẽ hoàn thành sau khi implementation xong.)_
