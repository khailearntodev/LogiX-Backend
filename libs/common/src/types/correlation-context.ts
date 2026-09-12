/**
 * CorrelationContext — Propagates tracing metadata across service boundaries.
 *
 * Required by system-overview.md §6 (reliability model):
 * "correlation/causation tracking across synchronous and asynchronous flows."
 *
 * @see docs/architecture/event-architecture.md §10
 */
export interface CorrelationContext {
  /**
   * Unique ID for the entire request chain. Generated at the system boundary
   * (API Gateway) and propagated through all downstream calls and events.
   */
  readonly correlationId: string;

  /**
   * ID of the direct parent operation that caused the current operation.
   * For the first operation in a chain, this equals the correlationId.
   */
  readonly causationId: string;
}
