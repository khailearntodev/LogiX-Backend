# Hướng dẫn thiết kế và triển khai database cho các Python service

## 1. Mục đích

Tài liệu này hướng dẫn từng bước bổ sung PostgreSQL cho ba Python service:

- `agent-service`;
- `forecast-service`;
- `route-optimizer-service`.

Đây là hướng dẫn triển khai, chưa phải bằng chứng rằng database hoặc migration đã
được tạo và chạy. Thiết kế phải tiếp tục tuân theo:

- `docs/architecture/database-design.md`;
- `docs/architecture/data-ownership.md`;
- `docs/architecture/event-architecture.md`;
- `docs/architecture/ai-services-technical-design.md`.

## 2. Kết quả mục tiêu

| Service | Database | Schema | Runtime role | Trạng thái đề xuất |
|---|---|---|---|---|
| Agent | `logix_agent` | `agent` | `agent_app` | Có database |
| Forecast | `logix_forecast` | `forecast` | `forecast_app` | Có database |
| Route Optimizer | `logix_route_optimizer` | `route_optimizer` | `route_optimizer_app` | Tùy chọn |

Mỗi service chỉ kết nối database của chính nó. Không cấp quyền cho Python service
đọc trực tiếp database của Order, Inventory, Fulfillment hoặc Transport.

Các ID thuộc service khác chỉ là logical reference. Ví dụ `trip_id`, `user_id`,
`warehouse_id` và `product_id` không có foreign key vật lý xuyên database.

## 3. Công nghệ đề xuất

- Python 3.12 hoặc phiên bản đã được repository thống nhất;
- FastAPI;
- SQLAlchemy 2 với async API;
- Psycopg 3;
- Alembic;
- Pydantic Settings;
- Pytest và Testcontainers cho integration test;
- Ruff và mypy cho kiểm tra tĩnh.

Trước khi cài package, đội dự án cần thống nhất công cụ quản lý dependency Python.
Các ví dụ trong tài liệu dùng `python -m pip` để không áp đặt `uv`, Poetry hoặc
PDM khi repository chưa có quyết định chính thức.

## 4. Bước 1 - Chốt phạm vi persistence

### 4.1 Agent Service

Agent Service cần database để lưu:

- conversation và message đã được redaction;
- vòng đời agent execution;
- metadata của model call và tool call;
- yêu cầu xác nhận hành động nhạy cảm;
- cấu hình provider không chứa secret;
- outbox event `AgentExecutionCompleted`.

Agent không lưu order, inventory, shipment, trip hoặc kết quả forecast làm nguồn
sự thật. Agent gọi API của owning service dưới identity context đã xác minh.

### 4.2 Forecast Service

Forecast Service cần database để lưu:

- demand projection có thể rebuild;
- forecast run và từng series SKU-kho;
- forecast result;
- metric đánh giá;
- inbox để xử lý event idempotent;
- outbox để phát `ForecastCompleted`.

Forecast không đọc trực tiếp Order DB. Dữ liệu demand đến qua event hoặc contract
API được phê duyệt.

### 4.3 Route Optimizer Service

MVP có thể giữ Route Optimizer stateless. Trong trường hợp đó:

- request đi vào service;
- OR-Tools tạo proposal;
- proposal được trả về Transport Service;
- Transport lưu Route Plan authoritative;
- Redis chỉ cache distance matrix theo `input_hash` với TTL.

Chỉ tạo `logix_route_optimizer` khi cần lưu lịch sử job, tái lập kết quả, benchmark
solver hoặc phát event tin cậy. Không lưu quyền approve hoặc dispatch tại đây.

## 5. Bước 2 - Tạo cấu trúc source

Áp dụng độc lập cho từng Python service:

```text
apps/<service>/
  app/
    api/
    application/
    domain/
    config/
      settings.py
    persistence/
      base.py
      session.py
      models/
      repositories/
    events/
    main.py
  migrations/
    versions/
  tests/
    integration/
  alembic.ini
  pyproject.toml
```

Không tạo một SQLAlchemy `Base` dùng chung cho nhiều service. Shared package chỉ
được chứa primitive kỹ thuật hoặc event contract, không chứa model nghiệp vụ của
nhiều service.

## 6. Bước 3 - Khai báo dependency

Ví dụ phần dependency trong `pyproject.toml`:

```toml
[project]
requires-python = ">=3.12"
dependencies = [
  "fastapi",
  "uvicorn[standard]",
  "sqlalchemy[asyncio]>=2.0",
  "alembic",
  "psycopg[binary,pool]>=3.2",
  "pydantic-settings",
]

[project.optional-dependencies]
dev = [
  "pytest",
  "pytest-asyncio",
  "testcontainers[postgres]",
  "ruff",
  "mypy",
]
```

Tạo virtual environment và cài package bằng công cụ đã được đội dự án chọn. Ví
dụ tối thiểu với Python chuẩn:

```powershell
Set-Location apps/agent-service
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
```

Lặp lại độc lập cho Forecast và Route Optimizer khi service đó được đưa vào phạm
vi persistence.

## 7. Bước 4 - Cấu hình môi trường

Mỗi service có URL riêng và không dùng chung runtime credential:

```dotenv
DATABASE_URL=postgresql+psycopg://agent_app:<password>@localhost:5433/logix_agent
DATABASE_SCHEMA=agent
DB_POOL_SIZE=10
DB_MAX_OVERFLOW=10
DB_POOL_TIMEOUT_SECONDS=10
DB_STATEMENT_TIMEOUT_MS=30000
```

Forecast thay bằng `forecast_app`, `logix_forecast`, `forecast`. Route Optimizer
thay bằng `route_optimizer_app`, `logix_route_optimizer`, `route_optimizer`.

Quy tắc bắt buộc:

1. Không commit password thật.
2. `.env.example` chỉ chứa placeholder.
3. Production lấy secret từ secret manager.
4. Startup phải fail fast nếu thiếu `DATABASE_URL`.
5. Không log toàn bộ connection string.

## 8. Bước 5 - Tạo SQLAlchemy Base và lifecycle columns

Mỗi service tạo metadata với schema riêng:

```python
from sqlalchemy import MetaData
from sqlalchemy.orm import DeclarativeBase

metadata = MetaData(schema="agent")


class Base(DeclarativeBase):
    metadata = metadata
```

Đổi `agent` thành schema tương ứng ở service khác.

Mixin cột nền đề xuất:

```python
import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column


class LifecycleMixin:
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    version: Mapped[int] = mapped_column(
        BigInteger,
        server_default=text("1"),
        nullable=False,
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
```

Mọi business table tenant-owned bổ sung `tenant_id uuid NOT NULL`. Repository
bình thường luôn lọc đồng thời `tenant_id` và `deleted_at IS NULL`.

`updated_at` và `version` phải được cập nhật có chủ đích khi ghi. Không coi
`updated_at` là audit log và không chỉ dựa vào `onupdate` phía ORM.

