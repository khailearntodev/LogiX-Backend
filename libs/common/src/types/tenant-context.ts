/**
 * TenantContext — Carries tenant identity and actor information.
 *
 * Required by architecture principle #4: "Tenant isolation is a system-wide
 * invariant. Business records and operations carry tenant context and
 * cross-tenant access is denied by default."
 *
 * @see docs/architecture/README.md §4
 */
export interface TenantContext {
  /** The tenant that owns the current operation. Always required. */
  readonly tenantId: string;

  /** The authenticated user performing the action. Required for user-triggered operations. */
  readonly actorId: string;

  /** Roles assigned to the actor within the tenant. */
  readonly roles: readonly string[];
}
