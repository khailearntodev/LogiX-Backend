# Thiết kế kỹ thuật AI Services cho LogiX

## 1. Trạng thái tài liệu

| Thuộc tính | Giá trị |
| --- | --- |
| Hệ thống | LogiX — nền tảng logistics và quản lý chuỗi cung ứng multi-tenant |
| Phạm vi | Agent Service, Forecast Service, Route Optimizer Service và các điểm tích hợp |
| Trạng thái | Thiết kế triển khai đề xuất cho MVP |
| Thời gian mục tiêu | 8 tuần |
| Framework điều phối | LangGraph |
| API runtime | Python, FastAPI |
| LLM gateway | LiteLLM Python SDK đặt sau `ModelGateway`; LiteLLM Proxy chỉ kích hoạt khi có nhu cầu gateway dùng chung |
| Công cụ định lượng | Prophet hoặc engine tương đương; Google OR-Tools |

Tài liệu này chi tiết hóa kiến trúc AI đã được mô tả trong:

- [BRD](../plan_ghi_ro_so_task_backlog/brd.md);
- [System Overview](system-overview.md);
- [Service Boundaries](service-boundaries.md);
- [Data Ownership](data-ownership.md);
- [Event Architecture](event-architecture.md);
- [Runtime Architecture](runtime-architecture.md);
- đề cương đồ án do nhóm cung cấp.

Các từ “bắt buộc” và “không được” trong tài liệu này chỉ được dùng khi đã có
authority tương ứng trong BRD hoặc bộ tài liệu kiến trúc hiện tại. Những lựa chọn
triển khai chưa phải policy của toàn repository được đánh dấu là “đề xuất”. Nếu
một lựa chọn như framework, thư viện persistence hoặc quy ước package trở thành
chuẩn lâu dài của repository, lựa chọn đó cần được ghi thành ADR.

## 2. Mục tiêu và tiêu chí thành công

### 2.1 Mục tiêu

1. Cung cấp Planner Agent nhận yêu cầu ngôn ngữ tự nhiên, phân tích ý định và gọi
   đúng công cụ trong quyền của người dùng.
2. Cung cấp Demand Forecast Agent dự báo nhu cầu 7 ngày theo tenant, kho và SKU
   bằng mô hình có thể kiểm chứng.
3. Cung cấp Route Optimizer Agent đề xuất thứ tự giao hàng bằng bộ giải tối ưu,
   tuân thủ ràng buộc nghiệp vụ.
4. Tách LLM, mô hình dự báo và solver khỏi business logic thông qua interface và
   contract ổn định.
5. Hỗ trợ timeout, retry có giới hạn, fallback, idempotency, audit, quan sát và
   phục hồi sau lỗi.
6. Bảo đảm AI không làm suy yếu RBAC, tenant isolation hoặc quyền phê duyệt của
   con người.
7. Giữ toàn bộ luồng logistics lõi hoạt động khi LLM, Forecast Service hoặc Route
   Optimizer Service không sẵn sàng.

### 2.2 Tiêu chí nghiệm thu từ BRD

| Năng lực | Tiêu chí |
| --- | --- |
| Planner | Tool Success Rate tối thiểu 90% trên ít nhất 30 kịch bản cố định |
| Route | Trả kết quả trong tối đa 10 giây với tối đa 50 stop trong môi trường benchmark |
| Forecast | Batch 100 chuỗi SKU-kho hoàn thành trong tối đa 60 giây, hoặc công bố giới hạn đo được |
| Forecast quality | Có baseline và MAPE/RMSE khi đủ actual |
| Route quality | So sánh tổng quãng đường hoặc chi phí với baseline |
| Tenant isolation | Không có truy cập chéo tenant trong negative tests |
| Model swap | Đổi provider hoặc model và chạy regression trong tối đa 1 giờ mà không sửa business logic |
| Reliability | Lỗi AI có trạng thái rõ ràng; nghiệp vụ thủ công tiếp tục được |
| Observability | Có log, metric và correlation xuyên HTTP, Agent, tool, worker và Kafka |

## 3. Phạm vi

### 3.1 Trong phạm vi MVP

- Planner Agent cho truy vấn, tạo draft, khởi chạy phân tích và đề xuất hành động.
- Tool permission theo tenant, user và role.
- Preview và xác nhận rõ ràng đối với confirm/cancel order, approve route và dispatch.
- Dự báo daily fulfilled demand theo tenant + warehouse + SKU trong 7 ngày.
- Pro-average baseline.
- MAPE, RMSE, confidence interval, model metadata và khả năng tái lập.
- Tối ưu depotphet hoặc engine tương đương, naive baseline và moving-to-stops-to-depot cho một DeliveryTrip và một vehicle.
- Ràng buộc mỗi stop đúng một lần, cùng warehouse và không vượt capacity.
- Input-order và nearest-neighbor baseline.
- PostgreSQL service-owned, Kafka domain events và Redis cho mục đích tạm thời đã xác định.
- LiteLLM Python SDK làm adapter mặc định phía sau `ModelGateway`; model/provider được
  chọn qua model profile trong cấu hình, không hard-code trong graph.
- Docker Compose cho local integration; Kubernetes chỉ cho kịch bản scale-out cần chứng minh.

### 3.2 Ngoài phạm vi MVP

- Agent tự động tạo purchase order hoặc quyết định nhập hàng.
- Agent ghi trực tiếp database của business service.
- LLM tự tính forecast, distance, capacity hoặc route.
- Multi-warehouse fulfillment, split order hoặc multi-depot routing.
- Marketplace 3PL, thanh toán, COD hoặc đối soát.
- GPS/traffic realtime, ETA prediction, geofencing.
- Time window và service time phức tạp trước khi MVP cơ bản ổn định.
- Digital Twin, Inventory Advisor và ETA Agent.
- Fine-tuning mô hình nền tảng.
- Vector database hoặc RAG nếu chưa có use case và nguồn dữ liệu được phê duyệt.
- Vận hành LiteLLM Proxy như một service riêng khi mới chỉ có Agent Service gọi LLM;
  Proxy là phương án nâng cấp khi có nhiều consumer, cần quota hoặc quản trị tập trung.

## 4. Nguyên tắc kiến trúc

### 4.1 LLM điều phối, engine chuyên biệt tính toán

Planner Agent có thể hiểu ý định, lập kế hoạch và chọn tool. Forecast và route
phải được tính bởi component chuyên biệt. Mọi số liệu định lượng quan trọng phải
có nguồn, input, phiên bản engine và metrics có thể kiểm tra.

### 4.2 Ba Agent không đồng nghĩa ba chatbot

- **Planner Agent** là agent có LLM và tool-calling.
- **Demand Forecast Agent** là workflow chuyên môn có trạng thái, gọi forecasting
  engine và baseline.
- **Route Optimizer Agent** là workflow chuyên môn có trạng thái, gọi solver và
  kiểm tra feasibility.

Hai specialized agent có thể được biểu diễn dưới dạng LangGraph subgraph hoặc
service workflow, nhưng không cần một LLM riêng.

### 4.3 Core business AI-independent

AI chỉ truy cập business capability qua API hoặc contract đã công bố. Nếu AI
không hoạt động, người dùng vẫn tạo/xác nhận đơn, quản lý kho, lập trip, approve
route thủ công và dispatch qua UI/API thông thường.

### 4.4 Service-owned data

Mỗi service sở hữu schema hoặc database logic của mình. Chia sẻ cùng PostgreSQL
cluster là chấp nhận được, nhưng không được dùng chung business schema để truy
vấn chéo boundary.

### 4.5 Authorization server-side

Danh sách tool được lọc trước khi gửi cho model. Business service vẫn kiểm tra
RBAC, tenant và business invariant khi thực thi; việc Agent đã kiểm tra không
thay thế kiểm tra tại service sở hữu.

### 4.6 Human authority

Route Optimizer chỉ đề xuất. Forecast chỉ tư vấn. Hành động nhạy cảm chỉ được
thực thi sau preview và explicit confirmation trong cùng tenant/user context.

### 4.7 Contract-first và engine-agnostic

Graph node phụ thuộc vào interface nội bộ, không phụ thuộc trực tiếp SDK của một
LLM provider, Prophet hoặc OR-Tools. Input/output phải là schema có version.

`ModelGateway` và LiteLLM giải quyết **model/provider swap**. Việc chọn hoặc thay
**agent/workflow** là trách nhiệm riêng của `AgentRegistry` và router của LangGraph.
Không dùng tên model để quyết định business workflow, và không để agent phụ thuộc
trực tiếp vào API của LiteLLM.

## 5. Kiến trúc tổng thể

~~~mermaid
flowchart LR
    UI[Web / Mobile UI] --> GW[API Gateway]
    GW --> CORE[Core NestJS Services]
    GW --> AGENT[Agent Service / FastAPI]

    AGENT --> REGISTRY[Agent Registry]
    REGISTRY --> GRAPH[LangGraph Planner / Specialized Workflow]
    GRAPH --> TOOLS[Permission-filtered Tool Registry]
    GRAPH --> MG[ModelGateway port]
    MG --> LITELLM[LiteLLM SDK adapter]
    LITELLM --> PROVIDERS[OpenAI / Gemini / Claude / Azure / Ollama]

    TOOLS --> CORE
    TOOLS --> FC[Forecast Service / FastAPI]
    TOOLS --> RO[Route Optimizer Service / FastAPI]

    FC --> FP[(Forecast PostgreSQL)]
    RO --> RP[(Route PostgreSQL)]
    AGENT --> AP[(Agent PostgreSQL + Checkpoints)]

    CORE --> KAFKA[Kafka]
    FC --> KAFKA
    RO --> KAFKA
    AGENT --> KAFKA

    REDIS[(Redis: cache / lock / rate limit)] -. optional .-> AGENT
    REDIS -. optional .-> FC
    REDIS -. optional .-> RO