## 9. Bước 6 - Thiết kế Agent schema

### 9.1 Bảng chính

| Bảng | Mục đích |
|---|---|
| `conversations` | Conversation theo tenant và user |
| `conversation_messages` | Message đã redaction và sequence |
| `agent_executions` | Vòng đời một lần chạy Agent |
| `model_calls` | Metadata lời gọi model, token, latency và fallback |
| `tool_calls` | Metadata lời gọi tool và business target |
| `confirmation_requests` | Trạng thái preview/confirm/reject/expire |
| `llm_provider_configs` | Cấu hình provider không chứa secret |
| `outbox_events` | Phát event đáng tin cậy |

Trước khi tạo migration cần thống nhất tên cuối cùng. Tài liệu AI hiện có một số
tên tương đương như `agent_model_calls`, `agent_tool_calls`, `agent_approvals`;
không tạo đồng thời hai bộ bảng cùng ý nghĩa.

### 9.2 Foreign key nội bộ

```text
conversation_messages.conversation_id
  -> conversations.id

agent_executions.conversation_id
  -> conversations.id

model_calls.agent_execution_id
  -> agent_executions.id

tool_calls.agent_execution_id
  -> agent_executions.id

confirmation_requests.agent_execution_id
  -> agent_executions.id

confirmation_requests.tool_call_id
  -> tool_calls.id
```

`user_id`, `business_entity_id` và các target ID của business service không có
foreign key vật lý.

### 9.3 Index tối thiểu

```sql
CREATE UNIQUE INDEX ux_message_sequence
ON agent.conversation_messages (tenant_id, conversation_id, sequence);

CREATE UNIQUE INDEX ux_agent_execution_idempotency
ON agent.agent_executions (tenant_id, user_id, idempotency_key);

CREATE INDEX ix_agent_execution_status_age
ON agent.agent_executions (tenant_id, status, created_at)
WHERE status IN ('QUEUED', 'RUNNING', 'WAITING_CONFIRMATION')
  AND deleted_at IS NULL;

CREATE UNIQUE INDEX ux_pending_tool_confirmation
ON agent.confirmation_requests (tenant_id, tool_call_id)
WHERE status = 'PENDING' AND deleted_at IS NULL;
```

LangGraph checkpoint tables do adapter chính thức quản lý. Không trộn checkpoint
state với authoritative metadata của `agent_executions`.

## 10. Bước 7 - Thiết kế Forecast schema

### 10.1 Bảng chính

| Bảng | Mục đích |
|---|---|
| `demand_observations` | Projection demand từ event đã hoàn tất |
| `forecast_runs` | Metadata và trạng thái một forecast run |
| `forecast_series` | Một series theo warehouse-product trong run |
| `forecast_results` | Giá trị dự báo theo ngày |
| `forecast_metrics` | MAPE/RMSE và evaluation window |
| `inbox_events` | Deduplicate event đầu vào |
| `outbox_events` | Phát `ForecastCompleted` |

### 10.2 Foreign key nội bộ

```text
forecast_series.forecast_run_id
  -> forecast_runs.id

forecast_results.forecast_series_id
  -> forecast_series.id

forecast_metrics.forecast_series_id
  -> forecast_series.id
```

`warehouse_id`, `product_id` và `source_order_id` là logical reference, không có
foreign key sang Master Data hoặc Order.

### 10.3 Constraint và index tối thiểu

```sql
CHECK (fulfilled_quantity >= 0)
CHECK (horizon_days > 0)
CHECK (predicted_quantity >= 0)
CHECK (lower_bound IS NULL OR lower_bound >= 0)
CHECK (upper_bound IS NULL OR upper_bound >= lower_bound)

CREATE UNIQUE INDEX ux_demand_source_event
ON forecast.demand_observations (source_event_id);

CREATE UNIQUE INDEX ux_forecast_run_series
ON forecast.forecast_series
  (tenant_id, forecast_run_id, warehouse_id, product_id);

CREATE UNIQUE INDEX ux_forecast_result_date
ON forecast.forecast_results
  (tenant_id, forecast_series_id, forecast_date);
```

Quantity và metric cần cân nhắc `numeric`, không mặc định dùng floating point cho
dữ liệu cần tái lập ổn định.

## 11. Bước 8 - Thiết kế Route Optimizer schema nếu cần

Nếu quyết định persistence là cần thiết, tạo:

| Bảng | Mục đích |
|---|---|
| `optimization_runs` | Input hash, solver/version, status và metric |
| `optimization_stops` | Snapshot input/output của từng stop |
| `inbox_events` | Nhận `TripPlanned` idempotent nếu dùng Kafka |
| `outbox_events` | Phát `RouteOptimized` đáng tin cậy |

Foreign key nội bộ duy nhất ở nhóm lõi:

```text
optimization_stops.optimization_run_id
  -> optimization_runs.id
```

`trip_id`, `route_request_id` và `trip_stop_id` không có foreign key sang
Transport DB.

Index tối thiểu:

```sql
CREATE UNIQUE INDEX ux_optimization_request
ON route_optimizer.optimization_runs (tenant_id, route_request_id);

CREATE UNIQUE INDEX ux_optimization_stop
ON route_optimizer.optimization_stops
  (tenant_id, optimization_run_id, trip_stop_id);

CREATE UNIQUE INDEX ux_optimization_sequence
ON route_optimizer.optimization_stops
  (tenant_id, optimization_run_id, optimized_sequence)
WHERE optimized_sequence IS NOT NULL AND deleted_at IS NULL;
```

## 12. Bước 9 - Thêm inbox và outbox

### 12.1 Inbox transaction

Khi Forecast hoặc Route Optimizer nhận event:

```text
BEGIN
  INSERT inbox_events
  INSERT hoặc UPSERT projection/business metadata
COMMIT
```

`inbox_events` cần unique `(consumer_name, event_id)`. Duplicate event phải bị
nhận diện trước khi tạo business effect lần thứ hai.

### 12.2 Outbox transaction

Khi Agent, Forecast hoặc Route Optimizer hoàn thành công việc:

```text
BEGIN
  UPDATE execution/run
  INSERT result liên quan
  INSERT outbox_events
COMMIT
```

Publisher đọc các row chưa publish bằng `FOR UPDATE SKIP LOCKED`, publish Kafka,
sau đó cập nhật `published_at`, `attempt_count` và retry metadata.

Không thực hiện chuỗi thiếu transaction như sau:

```text
COMMIT kết quả
publish Kafka
```

Nếu process crash giữa hai thao tác, event sẽ bị mất.

## 13. Bước 10 - Khởi tạo Alembic

Chạy trong từng service sau khi dependency đã được cài:

```powershell
Set-Location apps/agent-service
.\.venv\Scripts\alembic.exe init migrations
```

Trong `migrations/env.py`:

1. Import đầy đủ model để `Base.metadata` chứa tất cả bảng.
2. Đọc URL từ environment/settings.
3. Bật `include_schemas=True`.
4. Đặt Alembic version table trong schema của service.
5. Bật so sánh type và server default.
6. Lọc để Alembic không quản lý object ngoài schema của service.

