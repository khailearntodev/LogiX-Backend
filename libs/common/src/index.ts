/**
 * @logix/common — Shared types, constants, and utilities for LogiX Backend.
 *
 * This package contains cross-cutting concerns shared by all NestJS services:
 * - Type definitions (TenantContext, CorrelationContext, RequestContext)
 * - Service identity constants
 * - Utility functions
 *
 * It must NOT contain business logic from any specific domain.
 * @see docs/architecture/service-boundaries.md §1.6
 */
export * from './types/index.js';
export * from './constants/index.js';
export * from './utils/index.js';
