import { z } from 'zod';
import { transportUuidSchema, transportVersionSchema, sha256Schema } from './transport.contract.js';

export const tripDispatchPreviewRequestSchema = z.object({ version: transportVersionSchema }).strict();
export const tripDispatchCommandSchema = z.object({
  requestId: transportUuidSchema, version: transportVersionSchema,
  previewToken: z.string().min(1), confirmed: z.literal(true),
}).strict();
export const tripDispatchPreviewSchema = z.object({
  tripId: transportUuidSchema, version: transportVersionSchema,
  approvedPlanId: transportUuidSchema, inputHash: sha256Schema,
  dispatchVersion: transportVersionSchema, shipmentCount: z.number().int().positive(),
  previewToken: z.string().min(1), expiresAt: z.string().datetime(),
}).strict();
export const tripDispatchOperationSchema = z.object({
  tripId: transportUuidSchema, requestId: transportUuidSchema, kind: z.literal('DISPATCH'),
  status: z.enum(['PENDING', 'REJECTED', 'COMPLETED']),
  stage: z.enum(['ACCEPTED', 'SUBMITTED', 'RECEIPTED', 'COMPLETED', 'REJECTED']),
  payloadHash: sha256Schema, version: transportVersionSchema,
  result: z.object({
    tripId: transportUuidSchema, status: z.literal('IN_PROGRESS'), version: transportVersionSchema,
    dispatchVersion: transportVersionSchema, dispatchedAt: z.string().datetime(),
  }).strict().nullable(),
  error: z.string().nullable(), nextRetryAt: z.string().datetime().nullable(),
  results: z.array(z.object({ shipmentId: transportUuidSchema, state: z.string() }).strict()),
}).strict();
export type TripDispatchCommand = z.infer<typeof tripDispatchCommandSchema>;
