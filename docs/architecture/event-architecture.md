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
| `OrderUpdated` | Order | Audit of editable orders; wake pending stock retries | `order_id + version` |
| `OrderCanceled` | Order | Inventory backup release; audit/notification | `order_id + version` |
| `OrderConfirmed` | Order | Acknowledge reservation; start fulfillment in phase 5 | `order_id + version` |
| `OrderPendingStock` | Order | Wake pending stock retries; notify Order Staff/Manager | `order_id + version` |
| `StockReserved` | Inventory | Record successful all-or-nothing reservation | `reservation_group_id + version` |
| `StockReleased` | Inventory | Wake pending stock retries after release | `reservation_group_id + version` |
| `ShipmentReady` | Fulfillment | Make shipment available to Dispatcher | `shipment_id` |
| `TripPlanned` | Transport | Legacy contract; lifecycle L-01 does not emit a PLANNED transition or require this event to optimize a DRAFT | `trip_id + version` |
| `RouteOptimized` | Route Optimizer | Persist proposed route/metrics | `route_request_id` |
| `RouteApproved` | Transport | Permit dispatch | `route_plan_id` |
| `TripDispatched` | Transport | Trip-level audit / driver notification; never a second Inventory ISSUE trigger | `trip_id + dispatch_version` |
| `DeliveryCompleted` | Transport | Fulfillment projects the Shipment to `DELIVERED`; Order follows Shipment lifecycle | `tenant_id + trip_stop_id + request_id` |
| `DeliveryFailed` | Transport | Fulfillment projects the Shipment to `FAILED`; Order follows Shipment lifecycle | `tenant_id + trip_stop_id + request_id` |
| `ForecastCompleted` | Forecast | Dashboard/notification update | `forecast_run_id` |
| `AgentExecutionCompleted` | Agent | Audit/metrics | `agent_execution_id` |

## 4. Event ownership

The service that changes the authoritative business state publishes the corresponding domain event.

Examples:

```text
Order Service
  -> OrderConfirmed

Inventory Service
  -> StockReserved / StockReleased

Fulfillment Service
  -> ShipmentReady

Transport Service
  -> RouteApproved / TripDispatched

Forecast Service
  -> ForecastCompleted

Agent Service
  -> AgentExecutionCompleted
```

For the Delivery Trip & Vehicle Dispatch task, the owner-approved
[lifecycle refactor L-01–L-04](../../../delivery-trip-dispatch-lifecycle-refactor.vi.md)
supersedes the older planning/arrival workflow: optimize while DRAFT, approve
once, then dispatch; stop results go directly from PENDING to DELIVERED/FAILED.
Do not repurpose TripPlanned or silently delete published legacy contracts.
Inventory ISSUE remains driven solely by ShipmentDispatched; TripDispatched
is a trip-level notification/audit fact, not a second stock trigger. Delivery
results are applied by Fulfillment, then projected to Order via Shipment
lifecycle events. No new arrival event or redelivery flow is introduced.
These are target contracts; schema/interface presence is not runtime proof.

`DeliveryCompleted` and `DeliveryFailed` use event version 2 and carry
`tripId`, `tripStopId`, `shipmentId`, `driverId`, `attempt`, `occurredAt`, and
the terminal command `requestId`; `DeliveryFailed` additionally carries its
failure `reason`. Fulfillment validates the Transport producer and trip/stop/
shipment binding. Its Inbox durably defers a result until the assigned Shipment
is locally `DISPATCHED`; after applying a result, only the Shipment lifecycle
outbox drives Order projection. Semantic duplicates do not repeat Shipment
history or lifecycle events, and conflicting terminal results are retained as
diagnostics without overwriting terminal Shipment state.

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

## 12. Implemented Order/Inventory reservation baseline

Shared contracts are in `libs/messaging/src/interfaces/`. Runtime envelopes use
camelCase fields and permit `actorId: null` for system-triggered decisions.
`StockReceived.quantity` is additive; `quantityDelta` is retained. Stock
quantities and shortage values cross service boundaries as decimal strings.

Order confirmation is synchronous: Inventory decides reserved/insufficient;
Order commits its state/history/outbox afterwards. A failed Order commit after
successful reservation is recovered with the same version-bound reservation
key or through the explicit Order reconciliation handshake. No TTL-only release
is permitted.

Cancellation first commits an intent and increments the Order version, locking
editing/confirmation while preserving its business status. After Inventory
release succeeds, Order commits CANCELED/history/outbox and increments version
again. A background worker retries persisted intents.

