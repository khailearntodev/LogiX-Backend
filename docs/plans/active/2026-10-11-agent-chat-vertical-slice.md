# Execution Plan: Agent Chat Vertical Slice qua AG-UI + CopilotKit

Date: 2026-10-11

## Status

Active

## Outcome

Người dùng đã đăng nhập mở trang Copilot trên FE, gửi tin nhắn và nhận câu trả
lời từ một LangGraph agent đơn giản (1 node gọi `ModelGateway`). UI dùng
**CopilotKit**, giao thức giữa các tầng là **AG-UI** (SSE). Bước này **chỉ chat**:
không lấy lại lịch sử, không danh sách/chuyển hội thoại, không planner, tool
calling, confirmation. Tải lại trang bắt đầu hội thoại mới.

Luồng:

```
Browser (<CopilotKit> + <CopilotChat>)
  → Next.js /api/copilotkit  (CopilotRuntime v2, agent = HttpAgent)
  → api-gateway /api/v1/agent/runs  → agent-service (FastAPI + ag-ui-langgraph + LangGraph)
  → ModelGateway (Gemini / fake)
```

## Context

- Kế hoạch lớn hơn (planner, tool registry, execution API):
  [2026-09-27-agentic-ai-foundation.md](2026-09-27-agentic-ai-foundation.md).
  Plan này là lát cắt nhỏ chạy trước; AG-UI/CopilotKit cũng là kênh cho step
  trace, tool call, interrupt (confirmation) ở các plan sau.
- Thiết kế: [ai-services-technical-design.md](../../architecture/ai-services-technical-design.md).
- AG-UI: client gửi `RunAgentInput` (`threadId`, `runId`, `messages`, `state`,
  `tools`, `context`, `forwardedProps`) bằng `POST`, server trả SSE gồm
  `RUN_STARTED`, `TEXT_MESSAGE_*`, `TOOL_CALL_*`, `STATE_*`, `MESSAGES_SNAPSHOT`,
  `RUN_FINISHED | RUN_ERROR`. Python: `ag-ui-protocol`, `ag-ui-langgraph`
  (`LangGraphAgent`, `EventEncoder`).
- CopilotKit v2 (v1 đã deprecated): React `@copilotkit/react-core/v2`
  (`CopilotKit`/`CopilotKitProvider`, `CopilotChat`, style
  `@copilotkit/react-core/v2/styles.css`), runtime `@copilotkit/runtime/v2`
  (`CopilotRuntime`, `createCopilotRuntimeHandler`). Runtime TypeScript chạy được
  không cần CopilotKit Intelligence (không cần API key cloud). Agent ngoài đăng
  ký bằng `HttpAgent` của `@ag-ui/client`; runtime tự forward header
  `authorization` sang agent.
- Hiện trạng agent-service: chỉ có `/`, `/health/*`; `ModelGateway` (port
  `generate()`, chưa streaming) + adapter gemini/litellm/fake; `langgraph` đã có
  trong dependencies; `modules/planner/` trống; chưa có router, auth, graph.
- Hiện trạng gateway: proxy `http-proxy-middleware` (auth / inventory /
  master-data), chưa có agent; không verify JWT, service đích tự verify (mẫu:
  `inventory-service/src/auth/strategies/jwt.strategy.ts`, payload `sub`,
  `email`, `tenantId`).
- Hiện trạng FE: Next 16 + React 19 + Tailwind 4; chưa có `features/ai-copilot`;
  `src/middleware.ts` chỉ `NextResponse.next()` (không chặn `/api/*`); token lưu ở
  `sessionStorage` qua `src/lib/api/http-client.ts`.

## Scope

In scope:

- agent-service: JWT auth, `ModelGateway` → LangChain chat model adapter, graph
  1 node + `MemorySaver`, endpoint AG-UI `POST /api/v1/agent/runs`, kiểm soát sở
  hữu thread trong bộ nhớ, test với fake.
- api-gateway: `AgentProxyMiddleware` cho `/api/v1/agent`, SSE không bị buffer.
- FE: CopilotKit runtime route trong Next.js, feature `ai-copilot` (provider +
  `CopilotChat`), route `/copilot`, sidebar, i18n en/vi.
- Env/config và ghi chú contract.

Out of scope:

- Lịch sử hội thoại, danh sách/chuyển thread, `GET /threads*`, checkpointer
  Postgres, ghi bảng `conversations`/`conversation_messages`.
- Planner, tool calling, tool registry, interrupt/confirmation,
  `AgentExecution`, `ModelGateway.stream()` (token streaming thật),
  CopilotKit Intelligence/cloud, docker-compose cho agent-service, RBAC copilot.

## Contract

Agent-service chỉ có một endpoint mới:

| Method | Path | Mô tả |
|---|---|---|
| POST | `/api/v1/agent/runs` | AG-UI. Body `RunAgentInput`, response `text/event-stream`. Header `Authorization: Bearer <accessToken>`. |

Next.js (nội bộ FE, không public cho service khác): `/api/copilotkit/*` do
CopilotKit runtime phục vụ (multi-route, mặc định).

Quy tắc:

- `tenantId`, `userId` chỉ lấy từ JWT; bỏ qua mọi giá trị tenant/user trong
  `state`, `forwardedProps`, `context`.
- Thread do client sinh; agent-service ghi nhận chủ sở hữu thread (tenant + user)
  lần đầu thấy và trả 404 nếu người khác dùng lại `threadId` đó.
- Lỗi trước khi stream (401, 404, 422) trả JSON `{ statusCode, message, error }`;
  lỗi trong lúc chạy trả `RUN_ERROR` với `code` ổn định (`MODEL_TIMEOUT`,
  `MODEL_UNAVAILABLE`, `INTERNAL`).
- Bỏ qua `tools` do client gửi ở bước này.

Chuỗi xác thực: `<CopilotKit headers={{ Authorization }}>` → Next route (từ chối
nếu thiếu `Authorization`) → runtime forward `authorization` → gateway (proxy
nguyên header) → agent-service verify JWT.

## Approach

### Phase 0 — Spike (xác nhận giả định)

Backend:

1. Cài `ag-ui-langgraph`, `ag-ui-protocol`, `langchain-core` trên Python 3.12;
   kiểm tra không xung đột với `langgraph>=1.2`, `litellm`.
2. Chạy graph `MessagesState` + `MemorySaver` qua `LangGraphAgent.run()` với chat
   model giả, xác nhận chuỗi `RUN_STARTED → TEXT_MESSAGE_* → RUN_FINISHED`, và
   xác nhận `MemorySaver` là đủ (graph không checkpointer sẽ lỗi khi đọc state).
3. Xác nhận cách gắn auth: `add_langgraph_fastapi_endpoint` có nhận dependency
   không; nếu không, viết endpoint thủ công bằng `EventEncoder` + `agent.run()`.

Frontend:

4. `pnpm add @copilotkit/react-core @copilotkit/runtime @ag-ui/client`, đảm bảo
   chỉ có **một** bản `@ag-ui/client` (`pnpm why @ag-ui/client`; ghim đúng phiên
   bản mà `@copilotkit/runtime` phụ thuộc), chạy được với Next 16 / React 19.
5. Runtime route Next.js phục vụ `GET /info` và `POST /agent/default/run` với
   `HttpAgent` trỏ vào một AG-UI server giả.
6. Kiểm tra `<CopilotChat>` khi mount có gọi `connect` hay không và hành vi với
   `InMemoryAgentRunner` trên thread mới (có thể 404); nếu có thì chọn cách xử lý
   (chặn/bỏ qua `connect` ở hook, hoặc cấu hình runner phù hợp).
7. Kiểm tra `headers` của provider có cập nhật khi token đổi (không cần remount).
8. Kiểm tra style CopilotKit không phá Tailwind 4/theme sáng-tối của app; nếu lỗi
   nặng thì phương án dự phòng là hook `useAgent` + UI primitives có sẵn
   (`components/ui/message`, `bubble`, `textarea`).
9. Kiểm tra telemetry mã nguồn mở của CopilotKit và tắt nếu không muốn gửi.

Kết quả ghi vào Decisions; nếu mục 1–2 thất bại thì dừng và đổi phương án (tự phát
event bằng `ag_ui.core` thay `ag-ui-langgraph`).

### Phase 1 — Agent service

1. `pyproject.toml`: thêm `ag-ui-protocol`, `ag-ui-langgraph`, `langchain-core`,
   `PyJWT` (ghim phiên bản). `config.py`: thêm `jwt_secret` (cùng `JWT_SECRET`
   với identity-service).