~~~

### 5.1 Runtime components

| Component | Trách nhiệm | Không sở hữu |
| --- | --- | --- |
| Agent API | Nhận execution, trả trạng thái, resume confirmation | Order, inventory, shipment hoặc trip truth |
| Agent registry | Chọn agent/workflow theo `agent_type` hoặc route đã xác thực | Chọn model/provider |
| Planner graph | Intent, planning, policy routing, tool lifecycle | Tính forecast/route |
| Model gateway | Contract nội bộ cho sinh nội dung/tool call và model profile | Business rule hoặc provider SDK detail |
| LiteLLM adapter | Chuẩn hóa lời gọi provider, lỗi, retry/fallback và usage metadata | Chọn agent/workflow |
| Tool registry | Schema, permission, risk level và adapter gọi service | Business mutation implementation |
| Agent worker | Chạy/resume graph và xử lý completion signal | Business data |
| Forecast API/worker | Forecast jobs, model/baseline, metrics | Order/inventory mutation |
| Route API/worker | Optimization jobs, solver/baseline, metrics | Route approval/dispatch |
| Kafka consumers | Nhận fact event và cập nhật trạng thái/projection idempotently | Distributed transaction |

## 6. Công nghệ đề xuất

### 6.1 Nền tảng chung

| Nhóm | Lựa chọn |
| --- | --- |
| Ngôn ngữ | Python 3.12 hoặc phiên bản được repository khóa |
| API | FastAPI |
| Schema | Pydantic v2 |
| Agent orchestration | LangGraph |
| LLM integration | LiteLLM Python SDK qua `LiteLLMModelGateway` |
| HTTP client | HTTPX async |
| Database | PostgreSQL |
| Migration | Alembic |
| ORM/query | SQLAlchemy async hoặc repository SQL thống nhất sau ADR |
| Event client | Kafka client có hỗ trợ async hoặc worker adapter |
| Cache/coordination | Redis, chỉ khi có use case cụ thể |
| Forecast | Prophet hoặc implementation tương đương qua ForecastEngine |
| Optimization | Google OR-Tools qua RouteEngine |
| Telemetry | OpenTelemetry, Prometheus-compatible metrics, structured logs |
| Test | pytest, pytest-asyncio, contract/integration tests |
| Packaging | Mỗi service có pyproject riêng hoặc Python workspace được khóa trong ADR |

Không bổ sung PydanticAI vào MVP. Pydantic vẫn được dùng cho schema và validation;
LangGraph chịu trách nhiệm orchestration. Việc dùng hai agent framework đồng thời
sẽ làm tăng bề mặt tích hợp, test và vận hành mà chưa có use case bắt buộc.

MVP dùng LiteLLM dưới dạng Python SDK nhúng trong Agent Service. Cách này đủ cho
provider normalization, model profile, bounded retry/fallback và usage metadata
mà không tạo thêm một runtime service. LiteLLM Proxy chỉ được đưa vào topology khi
có ít nhất một nhu cầu đã chứng minh như nhiều AI service cùng gọi LLM, virtual key
theo tenant/project, quota/rate limit tập trung, budget tập trung hoặc load balancing
giữa nhiều deployment. Chuyển từ SDK sang Proxy vẫn phải giữ nguyên `ModelGateway`.

### 6.2 Quy tắc dependency

Application/domain code chỉ phụ thuộc vào các interface:

- ModelGateway;
- BusinessTool;
- ForecastEngine;
- RouteEngine;
- CheckpointRepository hoặc checkpointer adapter;
- EventPublisher;
- AuditPublisher.

SDK cụ thể nằm trong infrastructure adapter. Không import LiteLLM hoặc SDK provider
trong graph node, agent, domain/application code hoặc business tool definition.

## 7. Cấu trúc source mục tiêu

ADR 0002 khóa cấu trúc package riêng và feature-first cho ba Python service.
Ở giai đoạn hiện tại repository chỉ tạo phần database đã có hành vi thực tế;
không tạo folder rỗng cho API, graph, agent, tool, engine hoặc adapter tương lai.

~~~text
apps/
  agent-service/
    src/logix_agent/
      db/
        base.py
        session.py
        model_registry.py
      modules/
        conversations/models.py
        executions/models.py
        tools/models.py
        confirmations/models.py
        provider_configs/models.py
        messaging/models.py
    migrations/
    tests/
    alembic.ini
    pyproject.toml

  forecast-service/
    src/logix_forecast/
      db/
        base.py
        session.py
        model_registry.py
      modules/
        demand/models.py
        forecasts/models.py
        messaging/models.py
    migrations/
    tests/
    alembic.ini
    pyproject.toml

  route-optimizer-service/
    src/logix_route_optimizer/
      db/
        base.py
        session.py
        model_registry.py
      modules/
        optimization/models.py
        messaging/models.py
    migrations/
    tests/
    alembic.ini
    pyproject.toml
~~~

Khi triển khai các phần runtime, API/application/domain/ports/adapters được thêm
theo feature và theo dependency rule ở mục 6; chúng không được dồn trở lại thành
một package kỹ thuật dùng chung. Nếu tạo shared package sau này, package đó chỉ
chứa schema và cross-cutting primitives, không chứa business rule thuộc nhiều
service.

## 8. Agent Service

### 8.1 Trách nhiệm

Agent Service sở hữu:

- conversation context;
- AgentExecution lifecycle;
- LangGraph state và checkpoint;
- intent và plan;
- tool selection/execution metadata;
- tool permission filtering;
- confirmation workflow state;
- sanitized tool input/output;
- AgentExecutionCompleted publishing;
- agent metrics và trace.

Agent Service không sở hữu:

- order, inventory, shipment, trip hoặc route approval state;
- forecast result;
- route optimization result;
- identity/role source of truth;
- final business validation.

### 8.2 Trạng thái execution đề xuất

~~~mermaid
stateDiagram-v2
    [*] --> RECEIVED
    RECEIVED --> RUNNING
    RUNNING --> WAITING_TOOL
    WAITING_TOOL --> RUNNING: tool completed
    RUNNING --> WAITING_CONFIRMATION: sensitive action
    WAITING_CONFIRMATION --> RUNNING: approved
    WAITING_CONFIRMATION --> CANCELED: rejected/expired
    RUNNING --> COMPLETED
    RUNNING --> FAILED
    WAITING_TOOL --> FAILED: terminal tool failure
    COMPLETED --> [*]
    FAILED --> [*]
    CANCELED --> [*]
~~~

Trạng thái cụ thể là implementation detail đề xuất. Bất kể tên trạng thái, hệ
thống phải phân biệt được đang chạy, đang chờ tool, đang chờ xác nhận, thành công
và lỗi cuối.

### 8.3 Graph state

Graph state tối thiểu:

| Field | Ý nghĩa | Quy tắc |
| --- | --- | --- |
| execution_id | Định danh một lần chạy | UUID, immutable |
| thread_id | Định danh conversation/checkpoint thread | Không chứa PII |
| agent_type | Agent/workflow đã được server chọn | Allow-list, immutable trong execution |
| tenant_id | Tenant đã xác minh | Bắt buộc ở mọi node |
| actor_id | User thực hiện | Bắt buộc cho user-triggered flow |
| roles/permissions | Snapshot quyền có kiểm chứng | Không lấy từ model |
| correlation_id | Truy vết xuyên service | Không đổi trong flow |
| request | Yêu cầu đã normalize | Giới hạn kích thước |
| messages | Conversation cần thiết | Có retention và redaction |
| intent | Intent đã phân loại | Enum/schema |
| plan | Danh sách bước đề xuất | Structured, không phải text tự do duy nhất |
| available_tools | Tool sau permission filter | Không lộ tool trái quyền |
| tool_calls | Tool call đã chuẩn hóa | Có call_id và idempotency_key |
| pending_approval | Preview đang chờ | Gắn tenant + actor + action |
| final_result | Kết quả trả user | Không chứa secret |
| error | Error code an toàn | Không trả stack trace |

Không lưu access token, API key, secret hoặc payload nhạy cảm thô trong graph
state/checkpoint.

### 8.4 Planner graph

~~~mermaid
flowchart TD
    S([START]) --> CONTEXT[Verify tenant, actor, role, correlation]
    CONTEXT --> NORMALIZE[Normalize request]
    NORMALIZE --> FILTER[Build permission-filtered tool set]
    FILTER --> INTENT[Classify intent]
    INTENT --> PLAN[Create structured plan]
    PLAN --> POLICY[Validate policy and tool arguments]
    POLICY -->|read / safe analysis| EXEC[Execute tool]
    POLICY -->|sensitive mutation| PREVIEW[Create authoritative preview]
    PREVIEW --> PAUSE[Interrupt and checkpoint]
    PAUSE -->|approved| REVALIDATE[Revalidate actor, tenant, version]
    PAUSE -->|rejected/expired| CANCEL[Cancel without side effect]
    REVALIDATE --> EXEC
    EXEC --> VERIFY[Verify structured tool result]
    VERIFY -->|more steps| PLAN
    VERIFY --> RESULT[Compose grounded response]
    RESULT --> AUDIT[Persist sanitized trace and publish completion]
    AUDIT --> E([END])
    CANCEL --> AUDIT