Phase 5A adds an irrevocable Order dispatch grant under the same row lock used
by cancellation. Pending cancellation rejects dispatch; a grant rejects cancel
before any release, even before IN_DELIVERY projection. Only Fulfillment's
internal token can request a grant; exact retries replay the persisted decision.
This is a synchronous internal contract, not a shipment event or proof of stock
issue. Fulfillment must persist its request and recover forward after a grant.
Phase 5B adds Shipment creation/cancellation, dispatch-intent recovery,
lifecycle projection and Inventory ISSUE after this gate.

The relay holds service-local row locks through publish/marking and selects only
the earliest unpublished event per tenant/aggregate. Failure after broker
publication but before database commit can still redeliver the same event ID;
consumer Inbox deduplication is required.

Order's stock consumer serializes FIFO evaluation by tenant/warehouse, ordered
by `pendingSince, id`. An insufficient order does not block later candidates.
Per-order Inbox commits with each decision; warehouse Inbox commits when the
whole pass finishes, allowing recovery after partial progress. `OrderPendingStock`
and pending `OrderUpdated` also wake evaluation to cover stock arriving before
the pending Order transaction commits. An insufficient retry does not emit
another `OrderPendingStock`, preventing a self-triggering event loop.

Consumer handler failures are marked retriable for KafkaJS restart without
advancing the failed offset. Permanent invalid events currently require
operator repair and may block their partition; automatic dead-letter routing
is not implemented. Broker-restart rehearsal and load benchmarks are not
claimed by the phase-4 API/unit evidence.

## 13. Fulfillment lifecycle (phase 5B)

`OrderConfirmed` keeps event version 1 with additive line fields:
`skuSnapshot`, `productNameSnapshot`, `unitSnapshot`, `unitWeight`, `unitVolume`.
Legacy events lacking all five fields use Fulfillment-only
`GET /internal/orders/:orderId/fulfillment-snapshot`; malformed rich events are
rejected, not silently repaired. Customer/address/warehouse JSON stays copied
from the original event. Creating a pool entry has no stock side effect.

Shipment events share `ShipmentLifecyclePayload` in `@logix/messaging`:
shipment/order/warehouse/reservation IDs, optional dispatch request and reason.
The relay publishes to required `KAFKA_FULFILLMENT_TOPIC`, keyed by aggregate,
using a separate durable group in Order and Inventory.

| Event | Order projection | Inventory effect |
| --- | --- | --- |
| ShipmentCreated | None | None |
| ShipmentPicking | PICKING | None |
| ShipmentReadyToShip | READY_TO_SHIP | None |
| ShipmentDispatched | IN_DELIVERY, matching persisted grant required | ISSUE |
| ShipmentDelivered | COMPLETED + completedAt | None |
| ShipmentDeliveryFailed | DELIVERY_FAILED | None |
| ShipmentCanceled / ShipmentCancelRejected | None | None |

Envelope producer, tenant, IDs, event version and aggregate identity are checked.
Order locks its own row, enforces existing forward transitions, and records
invalid/stale events as `IGNORED_STALE`. Redelivery is not enabled. A producer's
outbox preserves same-aggregate ordering; arbitrary reordering of future events
is not a supported transport contract. Inbox and aggregate versions prevent
replay from moving lifecycle backward.

Inventory serializes ISSUE with reservation/release using the tenant/order
advisory lock, then locks product balances in sorted order. Replay with a new
event ID checks the persisted shipment/request receipt, not only Inbox.
Stock movements emit `StockIssued`, never `InventoryAdjusted` for ISSUE.
Permanent malformed events retain the existing observable retry/blocking
behavior; automatic DLQ and full phase-5 benchmark remain separate work.

## 14. Transport event and integration contracts

The envelope, outbox/Inbox and ownership rules above remain system-wide.
This section specializes them for Transport; its versions and protocols do not
silently replace contracts used by other domains. Implementation progress and
test results belong to the
[execution record](../plans/active/2026-10-25-delivery-trip-dispatch.md).

Runtime Transport event schemas are owned by
[`@logix/messaging`](../../libs/messaging/src/interfaces/transport.contract.ts).
Schema availability does not prove producer, consumer, relay or recovery
integration. Existing version-1 interfaces remain backward compatible.

The `DeliveryCompleted`/`DeliveryFailed` result envelope schema is event
version 2 and requires a non-null `actorId`. Its payload binds the tenant and
trip aggregate and carries `driverId` and `assigneeUserId` separately from the
acting principal. An authorized user acting for the assignee is valid; the
envelope actor must not be inferred from, or replaced with, the assignee.
Event/payload tenant mismatch, payload trip/aggregate mismatch, event/outcome
mismatch and malformed identity/version values must be rejected.