2. `modules/auth/`: dependency `get_current_actor` verify HS256 từ Bearer →
   `Actor(user_id, tenant_id)`; thiếu/hết hạn → 401.
3. `modules/ai/langchain_adapter.py`: `ModelGatewayChatModel(BaseChatModel)` bọc
   `ModelGateway.generate()` để LangGraph phát `on_chat_model_stream` (một
   chunk/lượt vì gateway chưa stream). Giữ nguyên retry/fallback của gateway.
4. `modules/planner/chat_graph.py`: `StateGraph(MessagesState)`, 1 node `chat`
   (system prompt versioned theo `prompt_policy_version` + lịch sử → model),
   compile với `MemorySaver`. Factory nhận gateway để test dùng `FakeModelGateway`.
5. `modules/agui/thread_registry.py`: map in-memory `threadId → (tenant_id,
   user_id)`; `claim(thread_id, actor)` trả 404 khi thuộc người khác. Giả định một
   worker, mất khi restart (cùng vòng đời `MemorySaver`).
6. `modules/agui/router.py`: `POST /api/v1/agent/runs` (auth → `claim` → 
   `LangGraphAgent.run()` → `StreamingResponse` với `EventEncoder`, header
   `Cache-Control: no-cache`, `X-Accel-Buffering: no`). Map lỗi gateway sang
   `RUN_ERROR`. Mount trong `main.py`.

### Phase 2 — API gateway

1. `src/proxy/agent-proxy.middleware.ts` theo mẫu `inventory-proxy.middleware.ts`,
   target `AGENT_SERVICE_URL || 'http://localhost:8001'`, `pathFilter`
   `/api/v1/agent`, `proxyTimeout`/`timeout` ≥ 120s, thông báo 502 tiếng Việt.
2. Đăng ký trong `app.module.ts` cho `api/v1/agent` và `api/v1/agent/*`.
3. Xác nhận SSE đi qua không bị buffer/nén; chunk tới Next route ngay khi agent phát.
4. Ghi `AGENT_SERVICE_URL` vào README/env mẫu.

### Phase 3 — Frontend

```
src/app/api/copilotkit/[[...slug]]/route.ts   # CopilotRuntime + handler
src/app/(workspace)/copilot/page.tsx
src/features/ai-copilot/
  components/copilot-provider.tsx   # <CopilotKit runtimeUrl headers>
  components/copilot-chat.tsx       # <CopilotChat agentId="default" ...>
  index.ts
```

1. Dependencies như Phase 0.4; import style
   `@copilotkit/react-core/v2/styles.css` ở nơi chỉ trang copilot dùng.
2. Route Next.js: `CopilotRuntime({ agents: () => ({ default: new HttpAgent({ url:
   AGENT_RUN_URL }) }) })` (factory để mỗi request có agent riêng, tránh lỗi chạy
   đồng thời trên một instance), `createCopilotRuntimeHandler({ runtime,
   basePath: "/api/copilotkit" })`, export `GET/POST/PATCH/DELETE`.
   - `hooks.onRequest`: thiếu `Authorization` → 401.
   - `hooks.onBeforeHandler`: chỉ cho `info`, `agent/run`, `agent/connect`,
     `agent/stop`; **chặn mọi `threads/*`** vì runner trong bộ nhớ không phân
     quyền theo người dùng.
   - `AGENT_RUN_URL` là biến server-only (`http://localhost:3000/api/v1/agent/runs`),
     không dùng `NEXT_PUBLIC_`.
3. `copilot-provider.tsx` (client): `<CopilotKit runtimeUrl="/api/copilotkit"
   headers={{ Authorization: `Bearer ${token}` }}>`; token lấy từ phiên đăng nhập
   hiện có (qua `useAuth` hoặc `getStoredAccessToken`); chỉ render khi đã có token.
   Xử lý hết hạn token: lỗi 401 từ runtime → gọi refresh đã đăng ký trong
   `src/lib/api` rồi cập nhật header; chi tiết chốt ở Phase 0.7.
4. `copilot-chat.tsx`: `<CopilotChat agentId="default" />` với nhãn i18n (en/vi),
   chiều cao theo `PageShell`; chỉ hiển thị text (bỏ qua tool/activity).
