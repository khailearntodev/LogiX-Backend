# Event Architecture

## Status

Proposed event-driven baseline derived from the BRD event catalogue and reliability requirements.

## 1. Eventing goals

Kafka is used for asynchronous domain-event integration where multiple consumers may react independently or where producer/consumer availability should be decoupled.

Events are integration contracts, not remote procedure calls. They communicate that an authoritative business fact occurred.

## 2. Minimal event envelope

Every domain event must contain at least:

```json
{
  "event_id": "...",
  "event_type": "OrderConfirmed",
  "event_version": 1,
  "occurred_at": "...",
  "producer": "order-service",
  "tenant_id": "...",
  "actor_id": "...",
  "correlation_id": "...",
  "causation_id": "...",
  "aggregate_type": "SalesOrder",
  "aggregate_id": "...",
  "aggregate_version": 3,
  "payload": {}
}
```

Fields may be represented differently by the implementation, but the semantic contract must remain.

## 3. Event catalogue

| Event | Producer | Primary reaction / purpose | Idempotency key from BRD |
|---|---|---|---|
| `StockReceived` | Inventory | Retry pending orders; low-stock checks | `receipt_id` |
| `InventoryAdjusted` | Inventory | Audit/dashboard refresh | `movement_id` |
| `OrderCreated` | Order | Audit/notification according to configuration | `order_id` |
| `OrderConfirmed` | Order | Start fulfillment | `order_id + version` |
| `OrderPendingStock` | Order | Notify Order Staff/Manager | `order_id + shortage_hash` |
| `InventoryReserved` | Inventory | Update order state | `reservation_group_id` |
| `ShipmentReady` | Fulfillment | Make shipment available to Dispatcher | `shipment_id` |
| `TripPlanned` | Transport | Permit route optimization request | `trip_id + version` |
| `RouteOptimized` | Route Optimizer | Persist proposed route/metrics | `route_request_id` |
| `RouteApproved` | Transport | Permit dispatch | `route_plan_id` |
| `TripDispatched` | Transport | Trigger stock issue / driver notification | `trip_id + dispatch_version` |
| `DeliveryCompleted` | Driver/Transport | Complete shipment/order | `stop_id + attempt` |
| `DeliveryFailed` | Driver/Transport | Notify Dispatcher / enable reschedule | `stop_id + attempt` |
| `ForecastCompleted` | Forecast | Dashboard/notification update | `forecast_run_id` |
| `AgentExecutionCompleted` | Agent | Audit/metrics | `agent_execution_id` |

## 4. Event ownership

The service that changes the authoritative business state publishes the corresponding domain event.

Examples:

```text
Order Service
  -> OrderConfirmed

Inventory Service
  -> InventoryReserved

Fulfillment Service
  -> ShipmentReady

Transport Service
  -> TripPlanned / RouteApproved / TripDispatched

Forecast Service
  -> ForecastCompleted

Agent Service
  -> AgentExecutionCompleted
```

A consumer must not rewrite the meaning of a producer-owned event.

## 5. Idempotency

Consumers must treat event delivery as at-least-once from an application perspective unless a stronger guarantee is explicitly established and tested.

Use the event idempotency key, event id, or a domain-specific deduplication key to prevent duplicate business effects.

Examples:

- duplicated `TripDispatched` must not issue inventory twice;
- duplicated `StockReceived` must not create duplicate stock receipt effects;
- duplicated `OrderConfirmed` must not create duplicate reservation;
- duplicated notification-triggering events must not create unwanted duplicate notifications where deduplication is required.

## 6. Ordering and versioning

Events for the same aggregate should carry monotonically meaningful versions. Consumers must reject, ignore, or otherwise safely handle stale/out-of-order events rather than moving business state backward.

Partitioning/keying strategy must preserve the required ordering domain for each aggregate or business stream.

## 7. Retry and failure handling

Transient consumer failures may retry with bounded backoff.

After the configured retry policy is exhausted:

- the failure must be observable;
- the business state must not be silently corrupted;
- the failed event should be routed to a dead-letter/error path appropriate to the infrastructure design;
- the failure should be auditable where business impact exists.

## 8. Producer reliability

For state changes that must reliably result in an event, use an outbox or an equivalent mechanism when required by the failure model.

Do not rely on an uncoordinated sequence such as:

```text
DB commit
  |
  X
Kafka publish
```

without a recovery strategy for the gap.

## 9. Synchronous vs asynchronous rule

Use synchronous API calls when the caller needs the immediate authoritative result.

Use events when the change is a fact that other services can consume independently and when loose coupling improves the workflow.

Do not convert every API call into an event merely to appear "microservice-like".

## 10. Tenant and tracing rules

Every event carries `tenant_id`. When user-triggered, `actor_id` should be present. `correlation_id` and `causation_id` must allow reconstruction of the processing chain.

Sensitive data and secrets must not be embedded in event payloads or raw logs.

## 11. Contract evolution

Event schemas are versioned. Additive, backward-compatible evolution is preferred. Breaking changes require a new version and coordinated consumer migration.

Shared event contracts belong under the repository's contracts package and are referenced by producer/consumer code; business logic does not belong in the shared contract package.