Khung cấu hình:

```python
context.configure(
    connection=connection,
    target_metadata=Base.metadata,
    include_schemas=True,
    version_table_schema=settings.database_schema,
    compare_type=True,
    compare_server_default=True,
)
```

Không dùng cùng một `alembic_version` table ở schema `public` cho nhiều service.

## 14. Bước 11 - Tạo và review migration đầu tiên

```powershell
.\.venv\Scripts\alembic.exe revision --autogenerate -m "init agent schema"
```

Không chạy `upgrade` ngay. Mở file migration và kiểm tra:

- đúng schema;
- tất cả bảng có primary key;
- lifecycle columns có đúng nullability/default;
- foreign key chỉ trỏ bảng nội bộ;
- unique constraint chứa tenant khi cần;
- partial index có predicate chính xác;
- không có `DROP TABLE` hoặc `DROP COLUMN` ngoài dự kiến;
- enum/check constraint có thể migrate an toàn;
- downgrade không phá object ngoài service.

Sau khi review:

```powershell
.\.venv\Scripts\alembic.exe upgrade head
.\.venv\Scripts\alembic.exe current
.\.venv\Scripts\alembic.exe check
```

Không chỉnh file migration đã apply. Mọi thay đổi sau đó dùng revision mới.

## 15. Bước 12 - Tạo async engine và session

```python
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

engine = create_async_engine(
    settings.database_url,
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
    pool_pre_ping=True,
)

SessionFactory = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)
```

Một application use case sở hữu transaction boundary. Repository không tự
`commit()` sau từng câu lệnh vì sẽ phá transaction giữa business state và
inbox/outbox.

## 16. Bước 13 - Tenant scope và soft delete

Mọi repository method đọc business row phải nhận tenant context:

```python
statement = select(AgentExecution).where(
    AgentExecution.tenant_id == tenant_id,
    AgentExecution.id == execution_id,
    AgentExecution.deleted_at.is_(None),
)
```

Không cung cấp method kiểu `get_by_id(id)` cho business row tenant-owned. API
khôi phục hoặc quản trị row đã xóa phải là đường đi riêng có authorization.

Soft delete phải:

1. đặt `deleted_at`;
2. cập nhật `updated_at`;
3. tăng `version`;
4. tạo audit/event phù hợp nếu nghiệp vụ yêu cầu.

## 17. Bước 14 - Kiểm thử bắt buộc

### 17.1 Migration test

- Tạo PostgreSQL rỗng.
- Chạy toàn bộ Alembic history đến `head`.
- Chạy `alembic check`.
- Xác nhận không có migration pending.

### 17.2 Catalog test

Kiểm tra trực tiếp PostgreSQL:

- mọi bảng có primary key;
- lifecycle columns đầy đủ;
- foreign key không vượt schema/service;
- index và unique constraint đúng thiết kế;
- role không có `CONNECT` sang database khác.

### 17.3 Repository integration test

Cần ít nhất các negative test:

- tenant A không đọc được row tenant B;
- soft-deleted row không xuất hiện trong query thường;
- duplicate inbox event không tạo effect lần hai;
- duplicate idempotency key không tạo execution/run lần hai;
- invalid internal FK bị PostgreSQL từ chối;
- business update và outbox insert rollback cùng nhau khi có lỗi.

### 17.4 Runtime test

- Service fail fast khi URL sai hoặc database không sẵn sàng.
- Health check phân biệt liveness và readiness.
- Connection được đóng khi shutdown.
- Pool timeout và statement timeout hoạt động như cấu hình.
- Error log không lộ password, prompt raw hoặc payload nhạy cảm.

## 18. Bước 15 - Thứ tự triển khai đề xuất

### Giai đoạn A - Agent

1. Chốt tên bảng Agent còn đang khác nhau giữa hai tài liệu thiết kế.
2. Tạo `logix_agent`, schema và role.
3. Scaffold persistence/config/Alembic.
4. Tạo model và migration.
5. Chạy migration, catalog test và repository test.
6. Tích hợp LangGraph checkpointer tách biệt.
7. Thêm outbox và publisher.

### Giai đoạn B - Forecast

1. Chốt event nguồn tạo `demand_observations`.
2. Tạo `logix_forecast`, schema và role.
3. Tạo model, inbox/outbox và migration.
4. Kiểm thử idempotent projection.
5. Kiểm thử run/result/metric transaction.
6. Phát và kiểm thử `ForecastCompleted`.

### Giai đoạn C - Route Optimizer

1. Quyết định stateless hay persistent.
2. Nếu stateless, không tạo PostgreSQL chỉ để đồng nhất hình thức.
3. Nếu persistent, tạo database/schema/role riêng.
4. Tạo run/stop/inbox/outbox và migration.
5. Chứng minh Transport vẫn là authority của approve/dispatch.

## 19. Checklist hoàn tất cho từng service

- [ ] Phạm vi dữ liệu và ownership đã được chốt.
- [ ] Database, schema và role riêng đã được tạo.
- [ ] Role không kết nối được database service khác.
- [ ] Settings không log hoặc commit secret.
- [ ] SQLAlchemy model có PK, tenant scope và lifecycle columns.
- [ ] Foreign key chỉ liên kết bảng nội bộ.
- [ ] Unique constraint và index khớp access pattern.
- [ ] Alembic migration đã được review bằng tay.
- [ ] Migration chạy được từ database rỗng đến `head`.
- [ ] `alembic current` và `alembic check` sạch.
- [ ] Repository luôn lọc tenant và soft delete.
- [ ] Inbox/outbox nằm cùng transaction với effect tương ứng.
- [ ] Integration test positive và negative đều pass.
- [ ] Build, lint, type check và test của service đều pass.
- [ ] Runtime readiness và shutdown đã được kiểm chứng.

## 20. Những việc không được làm

- Không cho Agent đọc trực tiếp Order hoặc Inventory DB.
- Không cho Forecast query trực tiếp Order DB để lấy training data.
- Không đặt foreign key xuyên database.
- Không dùng Redis làm nguồn sự thật cho forecast hoặc execution history.
- Không lưu API key/model credential trong bảng provider config.
- Không lưu raw prompt/payload nhạy cảm mặc định vào log hoặc audit.
- Không để Route Optimizer sở hữu route approval hoặc dispatch state.
- Không sửa migration đã apply.
- Không reset database có dữ liệu để xử lý schema drift.
- Không coi unit test SQLite là bằng chứng tương thích PostgreSQL.

## 21. Mẫu thực hành chi tiết: Agent Service

Phần này là walkthrough cụ thể cho `apps/agent-service`. Mỗi bước ghi rõ file
cần tạo, nội dung đặt trong file và lệnh kiểm tra. Code là baseline triển khai;
trước khi đưa vào production vẫn phải bổ sung authentication, authorization,
redaction, logging và observability theo kiến trúc Agent.

