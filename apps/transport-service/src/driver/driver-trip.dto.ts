import { z } from 'zod';
import {
  TRANSPORT_MAX_PAGE_NUMBER,
  TRANSPORT_MAX_REASON_LENGTH,
} from '@logix/messaging';

const uuid = z.string().uuid();
const version = z.number().int().positive().safe();

export const driverTripListSchema = z
  .object({
    scope: z.enum(['current', 'history']).default('current'),
    driverId: uuid.optional(),
    page: z.coerce
      .number()
      .int()
      .positive()
      .max(TRANSPORT_MAX_PAGE_NUMBER)
      .default(1),
    pageSize: z.coerce.number().int().positive().max(100).default(20),
  })
  .strict();

export const driverActionPreviewSchema = z
  .object({
    action: z.enum(['DELIVER', 'FAIL']),
    expectedTripVersion: version,
    expectedStopVersion: version,
    actingReason: z
      .string()
      .trim()
      .min(1)
      .max(TRANSPORT_MAX_REASON_LENGTH),
    reason: z.string().trim().min(1).max(TRANSPORT_MAX_REASON_LENGTH).optional(),
  })
  .strict()
  .refine((value) => value.action === 'FAIL' || value.reason === undefined)
  .refine((value) => value.action !== 'FAIL' || value.reason !== undefined);

export const driverActionCommandSchema = z
  .object({
    requestId: uuid,
    expectedTripVersion: version,
    expectedStopVersion: version,
    confirmed: z.literal(true),
    previewToken: z.string().min(1).max(4096).optional(),
    actingReason: z
      .string()
      .trim()
      .min(1)
      .max(TRANSPORT_MAX_REASON_LENGTH)
      .optional(),
    reason: z.string().trim().min(1).max(TRANSPORT_MAX_REASON_LENGTH).optional(),
  })
  .strict();

export type DriverTripListQuery = z.infer<typeof driverTripListSchema>;
export type DriverActionPreviewDto = z.infer<typeof driverActionPreviewSchema>;
export type DriverActionCommandDto = z.infer<typeof driverActionCommandSchema>;