~~~

LangGraph được dùng vì workflow cần kết hợp bước LLM với bước deterministic,
checkpoint, pause/resume và fault recovery. Graph không được biến mọi bước thành
LLM node; tenant, RBAC, validation, policy và result verification là code xác định.

### 8.5 Model gateway

#### 8.5.1 Tách agent swap khỏi model swap

Hai cơ chế độc lập:

| Cơ chế | Thành phần sở hữu | Ví dụ |
| --- | --- | --- |
| Agent/workflow selection | `AgentRegistry` + LangGraph router | Chọn Planner, Forecast workflow hoặc Route workflow |
| Model/provider selection | `ModelGateway` + LiteLLM adapter | Đổi model cho profile `planner-default` từ provider A sang provider B |

`AgentRegistry` chỉ nhận identifier nghiệp vụ đã được allow-list. Không import động
module/class từ giá trị do client gửi và không cho LLM tự đăng ký agent mới.

~~~python
class AgentRegistry:
    def __init__(self, agents: Mapping[str, CompiledGraph]) -> None:
        self._agents = dict(agents)

    def get(self, agent_type: str) -> CompiledGraph:
        try:
            return self._agents[agent_type]
        except KeyError as exc:
            raise UnsupportedAgentError(agent_type) from exc
~~~

Planner có thể route tới specialized workflow bằng conditional edge/`Command`,
nhưng route phải dùng enum/schema và policy xác định. Việc đổi agent không đồng nghĩa
đổi model; nhiều agent có thể dùng chung một model profile và một agent có thể dùng
nhiều profile cho các tác vụ khác nhau.

#### 8.5.2 `ModelGateway` port

Interface logic:

~~~python
class ModelGateway(Protocol):
    async def generate(
        self,
        request: ModelRequest,
        *,
        tools: Sequence[ToolDefinition],
    ) -> ModelResponse:
        ...
~~~

ModelRequest đề xuất chứa:

- system policy version;
- prompt template version;
- messages đã sanitize;
- tool definitions đã lọc;
- structured response schema;
- model profile như planner-default hoặc planner-fallback;
- timeout/cost budget cấu hình.

ModelResponse đề xuất chứa:

- provider và model identifier;
- output hoặc tool calls có schema;
- finish reason;
- token/usage metadata nếu provider cung cấp;
- latency;
- provider request identifier đã lọc;
- validation errors.

Provider selection đến từ environment/config, không hard-code trong graph.
Business test phải chạy được với fake/deterministic gateway mà không gọi mạng.

#### 8.5.3 LiteLLM adapter cho MVP

`LiteLLMModelGateway` là infrastructure adapter mặc định. Adapter chịu trách nhiệm:

- ánh xạ model profile nội bộ sang identifier mà LiteLLM hiểu;
- gọi LiteLLM bằng async API;
- chuẩn hóa response, tool call, usage, latency và error về contract nội bộ;
- áp timeout, bounded retry và fallback theo policy cấu hình;
- kiểm tra capability cần thiết như tool calling và structured output;
- redaction provider payload trước khi log/audit;
- gắn correlation/tenant metadata phục vụ telemetry nhưng không đưa secret vào log.

Graph và agent chỉ truyền model profile, ví dụ `planner-default`, `planner-fast` hoặc
`planner-fallback`; chúng không truyền `openai/...`, `anthropic/...` hay tên deployment
cụ thể.

~~~yaml
model_profiles:
  planner-default:
    model: ${PLANNER_DEFAULT_MODEL}
    required_capabilities:
      - tool_calling
      - structured_output
    timeout_seconds: 30
    max_attempts: 2
    fallback_profile: planner-fallback

  planner-fallback:
    model: ${PLANNER_FALLBACK_MODEL}
    required_capabilities:
      - tool_calling
      - structured_output
    timeout_seconds: 30
    max_attempts: 1
~~~

Fallback chỉ áp dụng cho lỗi transient/rate-limit/unavailable được phân loại rõ.
Không tự fallback khi schema validation, permission, policy hoặc business tool bị
từ chối vì retry bằng model khác có thể che lỗi hoặc tạo hành vi ngoài dự kiến.

Adapter không được trả raw provider response ra application layer. Dạng rút gọn:

~~~python
class LiteLLMModelGateway(ModelGateway):
    def __init__(self, profiles: ModelProfileRegistry) -> None:
        self._profiles = profiles

    async def generate(
        self,
        request: ModelRequest,
        *,
        tools: Sequence[ToolDefinition],
    ) -> ModelResponse:
        profile = self._profiles.require(request.model_profile)
        raw = await litellm.acompletion(
            model=profile.model,
            messages=request.messages,
            tools=to_provider_tools(tools),
            response_format=to_response_format(request.structured_response_schema),
            timeout=profile.timeout_seconds,
            num_retries=profile.max_attempts - 1,
        )
        return to_model_response(raw, profile=profile)
~~~

Đây là pseudocode kiến trúc, không phải contract cuối của LiteLLM. Mapping tool,
structured output, streaming và error phải được khóa bằng adapter contract tests.

#### 8.5.4 Khi nào nâng lên LiteLLM Proxy

Không chạy Proxy trong topology MVP mặc định. Xem xét Proxy khi một trong các điều
kiện sau xuất hiện và được đo/chấp nhận:

- từ hai AI service trở lên cần gọi LLM qua một gateway chung;
- cần virtual key, quota/rate limit hoặc budget theo tenant/project;
- cần load balancing/fallback giữa nhiều deployment được quản trị tập trung;
- cần thay đổi provider routing mà không redeploy consumer;
- cần dashboard và audit chi phí tập trung vượt khả năng telemetry hiện tại.

Khi chuyển sang Proxy, chỉ thay implementation/config của `ModelGateway`; graph,
agent registry, business tool và domain contract giữ nguyên. Proxy không được trở
thành nguồn tenant authorization: quyền gọi tool vẫn do Agent Service và service
sở hữu nghiệp vụ kiểm tra.

#### 8.5.5 Giới hạn của model swap

“Engine-agnostic” không có nghĩa các model có hành vi tương đương. Trước khi đưa
một model vào profile, hệ thống phải kiểm chứng tool calling, structured output,
context limit, timeout, streaming nếu dùng, cost/usage metadata và error mapping.
Mọi thay đổi model/profile phải chạy model swap regression ở mục 17.5.

### 8.6 Tool registry

Mỗi tool definition phải có:

| Thuộc tính | Mục đích |
| --- | --- |
| name + version | Contract identity |
| description | Mô tả ngắn, không chứa business secret |
| input_schema | Pydantic/JSON Schema nghiêm ngặt |
| output_schema | Structured result |
| required_permissions | Permission tối thiểu |
| risk_level | READ, DRAFT, ANALYSIS hoặc SENSITIVE_MUTATION |
| idempotency_strategy | Quy tắc chống thực thi lặp |
| timeout/retry policy | Chính sách adapter |
| data classification | Mức dữ liệu được log/trace |
| handler adapter | API client đến service sở hữu |

Tool dự kiến:

| Tool | Nhóm | Service thực thi |
| --- | --- | --- |
| get_order_status | READ | Order Service |
| get_inventory_availability | READ | Inventory Service |
| list_ready_shipments | READ | Fulfillment Service |
| get_trip | READ | Transport Service |
| get_forecast_result | READ | Forecast Service |
| create_order_draft | DRAFT | Order Service |
| create_trip_draft | DRAFT | Transport Service |
| request_forecast | ANALYSIS | Forecast Service |
| request_route_optimization | ANALYSIS | Route Optimizer Service |
| confirm_order | SENSITIVE_MUTATION | Order Service |
| cancel_order | SENSITIVE_MUTATION | Order Service |
| approve_route | SENSITIVE_MUTATION | Transport Service |
| dispatch_trip | SENSITIVE_MUTATION | Transport Service |

Tên endpoint/tool cuối cùng phải đồng bộ với contract của service sở hữu.

### 8.7 Confirmation protocol

1. Planner đề xuất hành động nhạy cảm.
2. Tool adapter gọi preview endpoint của business service hoặc tạo preview bằng
   authoritative read.
3. Agent lưu approval request gồm tenant, actor, action, target, expected version,
   sanitized arguments và idempotency key.
4. Graph checkpoint và chuyển WAITING_CONFIRMATION.
5. UI hiển thị preview; người dùng approve hoặc reject.
6. Khi resume, Agent xác minh lại token/session, tenant, actor, permission và
   aggregate version.
7. Business service thực thi command dưới business validation bình thường.
8. Kết quả và audit được liên kết bằng correlation_id.

Approval không được tái sử dụng cho tenant, actor, action hoặc aggregate khác.
Nếu dữ liệu authoritative thay đổi sau preview, action phải được preview lại
hoặc bị từ chối do stale version.

LangGraph persistence/checkpointer được dùng để pause và resume; PostgreSQL là
lựa chọn production đề xuất. In-memory checkpointer chỉ dùng trong unit/local
prototype.