Trong mẫu này, bộ tên bảng được chọn thống nhất là:

- `conversations`;
- `conversation_messages`;
- `agent_executions`;
- `model_calls`;
- `tool_calls`;
- `confirmation_requests`;
- `llm_provider_configs`;
- `outbox_events`.

### 21.1 Bước A1 - Tạo cây thư mục

Từ thư mục `LogiX-Backend`, tạo cây sau. Các file `__init__.py` để trống:

```text
apps/agent-service/
  app/
  __init__.py
  application/
    __init__.py
    execution_service.py
  config/
    __init__.py
    settings.py
  persistence/
    __init__.py
    base.py
    models.py
    session.py
    repositories/
    __init__.py
    agent_execution_repository.py
  main.py
  migrations/
  versions/
  env.py
  script.py.mako
  tests/
    conftest.py
  integration/
    test_agent_execution_repository.py
  .env.example
  alembic.ini
  pyproject.toml
```

PowerShell:

```powershell
Set-Location apps/agent-service
$directories = @(
  "app/application",
  "app/config",
  "app/persistence/repositories",
  "migrations/versions",
  "tests/integration"
)
$directories | ForEach-Object { New-Item -ItemType Directory -Force $_ }
```

### 21.2 Bước A2 - Tạo `pyproject.toml`

Đặt nội dung sau vào `apps/agent-service/pyproject.toml`:

```toml
[build-system]
requires = ["setuptools>=75"]
build-backend = "setuptools.build_meta"

[project]
name = "logix-agent-service"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "alembic>=1.16,<2",
  "fastapi>=0.115,<1",
  "psycopg[binary,pool]>=3.2,<4",
  "pydantic-settings>=2.10,<3",
  "sqlalchemy[asyncio]>=2.0,<3",
  "uvicorn[standard]>=0.35,<1",
]

[project.optional-dependencies]
dev = [
  "httpx>=0.28,<1",
  "mypy>=1.17,<2",
  "pytest>=8.4,<9",
  "pytest-asyncio>=1.1,<2",
  "ruff>=0.12,<1",
  "testcontainers[postgres]>=4.12,<5",
]

[tool.setuptools.packages.find]
include = ["app*"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]

[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B"]

[tool.mypy]
python_version = "3.12"
strict = true
plugins = ["pydantic.mypy"]
```

Sau đó tạo môi trường và cài package:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
```

### 21.3 Bước A3 - Tạo `.env.example`

Đặt nội dung sau vào `apps/agent-service/.env.example`:

```dotenv
DATABASE_URL=postgresql+psycopg://agent_app:<password>@localhost:5433/logix_agent
DATABASE_SCHEMA=agent
DB_POOL_SIZE=10
DB_MAX_OVERFLOW=10
DB_POOL_TIMEOUT_SECONDS=10
DB_STATEMENT_TIMEOUT_MS=30000
```

Tạo `.env` cục bộ từ mẫu và thay `<password>` bằng secret local. Không commit
`.env`. Kiểm tra `.gitignore` trước khi nhập credential thật.

### 21.4 Bước A4 - Tạo settings

Đặt nội dung sau vào `apps/agent-service/app/config/settings.py`:

```python
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
  model_config = SettingsConfigDict(
    env_file=".env",
    env_file_encoding="utf-8",
    extra="ignore",
  )

  database_url: str = Field(alias="DATABASE_URL")
  database_schema: str = Field(default="agent", alias="DATABASE_SCHEMA")
  db_pool_size: int = Field(default=10, ge=1, alias="DB_POOL_SIZE")
  db_max_overflow: int = Field(default=10, ge=0, alias="DB_MAX_OVERFLOW")
  db_pool_timeout_seconds: int = Field(
    default=10,
    ge=1,
    alias="DB_POOL_TIMEOUT_SECONDS",
  )
  db_statement_timeout_ms: int = Field(
    default=30_000,
    ge=1,
    alias="DB_STATEMENT_TIMEOUT_MS",
  )


@lru_cache
def get_settings() -> Settings:
  return Settings()
```

`DATABASE_URL` không có default để service fail fast khi cấu hình bị thiếu.

### 21.5 Bước A5 - Tạo Base và mixin

Đặt nội dung sau vào `apps/agent-service/app/persistence/base.py`:

```python
import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, MetaData, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

