/**
 * RequestContext — Full context for any operation in the system.
 *
 * Combines tenant identity, correlation tracing, and request metadata.
 * Attached to every incoming request and propagated to downstream services/events.
 */
export interface RequestContext {
  /** Tenant and actor identity. */
  readonly tenantId: string;
  readonly actorId: string;
  readonly roles: readonly string[];

  /** Distributed tracing metadata. */
  readonly correlationId: string;
  readonly causationId: string;

  /** ISO 8601 timestamp of when this context was created. */
  readonly timestamp: string;
}