### 8.8 API contract đề xuất

#### Tạo execution

~~~http
POST /v1/agent/executions
Authorization: Bearer <token>
Idempotency-Key: <uuid>
X-Correlation-Id: <uuid>
Content-Type: application/json
~~~

~~~json
{
  "thread_id": "01J...",
  "message": "Tối ưu tuyến cho chuyến TRIP-102",
  "locale": "vi-VN"
}
~~~

Phản hồi:

~~~json
{
  "execution_id": "01J...",
  "thread_id": "01J...",
  "status": "RUNNING",
  "correlation_id": "01J..."
}
~~~

#### Đọc execution

~~~http
GET /v1/agent/executions/{execution_id}
~~~

#### Gửi quyết định xác nhận

~~~http
POST /v1/agent/executions/{execution_id}/decisions
Idempotency-Key: <uuid>
~~~

~~~json
{
  "approval_id": "01J...",
  "decision": "APPROVE",
  "expected_target_version": 7
}
~~~

Mọi endpoint tự lấy tenant/actor từ identity context đã xác minh; client không
được tự chọn tenant_id trong body.

### 8.9 Persistence đề xuất

#### agent_executions

| Column | Ghi chú |
| --- | --- |
| id | UUID/ULID primary key |
| tenant_id | Bắt buộc, indexed |
| actor_id | User hoặc system actor |
| thread_id | Checkpoint thread |
| agent_type | Agent/workflow đã được registry chọn |
| status | Lifecycle state |
| request_summary | Đã sanitize |
| intent | Structured intent |
| prompt_policy_version | Reproducibility |
| correlation_id | Trace key |
| created_at/started_at/completed_at | Thời gian |
| error_code | Safe terminal code |

#### agent_model_calls

| Column | Ghi chú |
| --- | --- |
| id | Model call id |
| execution_id + tenant_id | Ownership và trace linkage |
| model_profile | Alias nội bộ như `planner-default` |
| gateway_backend | `litellm_sdk` hoặc `litellm_proxy` |
| provider/model | Giá trị resolved tại thời điểm gọi |
| prompt_policy_version | Reproducibility |
| attempt/fallback_from_call_id | Retry/fallback chain |
| input_tokens/output_tokens/cost | Nullable nếu provider không cung cấp |
| latency_ms/status/error_code | Reliability và benchmark |
| provider_request_id | Giá trị đã lọc, không chứa credential |

#### agent_tool_calls

| Column | Ghi chú |
| --- | --- |
| id | Tool call id |
| execution_id + tenant_id | Ownership |
| tool_name/tool_version | Contract |
| risk_level | Policy |
| input_redacted/output_redacted | JSONB đã lọc |
| idempotency_key | Unique theo scope phù hợp |
| status/attempt_count | Reliability |
| latency_ms | Metrics |
| target_service | Integration |
| error_code | Safe failure |

#### agent_approvals

| Column | Ghi chú |
| --- | --- |
| id | Approval id |
| execution_id/tenant_id/actor_id | Context binding |
| action/target_type/target_id | Command |
| expected_target_version | Concurrency |
| preview_redacted | Nội dung hiển thị |
| status | PENDING/APPROVED/REJECTED/EXPIRED |
| decision_at | Audit |

LangGraph checkpoint tables có thể do adapter chính thức quản lý. Không trộn
checkpoint tables với authoritative business entities.

## 9. Demand Forecast Agent / Forecast Service

### 9.1 Input và data contract

Một forecast series được định danh bởi:

~~~text
(tenant_id, warehouse_id, sku_id)
~~~

Input tối thiểu:

- date range lịch sử;
- daily quantity từ order COMPLETED;
- warehouse_id và sku_id;
- horizon mặc định 7 ngày;
- timezone/calendar policy;
- optional model configuration version.

Không đưa order bị hủy, demand từ tenant khác hoặc draft order vào training data.
Khoảng dữ liệu seed khuyến nghị tối thiểu 180 ngày.

### 9.2 Data acquisition

Forecast Service không query Order database trực tiếp. Hai phương án hợp lệ:

1. gọi read/export API có version của Order Service; hoặc
2. dùng tenant-scoped projection được xây idempotently từ event/authoritative
   export và có khả năng rebuild.

Phương án cụ thể phải được xác nhận khi Order Service contract hoàn thiện.

### 9.3 Pipeline

~~~mermaid
flowchart LR
    A[Validate request and tenant] --> B[Load completed daily demand]
    B --> C[Normalize dates and fill missing days]
    C --> D[Data quality checks]
    D --> E[Time-based train/backtest split]
    E --> F[Run naive and moving-average baselines]
    E --> G[Run Prophet/ForecastEngine]
    F --> H[Calculate comparable metrics]
    G --> H
    H --> I[Select result and confidence/fallback]
    I --> J[Persist metadata and predictions]
    J --> K[Publish ForecastCompleted through outbox]
~~~

### 9.4 Data preprocessing

- Chuẩn hóa theo một business timezone đã cấu hình.
- Aggregate quantity theo ngày.
- Điền ngày thiếu bằng 0 chỉ khi ngày đó thật sự không có completed demand, không
  dùng 0 để che lỗi dữ liệu.
- Loại bỏ duplicate theo authoritative order/line identity.
- Phát hiện series quá ngắn, toàn 0 hoặc có gap dữ liệu không giải thích được.
- Không tự động loại outlier mà không lưu rule/version; benchmark phải tái lập.
- Lưu data window, row count, checksum/input hash và quality warnings.

### 9.5 Baseline

MVP chạy tối thiểu một trong hai, khuyến nghị chạy cả hai:

- **Naive:** dự báo mỗi ngày bằng actual của ngày gần nhất hợp lệ.
- **Moving average 7 ngày:** dự báo bằng trung bình 7 ngày gần nhất.

Baseline dùng đúng cùng training window, horizon và evaluation window với model.

### 9.6 Metrics

RMSE:

~~~text
RMSE = sqrt(mean((actual - predicted)^2))
~~~

MAPE:

~~~text
MAPE = mean(abs((actual - predicted) / actual)) * 100
~~~

Vì MAPE không xác định khi actual bằng 0, quy tắc đề xuất cho MVP:

- tính MAPE chỉ trên điểm có actual lớn hơn 0;
- lưu mape_eligible_points và total_evaluation_points;
- trả MAPE bằng null nếu không có điểm hợp lệ;
- luôn trả RMSE trên toàn evaluation window;
- có thể bổ sung WAPE/sMAPE để phân tích nhưng không thay thế tiêu chí BRD.

Quy tắc này phải được khóa cùng benchmark trước khi công bố kết quả.

### 9.7 Confidence và fallback

| Điều kiện | Hành vi |
| --- | --- |
| Dữ liệu đủ, engine thành công | Trả model forecast + interval + baseline + metrics |
| Dữ liệu ngắn nhưng baseline chạy được | Trả baseline, confidence LOW và warning |
| Series toàn 0 | Trả kết quả zero/baseline theo rule, confidence LOW |
| Engine lỗi, baseline chạy được | Trả baseline fallback và error metadata |
| Không có dữ liệu hợp lệ | FAILED hoặc INSUFFICIENT_DATA; không để LLM bịa số |

Forecast chỉ mang tính tư vấn và không tự tạo nhập kho hoặc thay đổi low-stock
threshold.

### 9.8 ForecastEngine

~~~python
class ForecastEngine(Protocol):
    async def fit_predict(
        self,
        series: TimeSeries,
        config: ForecastConfig,
    ) -> ForecastEngineResult:
        ...
~~~

Adapter Prophet phải lưu:

- engine name/version;
- model/config version;
- effective parameters;
- data input hash;
- random seed nếu có;
- train/evaluation window;
- runtime;
- warning và failure code.

### 9.9 API đề xuất

~~~http
POST /v1/forecast-runs
Idempotency-Key: <uuid>
~~~

~~~json
{
  "warehouse_id": "WH-01",
  "sku_ids": ["SKU-01", "SKU-02"],
  "history_from": "2026-01-01",
  "history_to": "2026-06-30",
  "horizon_days": 7
}
~~~

Service persist job và trả 202 khi xử lý nền:

~~~json
{
  "forecast_run_id": "01J...",
  "status": "QUEUED",
  "correlation_id": "01J..."
}
~~~

Đọc trạng thái/kết quả:

~~~http
GET /v1/forecast-runs/{forecast_run_id}
GET /v1/forecast-runs/{forecast_run_id}/results
~~~

### 9.10 Persistence đề xuất

#### forecast_runs

| Column | Ghi chú |
| --- | --- |
| id + tenant_id | Identity/ownership |
| status | QUEUED/RUNNING/SUCCEEDED/FAILED |
| history_from/history_to/horizon | Window |
| input_hash | Reproducibility |
| engine_name/version | Runtime |
| config_version | Model config |
| requested_by | User/scheduler |
| correlation_id | Trace |
| timestamps/runtime_ms | Performance |
| failure_code | Safe failure |

#### forecast_results

| Column | Ghi chú |
| --- | --- |
| run_id + tenant_id | Ownership |
| warehouse_id + sku_id + forecast_date | Series key |
| predicted_value/lower_bound/upper_bound | Output |
| baseline_naive/baseline_ma7 | Comparison |
| confidence_level | Advisory signal |
| model_metadata | Reproducibility |