Related command and receipt contracts cover:

- versioned, idempotency-keyed claim and release request/receipt shapes;
- READY_TO_SHIP pool page shape, default 20/max 100, stable createdAt/id descending;
- whole-set batch grant request and all-or-none decision shapes;
- actor/assignee/target/version/payload-bound preview and confirmation shape;
- delivery-result defer receipt for `DISPATCH_PROJECTION_NOT_READY`; and
- optimizer request/run identity bound to tenant, trip, request, and input hash.

The persistence requirements for claim/release locking/replay, pool filtering/pagination,
whole-set grant persistence/recovery, 300-second single-use preview, durable
result defer/reconciliation and canonical UTF-8 SHA-256 optimizer run binding
are recorded in [database design §10.8](database-design.md#108-transport-cross-service-persistence-contracts).
The existing version-1 minimal `TripDispatched` and delivery event interfaces are
not silently widened; consumers must opt into the version-2 result contract
through an explicitly coordinated rollout.

## 15. Domain audit event: Driver account-link correction

This event applies the existing system audit vocabulary to one domain action;
it does not introduce a second audit authority or a mandatory event shape for
unrelated business actions.

Master Data owns `outbox_events` rows for `DriverUserRelinked`
event version 1. Driver CAS and outbox insert are one local transaction; an audit
insert failure rolls back the user/version change. Preview and all rejected
commands create no success event. The event carries tenant, Driver aggregate and
new version, UUID correlation/source-event identity and occurrence time.
Its payload uses the existing AuditLog vocabulary:
`actorId` from the authenticated JWT (not new/old assignee or request body),
`actorType=USER`, `action=driver.relink-user`, `entityType=Driver`, `entityId`,
`outcome=SUCCESS`, before/after user IDs and versions, `metadata.reason`,
correlation/causation, source service/event ID and timestamp. It does not copy
email/display names into the event or log the reason/payload.

This is durable **local pending audit evidence**, not a new audit authority.
Audit Service remains authoritative for centralized immutable audit queries.
Local persistence alone does not establish relay or Audit ingestion.
Delivery status and observed integration evidence belong to the execution
record, not to this event's ownership contract.
Existing standard outbox fields (`published_at`, attempts, next-attempt,
last-error and aggregate ordering index) retain compatibility with the shared
relay store for that later integration. Operators must retain pending evidence
until an authorized relay/consumer rollout has been proven.

The separate read-only preview is not the persisted, single-use 300-second Transport
command preview foundation in §14. Relink uses explicit old-user/version binding
and full revalidation on confirmation; no token or reservation is issued.

## 16. Delivery route approval (Phase 3)

Transport publishes `RouteApproved` event version **2**, aggregate DeliveryTrip,
only from the same transaction that creates the immutable approved plan,
per-version vehicle/Driver snapshots, approval receipt and current stop order.
The runtime payload schema is `routeApprovedPayloadV2Schema` in
`@logix/messaging/interfaces/trip-route.contract.ts`. It binds tenant, acting
user, trip, exact route/version/hash, source/original plan, command request,
approve/override action/reason, resources, approval time and before/after trip
versions. It does not claim the trip is dispatched or fabricate optimizer data.
The existing v1 interface is not silently changed.

The Transport outbox relay now uses the existing ordered `FOR UPDATE SKIP LOCKED`
store, bounded batches and retry scheduling. Broker ACK before database commit
can redeliver an identical `eventId`; consumers must use Inbox deduplication.
The envelope parser adds the explicitly coordinated `RouteApproved` v2 to its
existing v1 support; it still rejects unknown higher versions, so existing
v1-only Order/Inventory consumers do not silently accept a new protocol.
The owning handler must still validate its specific payload/version.
Reopen emits `TripReopened` v1 with actor/reason and before/after evidence.
This is pending local domain audit evidence, not proof of centralized Audit
ingestion. No new workflow/lease table is introduced.

`ShipmentCanceled` is consumed idempotently. For an APPROVED trip it clears the
current plan pointer/sequences and returns to DRAFT while retaining immutable
approval history, then recovers the existing durable release operation.
IN_PROGRESS/non-rejected dispatch evidence blocks consumption and resource
release until the existing authority is explicitly recovered; the event remains
retryable instead of being acknowledged as handled.
