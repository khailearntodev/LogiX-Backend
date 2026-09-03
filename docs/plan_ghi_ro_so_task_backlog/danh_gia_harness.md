# Đánh Giá Harness Agent Coding – Dự Án LogiX Backend

> **Phạm vi**: So sánh nội dung `AGENTS.md` (harness) với `docs/brd.md` (Business Requirements Document) và hệ sinh thái tài liệu kèm theo (`docs/WORKFLOW.md`, `docs/patterns/`, `docs/plans/`).

---

## 1. Tổng Quan Cấu Trúc Harness

Harness hiện tại nằm trong file [`AGENTS.md`](file:///e:/GraduateProject/Logix/LogiX-Backend/AGENTS.md) và bao gồm hai phần chính:

| Phần | Nội dung |
|---|---|
| `<!-- HARNESS:BEGIN --> ... <!-- HARNESS:END -->` | Bộ quy tắc cốt lõi hướng dẫn tác nhân AI |
| `### Architecture` | Con trỏ tới tài liệu kiến trúc |

Tài liệu hỗ trợ được tham chiếu:
- [`docs/WORKFLOW.md`](file:///e:/GraduateProject/Logix/LogiX-Backend/docs/WORKFLOW.md) ✅ **Tồn tại**
- `docs/plans/active/` ✅ **Thư mục tồn tại**
- `docs/patterns/encoding-invariants.md` ✅ **Tồn tại**
- `docs/architecture/README.md` – cần kiểm tra thêm

---

## 2. Các Quy Tắc Chính Harness Đưa Ra

Harness định nghĩa **8 quy tắc hành vi** và **1 nguyên tắc kiến trúc**:

### 2.1 Quy Tắc Loại Công Việc (Work Shape Rules)

| # | Quy tắc gốc | Ý nghĩa |
|---|---|---|
| R-1 | *"Answers, explanations, reviews, diagnoses, plans, and status reports are **read-only**."* | Khi agent trả lời/giải thích/review, **không được chỉnh sửa file nào**. |
| R-2 | *"For a bounded change, inspect affected behavior and proof, implement, and validate. No control-plane operation is required."* | Thay đổi nhỏ/cụ thể: kiểm tra → thực thi → xác nhận; **không cần plan dài hạn**. |
| R-3 | *"Use one `docs/plans/active/` file when work spans sessions, coordinates contributors, has dependencies, or needs recovery."* | Công việc phức tạp, đa phiên, đa cộng tác viên → tạo **duy nhất một plan file**; chuyển sang `completed/` sau khi xác nhận. |

### 2.2 Quy Tắc Kiểm Soát Thẩm Quyền (Authority Rules)

| # | Quy tắc gốc | Ý nghĩa |
|---|---|---|
| R-4 | *"Before editing, identify repository authority for each new externally observable policy. If materially different choices remain open, **stop before edits**."* | Agent **phải dừng** nếu chính sách chưa có thẩm quyền rõ ràng từ repository. Cấu hình mặc định không được coi là thẩm quyền. |
| R-5 | *"Also pause when product intent remains ambiguous, recovery is difficult, validation is weakened, or authority is insufficient."* | Bốn tình huống bắt buộc agent **tạm dừng và hỏi người dùng**: (1) ý định sản phẩm không rõ, (2) khó phục hồi, (3) kiểm thử bị yếu đi, (4) thẩm quyền không đủ. |

### 2.3 Quy Tắc Biến Bất Biến & Kiến Trúc (Invariant Rules)

| # | Quy tắc gốc | Ý nghĩa |
|---|---|---|
| R-6 | *"For architecture, reliability, security, or quality invariant work, read `docs/patterns/encoding-invariants.md` and enforce only accepted rules."* | Với công việc liên quan kiến trúc/bảo mật/độ tin cậy → **bắt buộc đọc** file invariants và chỉ áp dụng quy tắc đã được chấp nhận. |

### 2.4 Quy Tắc Cải Tiến Harness

| # | Quy tắc gốc | Ý nghĩa |
|---|---|---|
| R-7 | *"Report reusable agent friction. Change guidance, tools, runbooks, or validation for that purpose **only when explicitly asked** to use `$improve-harness`."* | Agent **chỉ được cải tiến harness** khi người dùng gọi lệnh `$improve-harness` một cách rõ ràng. Ghi nhận ma sát nhưng không tự động sửa. |

### 2.5 Quy Tắc Hoàn Thành (Completion Standard)

| # | Quy tắc gốc | Ý nghĩa |
|---|---|---|
| R-8 | *"Claim completion only with executable or observable evidence. Report outcome, changes, validation, and unresolved risks."* | Tuyên bố hoàn thành **phải kèm bằng chứng kiểm chứng được** (test pass, log, output thực tế). Không được dùng mô tả thay thế bằng chứng. |

### 2.6 Nguyên Tắc Kiến Trúc

| # | Quy tắc gốc | Ý nghĩa |
|---|---|---|
| A-1 | *"Do not invent or infer undocumented architecture decisions as accepted architecture."* | Agent **không được tự bịa** quyết định kiến trúc chưa được tài liệu hóa; phải đọc `docs/architecture/README.md` trước. |

---

## 3. Đánh Giá Mức Độ Phù Hợp Với BRD

### 3.1 Điểm Phù Hợp ✅

| Khía cạnh BRD | Quy tắc Harness tương ứng | Mức độ |
|---|---|---|
| **BR-AI-002**: Tool permission ≤ quyền user; không có service account toàn quyền | R-4, R-5: Phải có thẩm quyền rõ ràng, dừng khi authority không đủ | ✅ Phù hợp tốt |
| **BR-AI-003**: Hành động nhạy cảm cần preview + explicit confirmation | R-5: Agent tạm dừng khi recovery khó, validation yếu | ✅ Phù hợp |
| **BR-AI-006**: Khi model/tool không sẵn sàng → trả trạng thái rõ ràng | R-8: Phải báo cáo unresolved risks, không được giả vờ hoàn thành | ✅ Phù hợp |
| **BR-AUD-001/002**: Mọi thay đổi quan trọng phải audit, log không sửa được | R-8: Completion cần evidence; R-3: Plan file là durable record | ✅ Phù hợp một phần |
| **NFR-AI-004**: Business logic không chứa prompt logic cụ thể cho provider | A-1: Không tự suy luận kiến trúc chưa được tài liệu hóa | ✅ Phù hợp triết lý |
| **BO-05**: Tool Success Rate ≥ 90% trên tập kịch bản khóa | R-8: Phải có observable evidence | ✅ Phù hợp |
| **BR-TEN-005**: Mọi hành động phải mang tenant context có thể kiểm chứng | R-4: Authority phải xác định được từ repository | ✅ Phù hợp |

### 3.2 Khoảng Trống Đáng Lưu Ý ⚠️

| Yêu cầu BRD | Trạng thái trong Harness | Phân tích |
|---|---|---|
| **BR-AI-001**: LLM **bắt buộc** gọi tool/mô hình chuyên biệt, không tự tính forecast/route | ❌ Không được đề cập rõ | Harness không có rule ngăn agent tự sinh số liệu phân tích thay vì gọi tool. |
| **BR-AI-003**: Danh sách hành động nhạy cảm cụ thể (confirm order, cancel, approve route, dispatch) | ⚠️ Chỉ gián tiếp qua R-5 | Harness không liệt kê rõ sensitive actions theo nghiệp vụ. |
| **BR-TEN-001/006**: Cách ly tenant nghiêm ngặt | ⚠️ Không đề cập | Harness không có rule cụ thể về tenant context isolation cho agent. |
| **NFR-AI-005**: Thay đổi model provider trong ≤ 1 giờ | ⚠️ Không đề cập | Harness không hướng dẫn cách xử lý khi cần swap model. |
| **FR-AGT-002**: Planner phải trả preview trước sensitive action | ⚠️ Gián tiếp | Không được nhắc cụ thể trong harness flow. |
| **Idempotency** (NFR-REL-001, BR-TRIP-007) | ❌ Không đề cập | Harness không nhắc đến việc đảm bảo tool call idempotent. |
| **Audit trail / correlation_id** (BR-AUD-002) | ⚠️ Chỉ gián tiếp | R-3 (plan file) và R-8 (evidence) gần nhưng không đủ cụ thể. |

---

## 4. Đánh Giá Flow Tổng Thể

### Flow Harness Hiện Tại

```
Nhận yêu cầu
    ↓
Đọc WORKFLOW.md + tài liệu liên quan
    ↓
[Phân loại loại công việc]
    ├── Read-only → Chỉ đọc, không sửa (R-1)
    ├── Bounded Change → Inspect → Implement → Validate (R-2)
    └── Durable Change → Tạo plan file → Implement theo nhóm → Validate → Archive (R-3)
    ↓
[Kiểm tra thẩm quyền trước khi sửa]
    ├── Có authority rõ ràng → Tiến hành
    └── Không rõ / recovery khó → DỪNG và báo cáo (R-4, R-5)
    ↓
[Công việc Invariant?]
    └── Đọc encoding-invariants.md, chỉ áp dụng quy tắc đã chấp nhận (R-6)
    ↓
Báo cáo với evidence thực tế (R-8)
```

**Nhận xét về flow**: Flow logic **đúng và rõ ràng** cho một agent coding tổng quát. Harness tuân theo triết lý "minimal footprint" – làm đủ, không vượt quá, dừng khi không chắc.

### So Với Yêu Cầu Luồng Nghiệp Vụ BRD (Section 6)

BRD yêu cầu agent (Planner) phải theo flow:
```
Nhận yêu cầu tự nhiên
    ↓
Gắn tenant + user + role context
    ↓
Phân loại ý định → Chỉ expose tool đúng role/tenant
    ↓
[Loại hành động]
    ├── Đọc → Thực thi trực tiếp
    ├── Draft/Phân tích → Trả kết quả để người dùng kiểm tra
    └── Nhạy cảm (confirm/cancel/approve/dispatch) → Preview + Explicit Confirmation
    ↓
Tool thực thi business rule (giống API/UI)
    ↓
Audit với correlation_id
```

**Khoảng cách**: Harness hiện tại **không phản ánh** luồng nghiệp vụ cụ thể này. Nó là harness **meta-level** (hướng dẫn agent coding) chứ không phải harness **domain-level** (quy tắc nghiệp vụ cho Planner Agent LogiX).

---

## 5. Kết Luận & Khuyến Nghị

### Kết Luận

| Tiêu chí | Đánh giá |
|---|---|
| **Cấu trúc tổng thể** | ✅ Rõ ràng, có phân vùng HARNESS:BEGIN/END |
| **Flow logic** | ✅ Đúng theo best practice agent coding |
| **Tham chiếu tài liệu** | ✅ Đủ và các file được tham chiếu đều tồn tại |
| **Phù hợp với BRD – phần chung** | ✅ Tốt (authority, evidence, minimal change) |
| **Phù hợp với BRD – phần nghiệp vụ LogiX** | ⚠️ Thiếu (không có rule tenant isolation, sensitive actions, idempotency, tool-only policy) |
| **Completeness cho Planner Agent** | ❌ Harness hiện là coding harness; chưa có domain harness cho Planner Agent |

> [!IMPORTANT]
> Harness hiện tại phù hợp cho **agent coding tổng quát** (giúp AI viết code cho dự án). Tuy nhiên, nếu bạn muốn dùng harness này để **hướng dẫn Planner Agent runtime** (agent xử lý yêu cầu nghiệp vụ logistics), cần bổ sung thêm domain-specific rules.

### Khuyến Nghị Bổ Sung

Nếu muốn harness phản ánh đầy đủ BRD, có thể bổ sung một section `## Domain Rules` trong `AGENTS.md`:

```markdown
## Domain Rules (LogiX Planner Agent)

- Luôn gắn tenant_id và user_id vào mọi tool call; từ chối nếu thiếu context.
- Chỉ expose tool mà role hiện tại được phép theo RBAC; không vượt quyền gốc.
- Hành động nhạy cảm (confirm order, cancel order, approve route, dispatch trip)
  phải hiển thị preview và chờ explicit confirmation trong cùng session.
- LLM không tự tính forecast hoặc route; bắt buộc gọi tool chuyên biệt.
- Mọi tool call phải idempotent; request lặp không tạo side effect lần hai.
- Nếu model/tool không sẵn sàng, trả lỗi rõ ràng; không trả số liệu tự sinh.
- Ghi audit với correlation_id cho mọi bước trong agent execution.
```

---

*Tài liệu tham chiếu:*
- [`AGENTS.md`](file:///e:/GraduateProject/Logix/LogiX-Backend/AGENTS.md) – Harness được đánh giá
- [`docs/brd.md`](file:///e:/GraduateProject/Logix/LogiX-Backend/docs/brd.md) – Business Requirements Document
- [`docs/WORKFLOW.md`](file:///e:/GraduateProject/Logix/LogiX-Backend/docs/WORKFLOW.md) – Workflow chi tiết
- [`docs/patterns/encoding-invariants.md`](file:///e:/GraduateProject/Logix/LogiX-Backend/docs/patterns/encoding-invariants.md) – Invariant rules