NAMING_CONVENTION = {
  "ix": "ix_%(table_name)s_%(column_0_name)s",
  "uq": "uq_%(table_name)s_%(column_0_name)s",
  "ck": "ck_%(table_name)s_%(constraint_name)s",
  "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
  "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
  metadata = MetaData(schema="agent", naming_convention=NAMING_CONVENTION)


class LifecycleMixin:
  id: Mapped[uuid.UUID] = mapped_column(
    UUID(as_uuid=True),
    primary_key=True,
    default=uuid.uuid4,
  )
  created_at: Mapped[datetime] = mapped_column(
    DateTime(timezone=True),
    nullable=False,
    server_default=func.now(),
  )
  updated_at: Mapped[datetime] = mapped_column(
    DateTime(timezone=True),
    nullable=False,
    server_default=func.now(),
  )
  version: Mapped[int] = mapped_column(
    BigInteger,
    nullable=False,
    server_default=text("1"),
  )
  deleted_at: Mapped[datetime | None] = mapped_column(
    DateTime(timezone=True),
    nullable=True,
  )
```

### 21.6 Bước A6 - Tạo toàn bộ model Agent

Đặt nội dung sau vào `apps/agent-service/app/persistence/models.py`:

```python
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
  BigInteger,
  Boolean,
  CheckConstraint,
  DateTime,
  ForeignKey,
  Index,
  Integer,
  String,
  Text,
  UniqueConstraint,
  func,
  text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.persistence.base import Base, LifecycleMixin


class TenantMixin:
  tenant_id: Mapped[uuid.UUID] = mapped_column(
    UUID(as_uuid=True),
    nullable=False,
  )


class Conversation(TenantMixin, LifecycleMixin, Base):
  __tablename__ = "conversations"
  __table_args__ = (
    CheckConstraint(
      "status IN ('ACTIVE', 'ARCHIVED', 'EXPIRED')",
      name="conversation_status",
    ),
    Index(
      "ix_conversations_user_recent",
      "tenant_id",
      "user_id",
      text("last_message_at DESC"),
      postgresql_where=text("status = 'ACTIVE' AND deleted_at IS NULL"),
    ),
  )

  user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
  title: Mapped[str | None] = mapped_column(String(200))
  status: Mapped[str] = mapped_column(String(30), nullable=False, default="ACTIVE")
  context_summary: Mapped[str | None] = mapped_column(Text)
  last_message_at: Mapped[datetime] = mapped_column(
    DateTime(timezone=True),
    nullable=False,
    server_default=func.now(),
  )
  expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

  messages: Mapped[list["ConversationMessage"]] = relationship(
    back_populates="conversation",
    cascade="all, delete-orphan",
  )
  executions: Mapped[list["AgentExecution"]] = relationship(
    back_populates="conversation",
  )


class ConversationMessage(TenantMixin, LifecycleMixin, Base):
  __tablename__ = "conversation_messages"
  __table_args__ = (
    UniqueConstraint(
      "tenant_id",
      "conversation_id",
      "sequence",
      name="ux_message_sequence",
    ),
    Index(
      "ix_message_timeline",
      "tenant_id",
      "conversation_id",
      "created_at",
      "id",
    ),
    CheckConstraint(
      "role IN ('USER', 'ASSISTANT', 'SYSTEM', 'TOOL')",
      name="message_role",
    ),
  )

  conversation_id: Mapped[uuid.UUID] = mapped_column(
    UUID(as_uuid=True),
    ForeignKey("agent.conversations.id", ondelete="CASCADE"),
    nullable=False,
  )
  role: Mapped[str] = mapped_column(String(20), nullable=False)
  content: Mapped[str | None] = mapped_column(Text)
  content_redacted: Mapped[str] = mapped_column(Text, nullable=False)
  model_message_id: Mapped[str | None] = mapped_column(String(255))
  sequence: Mapped[int] = mapped_column(Integer, nullable=False)

  conversation: Mapped[Conversation] = relationship(back_populates="messages")


class AgentExecution(TenantMixin, LifecycleMixin, Base):
  __tablename__ = "agent_executions"
  __table_args__ = (
    UniqueConstraint(
      "tenant_id",
      "user_id",
      "idempotency_key",
      name="ux_agent_execution_idempotency",
    ),
    CheckConstraint(
      "status IN ('QUEUED', 'RUNNING', 'WAITING_CONFIRMATION', "
      "'SUCCEEDED', 'FAILED', 'CANCELED', 'TIMED_OUT')",
      name="agent_execution_status",
    ),
    Index(
      "ix_agent_execution_user_recent",
      "tenant_id",
      "user_id",
      text("created_at DESC"),
    ),
    Index(
      "ix_agent_execution_status_age",
      "tenant_id",
      "status",
      "created_at",
      postgresql_where=text(
        "status IN ('QUEUED', 'RUNNING', 'WAITING_CONFIRMATION') "
        "AND deleted_at IS NULL"
      ),
    ),
    Index(
      "ix_agent_execution_correlation",
      "tenant_id",
      "correlation_id",
    ),
  )

  user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
  conversation_id: Mapped[uuid.UUID | None] = mapped_column(
    UUID(as_uuid=True),
    ForeignKey("agent.conversations.id", ondelete="SET NULL"),
  )
  status: Mapped[str] = mapped_column(String(30), nullable=False, default="QUEUED")
  intent: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
  provider: Mapped[str | None] = mapped_column(String(100))
  model: Mapped[str | None] = mapped_column(String(150))
  model_version: Mapped[str | None] = mapped_column(String(100))
  input_summary: Mapped[str | None] = mapped_column(Text)
  output_summary: Mapped[str | None] = mapped_column(Text)
  correlation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
  idempotency_key: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
  started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  latency_ms: Mapped[int | None] = mapped_column(Integer)
  error_code: Mapped[str | None] = mapped_column(String(100))
  error_message_sanitized: Mapped[str | None] = mapped_column(Text)

  conversation: Mapped[Conversation | None] = relationship(back_populates="executions")
  model_calls: Mapped[list["ModelCall"]] = relationship(
    back_populates="execution",
    cascade="all, delete-orphan",
  )
  tool_calls: Mapped[list["ToolCall"]] = relationship(
    back_populates="execution",
    cascade="all, delete-orphan",
  )
  confirmations: Mapped[list["ConfirmationRequest"]] = relationship(
    back_populates="execution",
    cascade="all, delete-orphan",
  )


class ModelCall(TenantMixin, LifecycleMixin, Base):
  __tablename__ = "model_calls"
  __table_args__ = (
    Index(
      "ix_model_call_metrics",
      "tenant_id",
      "provider",
      "model",
      text("finished_at DESC"),
    ),
  )

  agent_execution_id: Mapped[uuid.UUID] = mapped_column(
    UUID(as_uuid=True),
    ForeignKey("agent.agent_executions.id", ondelete="CASCADE"),
    nullable=False,
  )
  model_profile: Mapped[str] = mapped_column(String(100), nullable=False)
  gateway_backend: Mapped[str] = mapped_column(String(50), nullable=False)
  provider: Mapped[str] = mapped_column(String(100), nullable=False)
  model: Mapped[str] = mapped_column(String(150), nullable=False)
  provider_request_id: Mapped[str | None] = mapped_column(String(255))
  attempt: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
  fallback_from_call_id: Mapped[uuid.UUID | None] = mapped_column(
    UUID(as_uuid=True),
    ForeignKey("agent.model_calls.id", ondelete="SET NULL"),
  )
  input_tokens: Mapped[int | None] = mapped_column(Integer)
  output_tokens: Mapped[int | None] = mapped_column(Integer)
  cost_micros: Mapped[int | None] = mapped_column(BigInteger)
  status: Mapped[str] = mapped_column(String(30), nullable=False)
  started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
  finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  latency_ms: Mapped[int | None] = mapped_column(Integer)
  error_code: Mapped[str | None] = mapped_column(String(100))

  execution: Mapped[AgentExecution] = relationship(back_populates="model_calls")


class ToolCall(TenantMixin, LifecycleMixin, Base):
  __tablename__ = "tool_calls"
  __table_args__ = (
    UniqueConstraint(
      "tenant_id",
      "agent_execution_id",
      "sequence",
      name="ux_tool_call_sequence",
    ),
    Index(
      "ix_tool_call_metrics",
      "tenant_id",
      "tool_name",
      "status",
      text("finished_at DESC"),
    ),
    Index(
      "ix_tool_call_business_entity",
      "tenant_id",
      "business_entity_type",
      "business_entity_id",
    ),
  )

  agent_execution_id: Mapped[uuid.UUID] = mapped_column(
    UUID(as_uuid=True),
    ForeignKey("agent.agent_executions.id", ondelete="CASCADE"),
    nullable=False,
  )
  sequence: Mapped[int] = mapped_column(Integer, nullable=False)
  tool_name: Mapped[str] = mapped_column(String(100), nullable=False)
  tool_version: Mapped[str] = mapped_column(String(50), nullable=False)
  required_permission: Mapped[str | None] = mapped_column(String(150))
  input_sanitized: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
  output_sanitized: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
  status: Mapped[str] = mapped_column(String(30), nullable=False)
  attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
  started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  latency_ms: Mapped[int | None] = mapped_column(Integer)
  business_entity_type: Mapped[str | None] = mapped_column(String(100))
  business_entity_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
  error_code: Mapped[str | None] = mapped_column(String(100))

  execution: Mapped[AgentExecution] = relationship(back_populates="tool_calls")
  confirmations: Mapped[list["ConfirmationRequest"]] = relationship(
    back_populates="tool_call",
  )


class ConfirmationRequest(TenantMixin, LifecycleMixin, Base):
  __tablename__ = "confirmation_requests"
  __table_args__ = (
    CheckConstraint(
      "status IN ('PENDING', 'CONFIRMED', 'REJECTED', 'EXPIRED', 'CONSUMED')",
      name="confirmation_status",
    ),
    Index(
      "ux_pending_tool_confirmation",
      "tenant_id",
      "tool_call_id",
      unique=True,
      postgresql_where=text("status = 'PENDING' AND deleted_at IS NULL"),
    ),
    Index(
      "ix_confirmation_user_pending",
      "tenant_id",
      "user_id",
      "expires_at",
      postgresql_where=text("status = 'PENDING' AND deleted_at IS NULL"),
    ),
    Index(
      "ux_confirmation_context_consumed",
      "tenant_id",
      "user_id",
      "context_hash",
      unique=True,
      postgresql_where=text("status = 'CONSUMED' AND deleted_at IS NULL"),
    ),
  )

  user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
  agent_execution_id: Mapped[uuid.UUID] = mapped_column(
    UUID(as_uuid=True),
    ForeignKey("agent.agent_executions.id", ondelete="CASCADE"),
    nullable=False,
  )
  tool_call_id: Mapped[uuid.UUID] = mapped_column(
    UUID(as_uuid=True),
    ForeignKey("agent.tool_calls.id", ondelete="CASCADE"),
    nullable=False,
  )
  action_type: Mapped[str] = mapped_column(String(100), nullable=False)
  preview_payload_sanitized: Mapped[dict[str, Any]] = mapped_column(
    JSONB,
    nullable=False,
  )
  context_hash: Mapped[str] = mapped_column(String(64), nullable=False)
  status: Mapped[str] = mapped_column(String(30), nullable=False, default="PENDING")
  expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
  confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

  execution: Mapped[AgentExecution] = relationship(back_populates="confirmations")
  tool_call: Mapped[ToolCall] = relationship(back_populates="confirmations")


class LlmProviderConfig(LifecycleMixin, Base):
  __tablename__ = "llm_provider_configs"
  __table_args__ = (
    Index(
      "ux_active_tenant_provider_config",
      "tenant_id",
      "provider",
      unique=True,
      postgresql_where=text(
        "tenant_id IS NOT NULL AND is_active = true AND deleted_at IS NULL"
      ),
    ),
    Index(
      "ux_active_platform_provider_config",
      "provider",
      unique=True,
      postgresql_where=text(
        "tenant_id IS NULL AND is_active = true AND deleted_at IS NULL"
      ),
    ),
  )

  tenant_id: Mapped[uuid.UUID | None] = mapped_column(
    UUID(as_uuid=True),
    nullable=True,
  )
  provider: Mapped[str] = mapped_column(String(100), nullable=False)
  model: Mapped[str] = mapped_column(String(150), nullable=False)
  endpoint_alias: Mapped[str | None] = mapped_column(String(100))
  credential_ref: Mapped[str] = mapped_column(String(255), nullable=False)
  parameters: Mapped[dict[str, Any]] = mapped_column(
    JSONB,
    nullable=False,
    default=dict,
  )
  is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class OutboxEvent(TenantMixin, LifecycleMixin, Base):
  __tablename__ = "outbox_events"
  __table_args__ = (
    Index(
      "ix_outbox_pending",
      "next_attempt_at",
      "occurred_at",
      postgresql_where=text("published_at IS NULL AND deleted_at IS NULL"),
    ),
    Index(
      "ix_outbox_aggregate",
      "tenant_id",
      "aggregate_type",
      "aggregate_id",
      "aggregate_version",
    ),
  )

  event_type: Mapped[str] = mapped_column(String(100), nullable=False)
  event_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
  aggregate_type: Mapped[str] = mapped_column(String(100), nullable=False)
  aggregate_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
  aggregate_version: Mapped[int] = mapped_column(BigInteger, nullable=False)
  correlation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
  causation_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
  payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
  occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
  published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
  attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
  next_attempt_at: Mapped[datetime] = mapped_column(
    DateTime(timezone=True),
    nullable=False,
    server_default=func.now(),
  )
  last_error: Mapped[str | None] = mapped_column(Text)
```

Không đặt `ForeignKey` cho `user_id`, `business_entity_id` hoặc
`aggregate_id`. Các cột này có thể trỏ tới authority bên ngoài Agent database.

### 21.7 Bước A7 - Tạo engine và session factory

Đặt nội dung sau vào `apps/agent-service/app/persistence/session.py`:

```python
from collections.abc import AsyncIterator

from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
  AsyncSession,
  async_sessionmaker,
  create_async_engine,
)

