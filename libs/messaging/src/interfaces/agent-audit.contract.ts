/**
 * Shared Agentic Layer audit event contracts.
 *
 * Security invariant (NFR-AUD-001 & service-boundaries.md §3.9):
 * Agent tool inputs/outputs carried for audit must already be sanitized
 * and must never embed raw credentials, tokens, or unredacted secrets.
 */

import type { AuditOutcome } from "./identity-audit.contract.js";

export const AGENT_AUDIT_EVENT_TYPES = {
  TOOL_CALLED: "AgentToolCalled",
  EXECUTION_COMPLETED: "AgentExecutionCompleted",
} as const;

export type AgentAuditEventType =
  (typeof AGENT_AUDIT_EVENT_TYPES)[keyof typeof AGENT_AUDIT_EVENT_TYPES];

export type AgentToolCallStatus =
  | "SUCCEEDED"
  | "FAILED"
  | "REJECTED"
  | "STALE"
  | "AWAITING_CONFIRMATION";

export interface AgentToolCalledPayload {
  toolCallId: string;
  agentExecutionId: string;
  conversationId: string | null;
  toolName: string;
  toolVersion: string;
  requiredPermission: string | null;
  riskLevel: string;
  targetService: string | null;
  status: AgentToolCallStatus;
  outcome: AuditOutcome;
  sanitizedInput: Record<string, unknown>;
  sanitizedOutputSummary?: Record<string, unknown> | null;
  errorCode?: string | null;
  latencyMs?: number | null;
}
