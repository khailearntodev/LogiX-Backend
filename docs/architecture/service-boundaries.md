# Service Boundaries

## Status

Proposed target baseline. Service responsibilities should be confirmed through ADRs before a boundary is materially changed.

## 1. Boundary rules

1. Each business entity has one owning service.
2. A service owns the business rules and persistence for its bounded capability.
3. Other services do not query another service's database directly.
4. Cross-service reads use synchronous API contracts or purpose-built read/integration contracts.
5. Cross-service reactions use versioned domain events when asynchronous behavior is appropriate.
6. Shared libraries contain contracts and cross-cutting infrastructure, not business logic from multiple domains.
7. A service may publish data about its own state, but another service decides how that data is applied inside its own boundary.

## 2. Service catalogue

| Service | Owns | Explicitly does not own |
|---|---|---|
| `api-gateway` | External API routing/boundary concerns | Business domain state or business rules |
| `identity-service` | Tenant, user, role, authentication/session-related identity state, tenant context source | Order, inventory, shipment, trip data |
| `master-data-service` | Customer, address, product, warehouse, vehicle, driver master data | Order lifecycle, inventory balances, trip execution |
| `order-service` | SalesOrder, OrderLine, order state transitions, order-side commands | Inventory balance, shipment execution, route plans |
| `inventory-service` | InventoryBalance, InventoryReservation, StockMovement, stock rules | Order lifecycle, trip lifecycle |
| `fulfillment-service` | Shipment creation/readiness and shipment lifecycle | Inventory accounting, trip routing/dispatch |
| `transport-service` | DeliveryTrip, TripStop, route-plan approval/override state, vehicle/driver assignment for trips | Core master-data definitions, inventory balance |
| `notification-service` | Notification records, delivery/read state, notification fan-out | Source business truth |
| `audit-service` | Immutable audit records and audit query model | Business state mutation |
| `agent-service` | Agent execution, conversations/tool orchestration, permission-filtered tool exposure | Direct business persistence or core business truth |
| `forecast-service` | ForecastRun, ForecastResult, model/baseline execution metadata | Inventory/order mutation |
| `route-optimizer-service` | Optimization request/result, solver/version/objective/metrics | Route approval authority or dispatch mutation |

## 3. Detailed boundaries

### 3.1 Identity & tenant

Responsibilities:

- provision/activate/suspend tenant;
- manage users and roles within tenant;
- supply verifiable tenant/user/role context;
- enforce identity-level access state such as disabled users.

Authority rules:

- Platform Admin manages tenant metadata and health, not tenant business data by default.
- Tenant Admin manages users/roles and tenant master data.
- Tenant isolation is mandatory for all business services.

### 3.2 Master Data

Owns:

- Customer and CustomerAddress;
- Product;
- Warehouse;
- Vehicle;
- Driver profile and its association to the Driver role.

Referenced master records are disabled/locked instead of hard-deleted when they are still referenced.

### 3.3 Order

Owns:

- SalesOrder;
- OrderLine;
- order state machine;
- order-side confirmation/cancellation rules;
- order search/filter operations.

Critical rule: one order belongs to exactly one customer, one delivery address, one warehouse, and one tenant. MVP does not support split order or multi-warehouse fulfillment.

### 3.4 Inventory

Owns:

- InventoryBalance;
- InventoryReservation;
- StockMovement;
- stock receiving, adjustment, reservation/release, issue rules.

Invariant:

`available_quantity = on_hand_quantity - reserved_quantity >= 0`

Every on-hand change creates a StockMovement with business reference, actor, and timestamp.

### 3.5 Fulfillment

Owns:

- Shipment;
- shipment state machine;
- creation of the shipment from an order after successful reservation;
- readiness for transport assignment.

MVP rule: one SalesOrder creates at most one Shipment.

### 3.6 Transport

Owns:

- DeliveryTrip;
- TripStop;
- trip lifecycle;
- vehicle/driver assignment to trips;
- route approval/override state;
- dispatch command.

Trip invariants:

- all shipments in a trip belong to the same warehouse;
- vehicle and driver must be active and schedule-compatible;
- capacity must not be exceeded;
- dispatch requires approved route and all shipments READY;
- dispatch is idempotent and causes stock issue exactly once.

### 3.7 Notification

Owns notification delivery state for events such as pending stock, low stock, driver assignment, route ready, delivery failure, and AI job failure.

The notification service does not become the source of truth for the business state that caused the notification.

### 3.8 Audit

Owns immutable audit records for security-sensitive and business-sensitive operations.

Audit must capture, at minimum:

- tenant;
- actor;
- action;
- entity;
- timestamp;
- correlation_id;
- outcome;
- before/after where applicable.

Business APIs must not expose mutation of audit records.

### 3.9 Agent

Owns orchestration concerns:

- conversation context;
- AgentExecution;
- tool selection/execution lifecycle;
- tool permission filtering;
- confirmation workflow state;
- sanitized tool input/output capture for audit/metrics.

It does not own Orders, Inventory, Shipments, Trips, ForecastResults, or RoutePlan business truth.

### 3.10 Forecast

Owns forecast runs/results and model metadata. It consumes completed order demand by tenant + warehouse + SKU and returns forecast plus baseline metrics.

Forecast is advisory only and cannot create purchase/inbound operations because such operations are outside the MVP business scope.

### 3.11 Route Optimizer

Owns optimization computation and result metadata. It receives a bounded request and returns a proposal. Dispatcher approval remains in Transport.

The result must preserve the input hash, solver/version, objective, and metrics needed for reproducibility.

## 4. Cross-service dependency rules

Allowed patterns:

```text
Service A --sync API--> Service B
Service A --domain event--> Kafka --> Service B
Service A --shared contract--> common schema package
```

Forbidden patterns:

```text
Service A --> Service B database directly
Agent --> business database directly
LLM SDK --> business service domain logic directly
Shared library --> owns multiple domain aggregates
```

## 5. MVP scope discipline

Do not create separate microservices for Vehicle, Driver, TripStop, or RoutePlan merely because they are separate entities. They remain inside the Master Data or Transport bounded capabilities unless a later ADR establishes a materially different boundary.