from app.config.settings import get_settings

settings = get_settings()

engine = create_async_engine(
  settings.database_url,
  pool_size=settings.db_pool_size,
  max_overflow=settings.db_max_overflow,
  pool_timeout=settings.db_pool_timeout_seconds,
  pool_pre_ping=True,
)


@event.listens_for(engine.sync_engine, "connect")
def set_statement_timeout(dbapi_connection: object, _: object) -> None:
  cursor = dbapi_connection.cursor()  # type: ignore[attr-defined]
  try:
    cursor.execute(
      "SELECT set_config('statement_timeout', %s, false)",
      (str(settings.db_statement_timeout_ms),),
    )
  finally:
    cursor.close()


SessionFactory = async_sessionmaker(
  engine,
  class_=AsyncSession,
  expire_on_commit=False,
)


async def get_session() -> AsyncIterator[AsyncSession]:
  async with SessionFactory() as session:
    yield session
```

Không gọi `commit()` trong `get_session()`. Application service phải sở hữu
transaction boundary rõ ràng.

### 21.8 Bước A8 - Cấu hình Alembic

Đặt nội dung sau vào `apps/agent-service/alembic.ini`:

```ini
[alembic]
script_location = migrations
prepend_sys_path = .
version_path_separator = os

[loggers]
keys = root,sqlalchemy,alembic

[handlers]
keys = console

[formatters]
keys = generic

[logger_root]
level = WARN
handlers = console
qualname =

[logger_sqlalchemy]
level = WARN
handlers =
qualname = sqlalchemy.engine

[logger_alembic]
level = INFO
handlers =
qualname = alembic

[handler_console]
class = StreamHandler
args = (sys.stderr,)
level = NOTSET
formatter = generic

[formatter_generic]
format = %(levelname)-5.5s [%(name)s] %(message)s
datefmt = %H:%M:%S
```

Không ghi URL có password trong `alembic.ini`.

Đặt nội dung sau vào `apps/agent-service/migrations/env.py`:

```python
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.config.settings import get_settings
from app.persistence.base import Base
from app.persistence import models  # noqa: F401

config = context.config
if config.config_file_name is not None:
  fileConfig(config.config_file_name)