#### forecast_metrics

Lưu metric name/value, evaluation window, eligible point count và baseline/model
identity. Không overwrite metric lịch sử của một run đã hoàn tất.

## 10. Route Optimizer Agent / Route Optimizer Service

### 10.1 Bài toán MVP

Mỗi DeliveryTrip có:

- một depot/warehouse;
- một vehicle;
- một driver;
- N shipment/stop;
- một proposed RoutePlan;
- Dispatcher là người approve hoặc override.

Đây là bài toán một vehicle depot-to-stops-to-depot. Nếu tổng tải đã vượt capacity
thì request không feasible; solver không được dùng để “sửa” dữ liệu business sai.

### 10.2 Input contract

~~~json
{
  "trip_id": "TRIP-102",
  "trip_version": 7,
  "warehouse_id": "WH-01",
  "depot": {
    "id": "WH-01",
    "lat": 10.77,
    "lon": 106.70
  },
  "vehicle": {
    "id": "VEH-08",
    "capacity_weight": 2000,
    "capacity_volume": 12
  },
  "stops": [
    {
      "stop_id": "STOP-01",
      "shipment_id": "SHP-01",
      "lat": 10.80,
      "lon": 106.68,
      "demand_weight": 120,
      "demand_volume": 0.8
    }
  ],
  "distance_matrix": [[0, 5400], [5400, 0]],
  "objective": "MIN_DISTANCE"
}
~~~

Input authoritative phải đến từ Transport/Master Data contract. Client hoặc LLM
không được tự gán capacity, warehouse hay shipment membership.

### 10.3 Ràng buộc

Bắt buộc:

- route bắt đầu và kết thúc tại depot;
- mỗi stop xuất hiện đúng một lần;
- mọi shipment thuộc cùng warehouse với trip;
- vehicle và driver hợp lệ theo Transport Service;
- tổng weight và volume không vượt capacity;
- mỗi stop tham chiếu một shipment hợp lệ trong trip;
- trip version không stale.

Tùy chọn sau quality gate:

- time windows;
- service time;
- soft penalty;
- multi-objective cost.

### 10.4 Pipeline

~~~mermaid
flowchart LR
    A[Validate request/schema] --> B[Load authoritative trip snapshot]
    B --> C[Validate tenant, warehouse, capacity, version]
    C --> D[Resolve/validate distance matrix]
    D --> E[Calculate input-order baseline]
    D --> F[Calculate nearest-neighbor baseline]
    D --> G[Run OR-Tools RouteEngine]
    E --> H[Feasibility verification]
    F --> H
    G --> H
    H --> I[Calculate objective and improvement]
    I --> J[Persist request, result and input hash]
    J --> K[Publish RouteOptimized through outbox]
~~~

### 10.5 Distance matrix

MVP ưu tiên matrix đã được chuẩn bị hoặc provider adapter xác định. Benchmark
phải dùng matrix cố định và versioned để tái lập. Nếu tính từ tọa độ:

- công thức/provider phải được ghi rõ;
- unit phải thống nhất;
- matrix phải được validate kích thước, diagonal và giá trị âm;
- cache key phải bao gồm provider/version/input hash;
- lỗi matrix không được thay bằng số do LLM suy đoán.

Traffic live nằm ngoài MVP.

### 10.6 Baseline và objective

Baseline:

- thứ tự stop đầu vào;
- nearest-neighbor deterministic với tie-break ổn định.

Objective MVP:

~~~text
minimize total route distance
~~~

Improvement:

~~~text
improvement_ratio =
    (baseline_distance - optimized_distance) / baseline_distance
~~~

Khi baseline distance bằng 0, improvement_ratio là null và phải kèm reason.

### 10.7 Feasibility verifier

Kết quả solver chưa được tin trực tiếp. Verifier độc lập phải kiểm tra:

- số stop output bằng số stop input;
- tập stop id giống nhau, không duplicate;
- điểm đầu/cuối là depot;
- capacity không bị vi phạm;
- tổng distance khớp các leg trong tolerance đã cấu hình;
- route gắn đúng input_hash và trip_version.

Nếu verifier fail, result là FAILED/INVALID_SOLUTION và không phát
RouteOptimized như một kết quả hợp lệ.

### 10.8 RouteEngine

~~~python
class RouteEngine(Protocol):
    async def optimize(
        self,
        problem: RouteProblem,
        config: RouteConfig,
    ) -> RouteEngineResult:
        ...
~~~

OR-Tools adapter lưu:

- solver/version;
- search strategy/config version;
- time limit;
- seed nếu có;
- input hash;
- solver status;
- objective;
- runtime;
- warnings.

### 10.9 API đề xuất

~~~http
POST /v1/route-optimizations
Idempotency-Key: <uuid>
~~~

~~~json
{
  "trip_id": "TRIP-102",
  "expected_trip_version": 7,
  "objective": "MIN_DISTANCE"
}
~~~

Service lấy snapshot authoritative qua Transport contract, persist job và trả:

~~~json
{
  "route_request_id": "01J...",
  "status": "QUEUED",
  "correlation_id": "01J..."
}
~~~

Đọc kết quả:

~~~http
GET /v1/route-optimizations/{route_request_id}
~~~

Route Optimizer không approve route. Transport Service nhận proposed result,
kiểm tra version và lưu RoutePlan. Dispatcher approve/override trong Transport.

### 10.10 Persistence đề xuất

#### route_optimization_requests

| Column | Ghi chú |
| --- | --- |
| id + tenant_id | Identity/ownership |
| trip_id/trip_version | Business reference |
| status | QUEUED/RUNNING/SUCCEEDED/FAILED/INFEASIBLE |
| input_hash | Reproducibility/idempotency |
| objective | MIN_DISTANCE |
| solver_name/version/config_version | Runtime |
| correlation_id | Trace |
| timestamps/runtime_ms | Performance |
| failure_code | Safe failure |

#### route_optimization_results

| Column | Ghi chú |
| --- | --- |
| request_id + tenant_id | Ownership |
| stop_sequence | Structured sequence |
| legs | Distance/cost per leg |
| total_distance/total_cost | Objective |
| baseline_type/value | Comparison |
| improvement_ratio | Quality |
| feasibility_status | Verification |
| input_hash | Reproducibility |

Không overwrite result lịch sử; rerun tạo request/version mới hoặc reuse kết quả
khi idempotency contract xác định đúng cùng input.

## 11. Giao tiếp synchronous và asynchronous

### 11.1 Quy tắc chọn

| Trường hợp | Cơ chế |
| --- | --- |
| Xác thực, authorize, preview, đọc trạng thái | HTTP synchronous |
| Tạo forecast/optimization job | HTTP command, thường trả 202 |
| Thông báo một fact đã hoàn thành | Kafka domain event |
| Resume Agent khi specialized job hoàn thành | Consumer idempotent từ completion event |
| Dashboard/fan-out/audit reaction | Kafka |

Kafka event là fact đã xảy ra, không phải RPC trá hình. Forecast/route request
được gửi qua API command và lưu thành job trong database của service sở hữu.
Worker có thể claim job từ cùng database; completion được publish bằng outbox.

### 11.2 Forecast sequence

~~~mermaid
sequenceDiagram
    participant U as User/Scheduler
    participant A as Agent/API
    participant F as Forecast Service
    participant D as Forecast DB
    participant K as Kafka

    U->>A: Request forecast
    A->>F: POST forecast-runs + tenant/correlation/idempotency
    F->>D: Persist QUEUED job
    F-->>A: 202 + forecast_run_id
    A->>A: Checkpoint WAITING_TOOL
    F->>D: Worker claim and execute
    F->>D: Persist results + outbox
    F->>K: ForecastCompleted
    K->>A: Completion consumer
    A->>A: Resume graph and verify result
    A-->>U: Forecast + baseline + metrics
~~~

### 11.3 Sensitive action sequence

~~~mermaid
sequenceDiagram
    participant U as User
    participant A as Agent Service
    participant B as Business Service

    U->>A: Natural-language sensitive request
    A->>A: Filter tool + validate permission
    A->>B: Request authoritative preview
    B-->>A: Preview + aggregate version
    A->>A: Save approval + checkpoint
    A-->>U: Ask explicit confirmation
    U->>A: Approve with approval_id
    A->>A: Revalidate tenant, actor, permission
    A->>B: Execute command + expected version + idempotency key
    B-->>A: Authoritative outcome
    A-->>U: Grounded result
~~~

## 12. Contract chung

### 12.1 Request context

Mọi service-to-service request liên quan người dùng phải truyền semantic context:

- tenant_id có thể kiểm chứng;
- actor_id;
- effective permissions hoặc token cho phép service đích tự authorize;
- correlation_id;
- causation_id khi request phát sinh từ một bước trước;
- idempotency_key với command có side effect;
- contract version.

Không tin tenant_id do LLM hoặc client body tự khai báo.

### 12.2 Error contract đề xuất

~~~json
{
  "type": "https://logix/errors/tool-timeout",
  "title": "Tool execution timed out",
  "status": 504,
  "code": "AGENT_TOOL_TIMEOUT",
  "correlation_id": "01J...",
  "retryable": true,
  "details": {
    "tool": "request_route_optimization"
  }
}
~~~

Không trả stack trace, raw provider response, prompt chứa secret hoặc internal
database information cho client.