5. Trang `/copilot`, mục sidebar trong `app-sidebar.tsx`, key i18n
   `en.json`/`vi.json`.
6. Chạy `tests/architecture`; nếu route handler hoặc feature vi phạm ranh giới
   (`app → features → components → lib`) thì điều chỉnh vị trí file.

### Phase 4 — Liên thông và tài liệu

1. Chạy identity + gateway + agent-service + FE với `LLM_GATEWAY_BACKEND=fake` rồi
   `gemini`: đăng nhập → chat nhiều lượt cùng phiên (agent nhớ ngữ cảnh trong
   thread) → lỗi model hiện thông báo → token hết hạn xử lý đúng.
2. Cập nhật README agent-service, gateway, FE (env `AGENT_RUN_URL`,
   `AGENT_SERVICE_URL`, `JWT_SECRET`); thêm ADR ngắn trong `docs/decisions/`:
   "AG-UI + CopilotKit làm giao thức/UI FE ↔ agent".

## Risks And Recovery

- `ag-ui-langgraph` mới ở 0.0.x: ghim phiên bản; Phase 0 trước; dự phòng là tự
  phát event bằng `ag_ui.core` + `EventEncoder` (graph không đổi).
- CopilotKit v2 đổi nhanh và có v1 song song: chỉ import từ `/v2`; ghim phiên
  bản; không trộn API v1.
- Hai bản `@ag-ui/client` làm `HttpAgent` không nhận ra nhau: kiểm tra `pnpm why`.
- Runner mặc định trong bộ nhớ của runtime Next.js: không bền, tăng bộ nhớ theo
  số thread, và route `threads/*` không phân quyền → đã chặn ở `onBeforeHandler`;
  chạy một instance. Plan lịch sử sau sẽ thay bằng runner/lưu trữ có phân quyền.
- Next.js serverless/nhiều instance sẽ làm `connect`/runner không nhất quán: bước
  này chỉ hỗ trợ chạy một tiến trình.
- UI CopilotKit lệch giao diện: dự phòng bằng `useAgent` + UI primitives có sẵn.
- `ModelGateway` chưa stream nên chưa có hiệu ứng gõ từng token; contract không
  đổi khi thêm `stream()` sau.
- Gateway không verify JWT, agent-service tự verify: bắt buộc test 401 và thread
  của người/tenant khác → 404.
- Token hết hạn giữa chừng khi stream dài: không refresh giữa stream; chạy lại sau
  khi refresh.
- `JWT_SECRET` lệch giữa các service gây 401 toàn bộ: ghi rõ trong README.
- Rollback: gỡ middleware gateway, route `/api/copilotkit` và trang `/copilot` là
  tắt được tính năng; endpoint agent-service độc lập.

## Progress

### Phase 0: Spike

- [x] Backend: tương thích dependencies, chuỗi event AG-UI, `MemorySaver`.
- [x] Backend: cách gắn auth cho endpoint.
- [ ] FE: cài CopilotKit, một bản `@ag-ui/client`, chạy với Next 16 / React 19.
- [ ] FE: runtime route + `HttpAgent` chạy được.
- [ ] FE: hành vi `connect`, `headers` reactive, style, telemetry.

### Phase 1: Agent service

- [x] Dependencies + config `jwt_secret`.
- [x] `get_current_actor` + test 401.
- [x] `ModelGatewayChatModel` adapter + test.
- [x] Chat graph 1 node + `MemorySaver`, test với `FakeModelGateway`.
- [x] `thread_registry` + test thread của người khác → 404.
- [x] Router AG-UI `POST /run` + test chuỗi event và `RUN_ERROR`.

### Phase 2: API gateway

- [x] `AgentProxyMiddleware` + đăng ký route.
- [x] Timeout, 502, SSE không buffer (đã kiểm bằng curl qua gateway: 401 khi thiếu token, stream SSE khi có token).

### Phase 3: Frontend

- [x] Route runtime `/api/copilotkit` (FE đã có) trỏ vào gateway `/api/v1/agent/runs`; không cần chặn `threads/*` vì runtime tạo mới mỗi request.
- [x] Provider gửi `Authorization: Bearer` từ `useAuth().accessToken`.
- [x] Sidebar chat (`LogixCopilotSidebar`) đã có sẵn; không làm trang `/copilot` riêng.
- [x] `tsc --noEmit` và eslint sạch cho `features/chat` và route runtime.
- [ ] Thử trên trình duyệt: đăng nhập → mở sidebar → chat (cần identity-service + DB).

