# System Overview

## Status

Proposed target baseline derived from the approved BRD and the current LogiX repository architecture direction.

## 1. System context

LogiX is a multi-tenant B2B logistics and supply-chain platform for distribution businesses with one or more warehouses and an internal delivery fleet. The MVP connects order management, inventory, fulfillment, shipments, delivery trips, route planning, driver execution, forecasting, notifications, audit, and an Agentic AI layer.

The core logistics workflow must remain operational without the AI/model layer. The LLM is an intent-analysis and orchestration component, while demand forecasting and route optimization are delegated to specialized components.

## 2. Logical layers

### Experience layer

Clients and user interfaces interact with the platform through the API boundary. The driver experience is optimized for mobile-sized screens and exposes only operations for the driver's assigned trip.

### API boundary

`api-gateway` is the proposed entry point for external clients. It is responsible for request routing and common boundary concerns; business rules remain in the owning service.

### Core business services

- `identity-service`
- `master-data-service`
- `order-service`
- `inventory-service`
- `fulfillment-service`
- `transport-service`
- `notification-service`
- `audit-service`

These services own business capabilities and their persistence boundaries.

### AI and quantitative services

- `agent-service`: Planner Agent orchestration and tool access control.
- `forecast-service`: demand forecasting and baseline evaluation.
- `route-optimizer-service`: route optimization and objective/metrics output.

AI services are consumers/providers of business contracts, not owners of core operational state.

### Shared infrastructure

- PostgreSQL for service-owned transactional persistence.
- Redis where explicit cache or transient-state use is justified.
- Kafka for domain-event integration.
- Observability components for structured logs, metrics, trace/correlation, and operational evidence.

## 3. Communication model

### Synchronous communication

Use synchronous APIs when the caller needs an immediate validation/result or when the interaction is command-oriented and does not benefit from asynchronous fan-out.

Examples include:

- authenticate/authorize requests;
- create/update/read business data;
- validate and submit a command;
- preview a sensitive action;
- request a forecast or route proposal and retrieve its result.

### Asynchronous communication

Use Kafka domain events for state changes that other capabilities need to react to independently.

Examples defined by the BRD include:

- `OrderConfirmed`
- `InventoryReserved`
- `ShipmentReady`
- `TripPlanned`
- `RouteOptimized`
- `RouteApproved`
- `TripDispatched`
- `DeliveryCompleted`
- `DeliveryFailed`
- `ForecastCompleted`
- `AgentExecutionCompleted`

## 4. Core workflow

```text
SalesOrder
   |
   +--> validate + reserve inventory
   |        |
   |        +--> CONFIRMED / PENDING_STOCK
   |
   +--> picking
            |
            +--> Shipment READY
                    |
                    +--> DeliveryTrip DRAFT/PLANNED
                             |
                             +--> route proposal
                             |
                             +--> Dispatcher APPROVE / OVERRIDE
                                      |
                                      +--> DISPATCH
                                             |
                                             +--> inventory issue
                                             |
                                             +--> Driver delivery
                                                      |
                                                      +--> DELIVERED / FAILED
```

Forecasting runs independently from the fulfillment transaction flow and consumes completed-demand history. Route optimization consumes a prepared trip request and returns a proposal; the Dispatcher remains the authority to approve or override the route.

## 5. AI boundary

```text
User
  |
  v
Planner Agent
  |
  +--> permission-filtered tools
  |      |
  |      +--> read business data
  |      +--> create draft
  |      +--> analyze / forecast request
  |      +--> route proposal request
  |
  +--> LLM abstraction / provider adapter
```

The Agent must not:

- write directly to business databases;
- bypass business validation;
- elevate user permissions;
- directly compute forecast or route results;
- silently execute sensitive mutations.

Sensitive operations require a preview and explicit confirmation. The business tool/API executes the actual command.

## 6. Reliability model

The architecture must support:

- idempotent command/event processing;
- bounded retry with backoff for transient failures;
- clear terminal failure states and audit records;
- fallback/manual continuation when AI or solver components fail;
- optimistic versioning or an equivalent concurrency control for important commands;
- correlation/causation tracking across synchronous and asynchronous flows.

## 7. Scale model

The main scale-out unit is the service instance/replica. Stateless API and business-service processes should be horizontally scalable where practical. The MVP only needs demonstrable scale-out evidence for at least one workload and does not require production-grade Kubernetes complexity across every component.

## 8. Source mapping to BRD

- Multi-tenant B2B product and AI-independent core: BRD sections 1-3.
- Domain model and Order-to-Delivery: BRD sections 5-8.
- Agentic layer and LLM abstraction: BRD section 9.5 and section 11.
- Domain events and event envelope: BRD section 10.
- NFRs for tenant isolation, idempotency, resilience, observability, scale, AI engine independence: BRD section 13.