### 12.3 Event envelope

~~~json
{
  "event_id": "01J...",
  "event_type": "ForecastCompleted",
  "event_version": 1,
  "occurred_at": "2026-09-04T10:00:00Z",
  "producer": "forecast-service",
  "tenant_id": "TENANT-01",
  "actor_id": "USER-01",
  "correlation_id": "01J...",
  "causation_id": "01J...",
  "aggregate_type": "ForecastRun",
  "aggregate_id": "01J...",
  "aggregate_version": 1,
  "payload": {
    "forecast_run_id": "01J...",
    "status": "SUCCEEDED"
  }
}
~~~

Payload event chỉ chứa dữ liệu tối thiểu để consumer xác định fact và lấy dữ liệu
authoritative khi cần. Không nhúng history dataset, prompt hoặc token.

## 13. Job processing và idempotency

### 13.1 Job claim đề xuất

Forecast/route worker có thể claim job từ database service-owned bằng cơ chế lock
an toàn như SELECT FOR UPDATE SKIP LOCKED hoặc queue abstraction tương đương.
Nhiều replica không được chạy cùng một job đồng thời ngoài chủ ý.

### 13.2 Idempotency scope

| Operation | Key đề xuất |
| --- | --- |
| Create AgentExecution | tenant + actor + Idempotency-Key |
| Tool call | execution + tool_call_id |
| Forecast request | tenant + input_hash + request idempotency key |
| Route request | tenant + trip_id + trip_version + input_hash |
| ForecastCompleted consumer | event_id hoặc forecast_run_id |
| RouteOptimized consumer | event_id hoặc route_request_id |
| AgentExecutionCompleted consumer | event_id hoặc execution_id |

Duplicate request phải trả lại resource/outcome trước đó khi semantic input giống
nhau; nếu cùng key nhưng payload khác thì trả conflict, không chạy mơ hồ.

### 13.3 Outbox/inbox

- Service lưu result và outbox record trong cùng transaction.
- Publisher gửi outbox lên Kafka và đánh dấu đã publish.
- Consumer lưu inbox/dedup record cùng transaction với local effect.
- Retry không tạo duplicate business effect.
- Out-of-order event không làm trạng thái lùi; aggregate version được kiểm tra.

## 14. Multi-tenant và bảo mật

### 14.1 Các lớp kiểm soát

1. Gateway xác thực request và tạo correlation context.
2. Agent API xác minh identity context; không nhận tenant tùy ý từ body.
3. Tool registry lọc tool theo permission trước khi tool schema đến LLM.
4. Tool handler gắn tenant/actor vào request service-to-service.
5. Business service authorize lại và scope repository/query theo tenant.
6. Database table có tenant_id, index phù hợp và repository guard.
7. Event consumer kiểm tra tenant và xử lý idempotently.
8. Audit ghi actor, tenant, action, entity, outcome và correlation.

Database Row-Level Security có thể bổ sung như defense-in-depth nhưng không được
coi là thay thế application authorization; áp dụng RLS cần ADR và test riêng.

### 14.2 Prompt-injection và untrusted data

- Business data, tool result và user input đều là untrusted content đối với model.
- Không nối raw input vào system policy.
- Tool arguments phải parse và validate qua strict schema.
- Model không chọn URL, SQL, topic hoặc service name tùy ý.
- Không có generic execute_sql, call_url, publish_event hoặc shell tool.
- Tool output phải giới hạn size, field và classification trước khi đưa lại model.
- External text không được thay đổi permission, system policy hoặc approval rule.

### 14.3 Secret và PII

- API key từ secret/config mechanism, không commit.
- Authorization header không log.
- Raw prompt/tool payload chỉ lưu khi đã có classification và redaction policy.
- Metric không dùng tenant_id, user_id, execution_id làm label có cardinality cao.
- Trace/log có correlation_id; quyền truy cập log phải theo môi trường vận hành.

## 15. Reliability và failure handling

### 15.1 Nguyên tắc retry

Chỉ retry lỗi transient và operation idempotent. Không retry:

- authentication/authorization failure;
- validation failure;
- business-rule rejection;
- stale aggregate version;
- infeasible route;
- insufficient forecast data nếu input không thay đổi;
- user rejection.

Retry dùng bounded exponential backoff với jitter. Số lần và timeout là cấu hình
được đo bằng integration test, không hard-code rải rác.

### 15.2 Failure matrix

| Failure | Hành vi | Fallback |
| --- | --- | --- |
| LLM timeout/unavailable | Agent execution FAILED hoặc thử provider fallback theo policy | Người dùng dùng UI/API business |
| LLM trả tool không tồn tại | Reject structured output; không gọi tool | Yêu cầu model sửa trong budget hoặc trả lỗi rõ |
| Tool argument invalid | Schema validation fail | Không thực thi side effect |
| Business service unavailable | Bounded retry nếu idempotent | Trả pending/failed rõ ràng |
| Forecast engine lỗi | Lưu failure; thử baseline nếu hợp lệ | Baseline + LOW confidence |
| Insufficient forecast data | Không gọi LLM để điền số | Baseline hoặc INSUFFICIENT_DATA |
| Solver timeout | Lưu timeout và metrics | Input order/manual planning |
| Route infeasible | Trả reason có cấu trúc | Dispatcher chỉnh trip |
| Kafka publish fail | Outbox giữ event để retry | Result vẫn có local state rõ |
| Duplicate event | Inbox/dedup bỏ effect lặp | Trả processing outcome cũ |
| Checkpoint DB unavailable | Không tiếp tục graph mơ hồ | Fail/hold trước side effect |
| Approval stale | Từ chối command | Preview lại |

### 15.3 Timeout budget

Timeout cụ thể cần khóa bằng benchmark. Nguyên tắc:

- mỗi remote call có timeout;
- graph có tổng execution budget;
- tool có budget riêng nhỏ hơn tổng;
- route/forecast job dài chạy nền và trả job id;
- client polling hoặc event notification không giữ HTTP connection dài;
- khi budget hết, trạng thái persisted phải cho biết có thể retry/resume hay không.

### 15.4 Circuit breaker và bulkhead

Đây là đề xuất sau khi có integration baseline:

- circuit breaker theo downstream/provider;
- concurrency limit riêng cho LLM, forecast worker và route worker;
- không để batch forecast chiếm hết worker phục vụ request nhỏ;
- rate limit theo tenant và actor ở Agent API;
- model cost/token budget theo environment.

## 16. Observability

### 16.1 Correlation

correlation_id phải đi xuyên:

~~~text
Client → Gateway → Agent → Tool → Business/AI Service
       → DB job → Worker → Outbox → Kafka → Consumer → Agent resume
~~~

causation_id trỏ tới request/event trực tiếp gây ra bước hiện tại.

### 16.2 Structured log

Field tối thiểu:

- timestamp;
- level;
- service;
- environment;
- operation;
- correlation_id;
- causation_id khi có;
- tenant context đã xử lý theo policy;
- execution/job/tool identifier;
- status;
- duration_ms;
- retry_count;
- error_code.

Không log secret, raw access token, full prompt, raw PII hoặc dataset forecast.

### 16.3 Metrics đề xuất

Agent:

- agent_executions_total theo status/intent;
- agent_execution_duration_seconds;
- agent_tool_calls_total theo tool/status;
- agent_tool_call_duration_seconds;
- agent_tool_validation_failures_total;
- agent_approval_requests_total theo decision;
- agent_model_calls_total theo model profile/provider/status;
- agent_model_call_duration_seconds theo model profile/provider;
- agent_model_fallback_total theo profile nguồn/đích và reason class;
- agent_provider_errors_total theo provider/error class;
- agent_tool_success_rate từ evaluation, không suy ra mơ hồ từ production count.

Forecast:

- forecast_runs_total theo status/engine;
- forecast_run_duration_seconds;
- forecast_series_processed_total;
- forecast_fallback_total;
- forecast_mape và forecast_rmse trong benchmark/report;
- forecast_input_quality_warning_total.

Route:

- route_runs_total theo status/solver;
- route_solver_duration_seconds;
- route_stop_count histogram;
- route_infeasible_total;
- route_invalid_solution_total;
- route_distance_improvement_ratio trong benchmark/report.

System:

- HTTP latency/error rate;
- Kafka publish-to-effect latency;
- outbox backlog;
- consumer lag;
- retry/DLQ count;
- worker queue depth;
- active replicas và throughput.

Không đưa request_id, tenant_id, actor_id hoặc SKU vào metric labels.

### 16.4 Tracing

Span đề xuất:

- agent.execution;
- agent.model.generate;
- agent.tool.validate;
- agent.tool.execute;
- agent.approval.wait;
- forecast.load_data;
- forecast.preprocess;
- forecast.baseline;
- forecast.engine;
- route.load_snapshot;
- route.matrix;
- route.solver;
- route.verify;
- kafka.publish;
- kafka.consume.

Prompt/body phải được redaction trước khi đính vào span.

## 17. Testing và đánh giá

### 17.1 Test pyramid