settings = get_settings()
config.set_main_option("sqlalchemy.url", settings.database_url)
target_metadata = Base.metadata


def include_name(name: str | None, type_: str, _: dict[str, object]) -> bool:
  if type_ == "schema":
    return name in {None, settings.database_schema}
  return True


def run_migrations_offline() -> None:
  context.configure(
    url=settings.database_url,
    target_metadata=target_metadata,
    literal_binds=True,
    dialect_opts={"paramstyle": "named"},
    include_schemas=True,
    include_name=include_name,
    version_table_schema=settings.database_schema,
    compare_type=True,
    compare_server_default=True,
  )
  with context.begin_transaction():
    context.run_migrations()


def run_migrations_online() -> None:
  configuration = config.get_section(config.config_ini_section) or {}
  connectable = engine_from_config(
    configuration,
    prefix="sqlalchemy.",
    poolclass=pool.NullPool,
  )
  with connectable.connect() as connection:
    context.configure(
      connection=connection,
      target_metadata=target_metadata,
      include_schemas=True,
      include_name=include_name,
      version_table_schema=settings.database_schema,
      compare_type=True,
      compare_server_default=True,
    )
    with context.begin_transaction():
      context.run_migrations()


if context.is_offline_mode():
  run_migrations_offline()
else:
  run_migrations_online()