### Phase 4: Liên thông

- [ ] Smoke test end-to-end với fake gateway.
- [ ] Smoke test với Gemini thật.
- [ ] README + ADR.

## Decisions

- 2026-10-11: AG-UI (SSE) là giao thức FE ↔ agent; thay cho REST JSON tự định nghĩa.
- 2026-10-11: Dùng CopilotKit v2 (UI + runtime Next.js) thay cho `@ag-ui/client`
  thuần; không dùng CopilotKit Intelligence.
- 2026-10-11: Bước này không lưu/đọc lịch sử: `MemorySaver` + bộ đăng ký thread
  trong bộ nhớ; bỏ Postgres checkpointer, `GET /threads*`, ghi `conversations`.
  Thay thế các quyết định trước đó về checkpointer Postgres và thread list.
- 2026-10-11: Bọc `ModelGateway` thành LangChain chat model để giữ kiến trúc
  provider-agnostic và vẫn phát được event AG-UI.
- 2026-10-11: Agent-service tự verify JWT (theo mẫu inventory-service); runtime
  Next.js chỉ forward `authorization`.
- 2026-10-11: Không tạo `AgentExecution` ở lát cắt này; ghi
  `provider/model/latency` vào log kèm correlation id.
- 2026-10-11 (Phase 2/3): FE đã có sẵn `LogixCopilotSidebar` (CopilotKit `CopilotSidebar`),
  `CopilotChatProvider` và route runtime `src/app/api/copilotkit/[[...copilotkit]]/route.ts`
  (agent = `HttpAgent` gọi `${LOGIX_AGUI_BASE_URL}/runs`). Backend đổi endpoint thành
  `POST /api/v1/agent/runs` cho khớp; FE chỉ sửa: URL mặc định trỏ gateway
  (`http://localhost:3000/api/v1/agent`) và `CopilotKit` nhận `headers` Bearer từ
  `useAuth().accessToken` (react-core áp lại headers khi token đổi). Route runtime tạo
  `CopilotRuntime` mỗi request nên không có trạng thái dùng chung giữa user; không cần
  chặn `threads/*`. `connect` trên thread mới trả 200. CopilotKit bật telemetry mặc định
  (tắt bằng `COPILOTKIT_TELEMETRY_DISABLED=true`).
- 2026-10-11 (Phase 0/1 backend): `ag-ui-langgraph` 0.0.47 + `ag-ui-protocol` 1.0.0
  cài được cùng `langgraph` 1.2 / `langchain-core` 1.6, không xung đột. Endpoint
  viết thủ công (không dùng `add_langgraph_fastapi_endpoint`) để claim thread theo
  body và lọc `RUN_ERROR`. Danh tính (tenant/user/correlation) đặt vào
  `LangGraphAgent.config["configurable"]` trên bản clone mỗi request; `tools`,
  `state`, `context` của client bị bỏ. `emit_raw_events=False` để không lộ system
  prompt qua event `RAW`. Chat model phải tách chunk text và chunk `finish_reason`
  vì `ag-ui-langgraph` bỏ qua chunk có `finish_reason` (nếu gộp sẽ không có
  `TEXT_MESSAGE_*`). Lỗi HTTP của agent-service đổi sang dạng
  `{ statusCode, message, error }` giống các service NestJS.

## Validation

- Focused proof: `pytest apps/agent-service/tests` (auth, adapter, graph với fake,
  chuỗi event AG-UI, thread ownership, `RUN_ERROR`).
- Integration or end-to-end proof: đăng nhập FE → mở `/copilot` → gửi tin → nhận
  trả lời → lượt hai vẫn nhớ ngữ cảnh, qua gateway thật; `curl` route
  `/api/copilotkit/threads` bị 403/chặn.
- Repository-required checks: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
  (backend), `pnpm lint && pnpm build` + architecture test (frontend).

## Result

Hoàn thành sau khi triển khai. Ghi kết quả, giới hạn và việc tiếp theo (lịch sử +
runner có phân quyền, `ModelGateway.stream()`, planner, tool calling, interrupt)
trước khi chuyển sang `docs/plans/completed/`.