| Cấp | Nội dung |
| --- | --- |
| Unit | Policy, validators, metrics, baselines, solver verifier, graph routing |
| Contract | OpenAPI/JSON Schema, provider adapter, event schema compatibility |
| Integration | PostgreSQL, checkpointer, outbox/inbox, HTTP adapters, Kafka |
| Security negative | Cross-tenant, privilege escalation, hidden tool, stale approval |
| Agent evaluation | Fixed 30+ scenarios, correct tool/args/permission/outcome |
| Model regression | Chạy cùng scenario set khi đổi provider/model |
| Quantitative evaluation | Fixed forecast dataset và route dataset/baseline |
| E2E | User → Agent → service → event → dashboard/audit |
| Fault injection | LLM/tool/solver/Kafka/checkpoint failure |
| Load | API, event latency, 100-series forecast, 50-stop route, replica scale |

### 17.2 Định nghĩa Tool Success Rate

Một scenario chỉ được tính thành công khi đồng thời:

1. chọn đúng tool hoặc từ chối đúng khi user không có quyền;
2. arguments parse được và đúng schema;
3. tenant và actor context đúng;
4. không gọi thêm prohibited tool;
5. kết quả được diễn giải dựa trên tool output;
6. hành động nhạy cảm tạo preview và chờ confirmation;
7. outcome/audit đúng.

~~~text
Tool Success Rate = successful scenarios / total fixed scenarios
~~~

Không tính tool call HTTP 200 nhưng chọn sai nghiệp vụ là thành công.

Scenario set tối thiểu gồm:

- read order/inventory/shipment/trip;
- tạo draft hợp lệ;
- forecast request;
- route request;
- role không có quyền;
- cross-tenant identifier;
- malformed/ambiguous input;
- model yêu cầu tool không tồn tại;
- preview/approve/reject;
- stale confirmation;
- downstream timeout;
- duplicate execution;
- prompt injection nằm trong business data.

### 17.3 Forecast evaluation

- Dataset versioned với seed và checksum.
- Time-based split; không random shuffle time series.
- Model và baseline dùng cùng evaluation window.
- Report per-series và aggregate MAPE/RMSE.
- Ghi quy tắc actual bằng 0 và coverage.
- Ghi runtime, hardware/container resource và concurrency.
- Test insufficient data, all-zero series, missing dates và duplicate input.

### 17.4 Route evaluation

- Dataset fixed gồm nhiều mức stop: 5, 10, 25, 50.
- Matrix versioned/checksum.
- So sánh input-order và nearest-neighbor.
- Kiểm tra feasibility độc lập cho mọi nghiệm.
- Report total distance, improvement, runtime và solver status.
- Test duplicate/missing stop, wrong warehouse, exceeded capacity, invalid matrix,
  stale trip version và solver timeout.

### 17.5 Model swap test

1. Đổi mapping của model profile bằng environment/config; không đổi `agent_type`.
2. Không sửa graph, agent, tool, `ModelGateway` port hoặc business service code.
3. Chạy adapter contract tests cho response, tool call, structured output, timeout
   và error mapping.
4. Chạy fixed scenario set với model cũ và model mới.
5. So sánh Tool Success Rate, schema-validation rate, latency, provider error và
   chi phí/usage nếu có.
6. Chạy negative scenarios cho unauthorized tool, cross-tenant identifier, prompt
   injection và sensitive action; model mới không được làm yếu policy xác định.
7. Hoàn tất trong tối đa một giờ.
8. Lưu gateway mode, model profile, resolved provider/model, LiteLLM version,
   prompt/policy version và report.

Model mới chỉ được promote thành `planner-default` khi đạt acceptance threshold.
Fallback kỹ thuật không được tính là pass nếu primary model không đáp ứng contract.

### 17.6 Acceptance matrix

| ID | Proof |
| --- | --- |
| AI-01 | 30+ Planner scenarios; Tool Success Rate ≥ 90% |
| AI-02 | Unauthorized/cross-tenant tools không xuất hiện hoặc bị từ chối server-side |
| AI-03 | Sensitive tool pause trước side effect; approve/reject/stale tests |
| AI-04 | LLM outage không chặn business UI/API |
| FC-01 | 7-day forecast + baseline + MAPE/RMSE + metadata |
| FC-02 | 100 series ≤ 60s hoặc measured limit được công bố |
| FC-03 | Insufficient data không sinh số bằng LLM |
| RO-01 | Mỗi stop đúng một lần, depot start/end, capacity hợp lệ |
| RO-02 | ≤ 10s cho 50 stops trong benchmark environment |
| RO-03 | Có baseline, objective, input hash, solver/version |
| REL-01 | Duplicate command/event không tạo effect lặp |
| REL-02 | Retry exhausted có terminal state, audit và fallback |
| OBS-01 | Correlation truy được xuyên HTTP/job/event |

## 18. CI/CD quality gates đề xuất

### Pull request

- format/lint/type check;
- unit tests;
- schema/contract compatibility;
- deterministic graph tests với fake model;
- security negative tests không cần external provider;
- migration validation.

### Main/nightly hoặc benchmark pipeline

- PostgreSQL/Kafka integration tests;
- fixed Agent evaluation với provider đã cấu hình;
- forecast benchmark;
- route benchmark;
- fault-injection suite;
- image vulnerability/dependency scan nếu pipeline hiện tại hỗ trợ.

Không để CI thường xuyên phụ thuộc bắt buộc vào external LLM khi có thể dùng fake
gateway. Provider regression là suite riêng có quota, secret và report rõ ràng.

## 19. Deployment

### 19.1 Local

Docker Compose đề xuất gồm:

- PostgreSQL;
- Kafka và dependency cần thiết của distribution được chọn;
- Redis nếu use case đã được bật;
- agent-service;
- forecast-service;
- route-optimizer-service;
- các core service cần cho vertical slice;
- telemetry collector/metrics backend tối thiểu khi test observability.

LiteLLM Python SDK chạy bên trong `agent-service`, vì vậy MVP mặc định không thêm
container LiteLLM Proxy. Nếu tiêu chí tại mục 8.5.4 được chấp nhận, Proxy mới được
thêm như một dependency độc lập với health/readiness, secret và telemetry riêng.

Health endpoint:

- liveness chỉ phản ánh process;
- readiness phản ánh dependency bắt buộc để nhận workload;
- model provider outage không làm core business service unready;
- forecast/route worker health tách khỏi API health khi triển khai process riêng.

### 19.2 Worker

API persist job và worker claim từ service-owned database. Có thể chạy API và
worker từ cùng image với command khác nhau. Horizontal scale worker dùng cơ chế
claim an toàn và concurrency limit.

### 19.3 Kubernetes evidence

Không triển khai Kubernetes cho toàn hệ thống chỉ để hoàn thành checklist. Chọn
một workload có số liệu, ví dụ Forecast Worker:

1. khóa dataset và resource requests/limits;
2. đo throughput/latency với một replica;
3. tăng replica hoặc cấu hình autoscaling theo metric phù hợp;
4. chạy lại cùng workload;
5. ghi số liệu trước/sau, queue depth và resource usage.

## 20. Cấu hình

Nhóm cấu hình đề xuất:

~~~text
APP_ENV
SERVICE_NAME
DATABASE_URL
KAFKA_BOOTSTRAP_SERVERS
REDIS_URL

LLM_GATEWAY_BACKEND=litellm_sdk
LLM_MODEL_PROFILES_PATH
PLANNER_DEFAULT_MODEL
PLANNER_FALLBACK_MODEL
LLM_TIMEOUT_SECONDS
LLM_MAX_ATTEMPTS
LLM_FALLBACK_ENABLED
LITELLM_PROXY_URL          # chỉ dùng khi backend=litellm_proxy
PROMPT_POLICY_VERSION

FORECAST_ENGINE
FORECAST_HORIZON_DAYS
FORECAST_MIN_HISTORY_DAYS

ROUTE_ENGINE
ROUTE_SOLVER_TIME_LIMIT_SECONDS
ROUTE_MAX_STOPS
~~~

Đây là tên minh họa, chưa phải contract cấu hình đã chấp nhận. Secret không có
default trong source và không xuất hiện trong logs. API key của từng provider được
cấp qua secret mechanism của môi trường; không đặt key trong model profile YAML.

## 21. Kế hoạch triển khai 8 tuần

### Tuần 1 — Architecture, contracts và benchmark foundation

Mục tiêu:

- khóa boundary ba AI service;
- chốt GraphState, execution lifecycle và tool risk model;
- chốt ranh giới `AgentRegistry` (agent swap) và `ModelGateway` (model swap);
- định nghĩa OpenAPI/event schemas;
- khóa benchmark datasets/scenario set;
- tạo ADR cần thiết cho LangGraph, LiteLLM SDK và Python package/runtime conventions.

Đầu ra:

- service/API/event contract draft;
- database schema draft;
- threat model và permission matrix;
- 30+ Planner scenarios;
- forecast/route dataset version + checksum;
- skeleton ba FastAPI service.

Gate:

- không còn Agent-to-business-database path;
- tool permission và sensitive-action list truy vết về BRD;
- benchmark có thể chạy lặp lại.

### Tuần 2 — Agent platform foundation

Mục tiêu:

- dựng LangGraph runtime;
- `AgentRegistry` với allow-list agent/workflow;
- `ModelGateway`, `LiteLLMModelGateway` và fake gateway;
- model profile registry, capability validation và bounded fallback;
- PostgreSQL checkpointer;
- tool registry, context propagation và audit metadata.

Đầu ra:

- create/get AgentExecution API;
- Planner graph chạy được read-only tool giả;
- deterministic unit tests;
- structured logs/traces;
- provider/model config không hard-code và graph không import LiteLLM.

Gate:

- restart process và resume execution thử nghiệm;
- unauthorized tool không được đưa vào model tool list;
- fake gateway thay được LiteLLM adapter mà không sửa graph;
- lỗi policy/schema không kích hoạt provider fallback;
- token/secret không xuất hiện trong checkpoint/log.

### Tuần 3 — Demand Forecast Agent

Mục tiêu:

- hoàn thiện forecast data contract và pipeline;
- Prophet adapter, naive và moving-average baseline;
- MAPE/RMSE, confidence và fallback.

Đầu ra:

- ForecastRun API + worker;
- persistence/migration;
- fixed dataset tests;
- ForecastCompleted outbox/event;
- report so sánh model/baseline bước đầu.

Gate:

- 7-day output tái lập với metadata;
- actual bằng 0 có rule rõ;
- insufficient data không dùng LLM sinh số.

### Tuần 4 — Route Optimizer Agent

Mục tiêu:

- hoàn thiện route input/constraint contract;
- OR-Tools adapter;
- baseline và independent feasibility verifier.

Đầu ra:

- RouteOptimization API + worker;
- persistence/migration;
- input hash, solver/version và metrics;
- RouteOptimized outbox/event;
- test 5/10/25/50 stop.

Gate:

- mỗi stop đúng một lần;
- start/end depot;
- wrong warehouse/capacity/matrix bị từ chối;
- kết quả không tự approve trong Transport.

### Tuần 5 — Planner tools và vertical slices

Mục tiêu:

- kết nối Planner với business read/draft tools;
- kết nối forecast/route tools;
- resume graph từ completion event.

Vertical slices:

1. user hỏi tồn kho → tool → grounded answer;
2. user yêu cầu forecast → job → event → result;
3. user yêu cầu optimize trip → job → event → proposed route.

Gate:

- end-to-end correlation;
- duplicate completion event không resume/effect hai lần;
- tool output được sanitize trước khi quay lại model.

### Tuần 6 — Confirmation, reliability và tenant security

Mục tiêu:

- preview + approve/reject/resume;
- timeout, bounded retry, fallback;
- outbox/inbox/idempotency;
- tenant/RBAC negative tests.

Đầu ra:

- confirm/cancel/approve/dispatch confirmation flow;
- stale approval test;
- LLM/forecast/solver outage tests;
- audit link theo correlation;
- manual fallback UI/API behavior được chứng minh.

Gate:

- không có side effect trước approval;
- retry/duplicate không tạo effect lặp;
- cross-tenant suite pass.

### Tuần 7 — Evaluation, performance và hardening

Mục tiêu:

- chạy Agent evaluation;
- forecast/route benchmark;
- load/event latency/fault tests;
- sửa bottleneck và khóa release candidate.

Đầu ra:

- Tool Success Rate report;
- forecast quality/runtime report;
- route quality/runtime report;
- event p95 và API p95 report;
- model swap rehearsal qua LiteLLM profile, không sửa agent/graph/business code;
- risk register cập nhật.

Gate:

- đạt Must criteria;
- Should criteria đạt hoặc có measured limitation minh bạch;
- không còn lỗi security/reliability nghiêm trọng.

### Tuần 8 — Demo, observability và bàn giao

Mục tiêu:

- hoàn thiện E2E demo;
- dashboard/notification/audit evidence;
- tài liệu vận hành và báo cáo khóa luận.

Demo xuyên suốt:

~~~text
Login
→ tạo/cập nhật dữ liệu nghiệp vụ
→ business event
→ Planner hoặc specialized AI job
→ kết quả persisted
→ proposed action/approval khi cần
→ dashboard + notification + audit + trace
~~~

Đầu ra:

- release candidate;
- Docker Compose reproducible;
- runbook;
- benchmark artifacts;
- architecture/contract docs;
- kịch bản demo và bảo vệ;
- danh sách limitation/future work.

## 22. Phân công

Theo đề cương:

| Vai trò | Trách nhiệm chính |
| --- | --- |
| Sinh viên 1 | Core business platform, integration, infrastructure, deployment và operations |
| Sinh viên 2 | Agentic AI, AI/ML, data preparation và AI evaluation |
| Cả hai | Architecture, contracts, integration, security tests, benchmark, demo và báo cáo |

Điểm handoff cần phối hợp từ tuần 1:

- identity/tenant context;
- business API và event contract;
- order demand export;
- trip snapshot/distance matrix;
- preview/confirmation endpoints;
- audit and correlation;
- Docker Compose và CI.

## 23. Rủi ro và biện pháp

| Rủi ro | Mức | Biện pháp |
| --- | --- | --- |
| Ba Agent bị triển khai thành ba chatbot | Cao | Chỉ Planner dùng LLM; specialized agent dùng engine deterministic |
| Tích hợp business service quá muộn | Cao | Contract-first và vertical slice từ tuần 2/5 |
| Thiếu dữ liệu forecast | Cao | Fixed synthetic dataset tối thiểu 180 ngày, baseline và LOW confidence |
| Route dataset/distance không ổn định | Trung bình | Matrix versioned, checksum và benchmark cố định |
| Agent vượt quyền | Cao | Tool filtering + server-side RBAC + negative tests |
| LLM gọi sai tool/arguments | Cao | Strict schema, policy node, fixed evaluation set |
| Confirmation bị replay/stale | Cao | Context binding, expected version và idempotency |
| Kafka duplicate/out-of-order | Cao | Outbox/inbox, idempotency và aggregate version |
| Benchmark không tái lập | Trung bình | Pin dataset, config, container resource, engine/model version |
| Kubernetes chiếm quá nhiều thời gian | Trung bình | Compose cho dev; chỉ một scale-out workload |
| Dùng quá nhiều framework | Trung bình | LangGraph + Pydantic; không thêm agent framework nếu chưa có use case |
| Agent swap và model swap bị trộn lẫn | Cao | `AgentRegistry` chọn workflow; `ModelGateway` + LiteLLM chọn model/provider |
| Code phụ thuộc trực tiếp LiteLLM | Trung bình | Chỉ infrastructure adapter import LiteLLM; contract test với fake gateway |
| Model fallback khác capability/hành vi | Cao | Model profile khai báo capability; regression trước promote; không fallback lỗi policy/schema |
| LiteLLM Proxy làm tăng vận hành quá sớm | Trung bình | Dùng SDK cho MVP; chỉ bật Proxy khi đạt tiêu chí mục 8.5.4 |

## 24. Các quyết định cần ADR hoặc khóa trong tuần 1

1. LangGraph là orchestration runtime chính của Agent Service.
2. LiteLLM Python SDK là adapter mặc định sau `ModelGateway`; tiêu chí chuyển sang
   LiteLLM Proxy theo mục 8.5.4.
3. Python version, package/workspace manager và lockfile convention.
4. Database access layer: SQLAlchemy async hay repository SQL convention khác.
5. Kafka client và outbox publisher approach.
6. Cơ chế cung cấp completed-demand data cho Forecast Service.
7. Nguồn distance matrix và version/cache policy.
8. LangGraph PostgreSQL checkpointer package/retention policy.
9. Prompt/tool payload retention và redaction policy.
10. Quy tắc MAPE khi actual bằng 0.
11. Timeout/retry/concurrency defaults sau benchmark.
12. Model profile mặc định cho demo, capability matrix và provider fallback policy.
13. RLS có được dùng như defense-in-depth hay không.

## 25. Definition of Done

Phần AI chỉ được xem là hoàn thành khi:

- ba service có health/readiness và chạy được trong môi trường tích hợp;
- Planner chỉ nhìn thấy tool đúng tenant/role;
- sensitive actions có preview, confirmation, revalidation và audit;
- Agent không query/write business database;
- Forecast có model, baseline, metrics, metadata và fallback;
- Route có solver, baseline, feasibility verification và reproducibility metadata;
- PostgreSQL ownership, migrations và idempotency được kiểm thử;
- completion events có outbox/inbox hoặc cơ chế tương đương;
- correlation truy được xuyên HTTP, job, worker và event;
- 30+ Agent scenarios được khóa và Tool Success Rate đạt tối thiểu 90%;
- route 50-stop và forecast 100-series có report đo được;
- negative tenant tests pass;
- model/solver outage không làm core workflow unusable;
- agent/workflow được chọn qua allow-listed registry, độc lập với model profile;
- LiteLLM chỉ xuất hiện sau `ModelGateway`, fake gateway chạy được không cần mạng;
- model swap qua cấu hình hoàn tất trong giới hạn BRD mà không sửa graph/business code;
- Docker Compose, runbook, benchmark config và limitation được bàn giao.

## 26. Tài liệu tham khảo kỹ thuật

- [LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview)
- [LangGraph router pattern](https://docs.langchain.com/oss/python/langchain/multi-agent/router)
- [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- [LangChain human-in-the-loop](https://docs.langchain.com/oss/python/langchain/human-in-the-loop)
- [FastAPI documentation](https://fastapi.tiangolo.com/)
- [Pydantic documentation](https://docs.pydantic.dev/)
- [LiteLLM documentation](https://docs.litellm.ai/)
- [Prophet documentation](https://facebook.github.io/prophet/)
- [Google OR-Tools routing documentation](https://developers.google.com/optimization/routing)
