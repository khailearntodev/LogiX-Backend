export {
  type DomainEventEnvelope,
  type CreateDomainEvent,
} from './event-envelope.js';

export {
  type DomainEventMap,
  type DomainEventType,
  type OrderCreatedPayload,
  type OrderConfirmedPayload,
  type OrderPendingStockPayload,
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
} from './interfaces/domain-event.interface.js';

export { KafkaProducerService } from './kafka-producer.service.js';
export { MessagingModule } from './messaging.module.js';
export type { MessagingModuleOptions } from './messaging.module.js';
