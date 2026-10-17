export {
  type DomainEventEnvelope,
  type CreateDomainEvent,
} from "./event-envelope.js";

export {
  type DomainEventMap,
  type DomainEventType,
  type AddressSnapshot,
  type CustomerSnapshot,
  type WarehouseSnapshot,
  type IssuerSnapshot,
  type OrderLinePayload,
  type OrderDraftPayload,
  type OrderCreatedPayload,
  type OrderUpdatedPayload,
  type OrderCanceledPayload,
  type OrderConfirmedPayload,
  type OrderPendingStockPayload,
  type StockMovementPayload,
  type StockReceivedPayload,
  type InventoryReservedPayload,
  type InventoryAdjustedPayload,
  type ShipmentReadyPayload,
  type TripPlannedPayload,
  type RouteOptimizedPayload,
  type RouteApprovedPayload,
  type TripDispatchedPayload,
  type DeliveryCompletedPayload,
  type DeliveryFailedPayload,
  type ForecastCompletedPayload,
  type AgentExecutionCompletedPayload,
} from "./interfaces/domain-event.interface.js";

export { KafkaProducerService } from "./kafka-producer.service.js";
export { MessagingModule } from "./messaging.module.js";
export type { MessagingModuleOptions } from "./messaging.module.js";
export { OutboxRelay, outboxRetryDelay } from "./outbox-relay.js";
export type {
  OutboxRelayOptions,
  OutboxRelayRecord,
  OutboxRelayStore,
  OutboxRelayTransaction,
} from "./outbox-relay.js";
export { PrismaOutboxStore } from "./prisma-outbox.store.js";
export type {
  ReservationLine,
  ReserveRequest,
  ReservationShortage,
  ReserveResult,
  ReservationPreview,
} from "./interfaces/reservation.interface.js";
export {
  KafkaEventConsumer,
  parseEventEnvelope,
} from "./kafka-event-consumer.js";
export type { OutboxDatabase } from "./prisma-outbox.store.js";