```

Đặt nội dung sau vào `apps/agent-service/migrations/script.py.mako`:

```mako
"""${message}

Revision ID: ${up_revision}
Revises: ${down_revision | comma,n}
Create Date: ${create_date}
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
${imports if imports else ""}

revision: str = ${repr(up_revision)}
down_revision: str | None = ${repr(down_revision)}
branch_labels: str | Sequence[str] | None = ${repr(branch_labels)}
depends_on: str | Sequence[str] | None = ${repr(depends_on)}


def upgrade() -> None:
  ${upgrades if upgrades else "pass"}


def downgrade() -> None:
  ${downgrades if downgrades else "pass"}
```

### 21.9 Bước A9 - Tạo database, schema và role

Chạy bằng PostgreSQL administrator. Truyền password qua biến `psql` hoặc secret,
không ghi password thật vào history/script được commit:

```sql
CREATE ROLE agent_app LOGIN PASSWORD '<local-secret>';
CREATE DATABASE logix_agent OWNER agent_app;
REVOKE CONNECT ON DATABASE logix_agent FROM PUBLIC;
GRANT CONNECT ON DATABASE logix_agent TO agent_app;
```

Sau đó kết nối `logix_agent` và chạy:

```sql
CREATE SCHEMA agent AUTHORIZATION agent_app;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA agent TO agent_app;
ALTER ROLE agent_app IN DATABASE logix_agent
  SET search_path = agent, public;
```

Nếu role hoặc database đã tồn tại, không chạy lại nguyên khối. Kiểm tra catalog
và dùng migration vận hành phù hợp thay vì drop/reset.

### 21.10 Bước A10 - Sinh migration đầu tiên

Từ `apps/agent-service`:

```powershell
.\.venv\Scripts\alembic.exe revision --autogenerate -m "init agent schema"
```

File mới sẽ nằm trong `migrations/versions/`. Mở file đó và kiểm tra đủ tám bảng,
PK, FK nội bộ, check constraint, unique và partial index. Đặc biệt, file không
được có thao tác với schema ngoài `agent`.

Nếu Alembic không tự tạo schema, thêm dòng sau ở đầu `upgrade()`:

```python
op.execute("CREATE SCHEMA IF NOT EXISTS agent")
```

Vì schema production nên được provision trước và thuộc `agent_app`, ưu tiên để
infrastructure tạo schema; dòng `IF NOT EXISTS` chỉ là phương án local đã được
review ownership.

Áp dụng migration:

```powershell
.\.venv\Scripts\alembic.exe upgrade head
.\.venv\Scripts\alembic.exe current
.\.venv\Scripts\alembic.exe check
```

### 21.11 Bước A11 - Tạo repository tenant-scoped

Đặt nội dung sau vào
`apps/agent-service/app/persistence/repositories/agent_execution_repository.py`:

```python
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.persistence.models import AgentExecution


class AgentExecutionRepository:
  def __init__(self, session: AsyncSession) -> None:
    self._session = session

  async def add(self, execution: AgentExecution) -> None:
    self._session.add(execution)
    await self._session.flush()

  async def get_active(
    self,
    *,
    tenant_id: uuid.UUID,
    execution_id: uuid.UUID,
  ) -> AgentExecution | None:
    statement = select(AgentExecution).where(
      AgentExecution.tenant_id == tenant_id,
      AgentExecution.id == execution_id,
      AgentExecution.deleted_at.is_(None),
    )
    return await self._session.scalar(statement)
```

Không thêm `get_by_id(execution_id)` bỏ qua tenant. Đường quản trị đọc dữ liệu đã
xóa phải dùng repository/method riêng và kiểm tra authorization.

### 21.12 Bước A12 - Ghi execution và outbox cùng transaction

Đặt nội dung sau vào
`apps/agent-service/app/application/execution_service.py`:

```python
import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.persistence.models import AgentExecution, OutboxEvent
from app.persistence.repositories.agent_execution_repository import (
  AgentExecutionRepository,
)


class ExecutionService:
  def __init__(self, session: AsyncSession) -> None:
    self._session = session
    self._repository = AgentExecutionRepository(session)

  async def create_execution(
    self,
    *,
    tenant_id: uuid.UUID,
    user_id: uuid.UUID,
    conversation_id: uuid.UUID | None,
    correlation_id: uuid.UUID,
    idempotency_key: uuid.UUID,
    input_summary: str,
  ) -> AgentExecution:
    execution = AgentExecution(
      tenant_id=tenant_id,
      user_id=user_id,
      conversation_id=conversation_id,
      status="QUEUED",
      correlation_id=correlation_id,
      idempotency_key=idempotency_key,
      input_summary=input_summary,
    )
    async with self._session.begin():
      await self._repository.add(execution)
    return execution

  async def complete_execution(
    self,
    *,
    tenant_id: uuid.UUID,
    execution_id: uuid.UUID,
    output_summary: str,
  ) -> AgentExecution:
    async with self._session.begin():
      execution = await self._repository.get_active(
        tenant_id=tenant_id,
        execution_id=execution_id,
      )
      if execution is None:
        raise LookupError("Agent execution not found")
      if execution.status not in {"RUNNING", "WAITING_CONFIRMATION"}:
        raise ValueError("Agent execution cannot be completed")

      now = datetime.now(UTC)
      execution.status = "SUCCEEDED"
      execution.output_summary = output_summary
      execution.finished_at = now
      execution.updated_at = now
      execution.version += 1

      self._session.add(
        OutboxEvent(
          tenant_id=tenant_id,
          event_type="AgentExecutionCompleted",
          event_version=1,
          aggregate_type="AgentExecution",
          aggregate_id=execution.id,
          aggregate_version=execution.version,
          correlation_id=execution.correlation_id,
          payload={
            "agent_execution_id": str(execution.id),
            "status": execution.status,
          },
          occurred_at=now,
        )
      )
    return execution
```

Nếu outbox insert lỗi, update execution cũng rollback. Đây là invariant cần được
chứng minh bằng integration test, không chỉ bằng code review.

### 21.13 Bước A13 - Tạo FastAPI lifecycle tối thiểu

Đặt nội dung sau vào `apps/agent-service/app/main.py`:

```python
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from sqlalchemy import text

from app.persistence.session import SessionFactory, engine


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
  async with SessionFactory() as session:
    await session.execute(text("SELECT 1"))
  yield
  await engine.dispose()


app = FastAPI(title="LogiX Agent Service", lifespan=lifespan)


@app.get("/health/live")
async def liveness() -> dict[str, str]:
  return {"status": "ok"}


@app.get("/health/ready")
async def readiness() -> dict[str, str]:
  async with SessionFactory() as session:
    await session.execute(text("SELECT 1"))
  return {"status": "ready"}
```

Liveness không phụ thuộc database. Readiness kiểm tra database vì instance không
sẵn sàng nhận traffic nếu persistence bắt buộc đang lỗi.

Chạy local:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8010
```

### 21.14 Bước A14 - Viết integration test đầu tiên

Integration test phải chạy trên PostgreSQL thật và dùng `TEST_DATABASE_URL` riêng.
Fixture chủ động từ chối URL có tên database không chứa `test`, chạy Alembic đến
`head`, rồi rollback dữ liệu của từng test.

Đặt nội dung sau vào `apps/agent-service/tests/conftest.py`:

```python
import os
from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from alembic import command
from alembic.config import Config
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.config.settings import get_settings


@pytest_asyncio.fixture
async def db_session() -> AsyncIterator[AsyncSession]:
  test_database_url = os.getenv("TEST_DATABASE_URL")
  if test_database_url is None:
    pytest.skip("TEST_DATABASE_URL is required for PostgreSQL integration tests")

  database_name = make_url(test_database_url).database or ""
  if "test" not in database_name.lower():
    raise RuntimeError("TEST_DATABASE_URL must point to a dedicated test database")

  previous_database_url = os.environ.get("DATABASE_URL")
  os.environ["DATABASE_URL"] = test_database_url
  get_settings.cache_clear()

  alembic_config = Config("alembic.ini")
  command.upgrade(alembic_config, "head")

  test_engine = create_async_engine(test_database_url, pool_pre_ping=True)
  try:
    async with test_engine.connect() as connection:
      transaction = await connection.begin()
      session = AsyncSession(bind=connection, expire_on_commit=False)
      try:
        yield session
      finally:
        await session.close()
        await transaction.rollback()
  finally:
    await test_engine.dispose()
    if previous_database_url is None:
      os.environ.pop("DATABASE_URL", None)
    else:
      os.environ["DATABASE_URL"] = previous_database_url
    get_settings.cache_clear()
```

Tạo database test riêng, ví dụ `logix_agent_test`, migrate database đó và truyền
URL khi chạy test:

```powershell
$env:TEST_DATABASE_URL = `
  "postgresql+psycopg://agent_test_app:<password>@localhost:5433/logix_agent_test"
```

Không dùng cùng role hoặc database với runtime development. Role test chỉ cần
quyền trên `logix_agent_test`.

Đặt nội dung sau vào
`apps/agent-service/tests/integration/test_agent_execution_repository.py`:

```python
import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.persistence.models import AgentExecution
from app.persistence.repositories.agent_execution_repository import (
  AgentExecutionRepository,
)


@pytest.mark.asyncio
async def test_get_active_never_crosses_tenant(
  db_session: AsyncSession,
) -> None:
  owner_tenant_id = uuid.uuid4()
  other_tenant_id = uuid.uuid4()
  execution = AgentExecution(
    tenant_id=owner_tenant_id,
    user_id=uuid.uuid4(),
    status="QUEUED",
    correlation_id=uuid.uuid4(),
    idempotency_key=uuid.uuid4(),
  )
  db_session.add(execution)
  await db_session.flush()

  repository = AgentExecutionRepository(db_session)

  owned_execution = await repository.get_active(
    tenant_id=owner_tenant_id,
    execution_id=execution.id,
  )
  assert owned_execution is not None
  assert owned_execution.id == execution.id
  assert await repository.get_active(
    tenant_id=other_tenant_id,
    execution_id=execution.id,
  ) is None
```

Không dùng `Base.metadata.create_all()` làm bằng chứng migration vì cách đó bỏ qua
lịch sử Alembic thực tế.

### 21.15 Bước A15 - Chạy kiểm tra theo thứ tự

Từ `apps/agent-service`:

```powershell
.\.venv\Scripts\ruff.exe check app tests
.\.venv\Scripts\mypy.exe app
.\.venv\Scripts\alembic.exe upgrade head
.\.venv\Scripts\alembic.exe current
.\.venv\Scripts\alembic.exe check
$env:TEST_DATABASE_URL = `
  "postgresql+psycopg://agent_test_app:<password>@localhost:5433/logix_agent_test"
.\.venv\Scripts\pytest.exe
```

Sau đó kiểm tra catalog PostgreSQL:

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'agent'
ORDER BY table_name;

SELECT tc.table_name, tc.constraint_name, tc.constraint_type
FROM information_schema.table_constraints AS tc
WHERE tc.table_schema = 'agent'
ORDER BY tc.table_name, tc.constraint_type, tc.constraint_name;
```

Kết quả tối thiểu phải chứng minh:

- có đúng tám bảng nghiệp vụ/hạ tầng đã chọn và Alembic version table;
- mọi bảng có primary key;
- mọi FK chỉ nằm trong schema `agent`;
- duplicate `(tenant_id, user_id, idempotency_key)` bị từ chối;
- tenant khác không đọc được execution qua repository;
- soft-deleted execution không xuất hiện trong `get_active`;
- update trạng thái và outbox event commit/rollback cùng nhau;
- `agent_app` không có quyền `CONNECT` tới database service khác.

### 21.16 Áp dụng mẫu sang Forecast và Route Optimizer

Khi Agent Service đã migrate và test thành công, tái sử dụng đúng pattern hạ tầng:

- `settings.py` chỉ đổi default schema;
- `base.py` chỉ đổi metadata schema;
- `session.py` giữ nguyên cấu trúc;
- mỗi service có `alembic.ini`, `migrations/env.py` và version table riêng;
- model, repository và transaction thuộc service nào ở service đó;
- không import SQLAlchemy model từ Agent sang Forecast hoặc Route Optimizer.

Không sao chép nguyên bảng Agent sang hai service còn lại. Chỉ tái sử dụng pattern
kết nối, migration, tenant scope, lifecycle, inbox/outbox và kiểm thử boundary.