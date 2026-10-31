import { z } from 'zod';
import { TRANSPORT_MAX_PAGE_NUMBER } from '@logix/messaging';
import { tripStatusSchema } from './trip-status.js';

const uuid = z.string().uuid();
const version = z.number().int().positive().safe();

export const createTripSchema = z
  .object({
    requestId: uuid,
    warehouseId: uuid,
    plannedStartAt: z.string().datetime({ offset: true }),
    vehicleId: uuid.nullable().optional(),
    driverId: uuid.nullable().optional(),
  })
  .strict();

export const updateTripSchema = z
  .object({
    requestId: uuid,
    expectedVersion: version,
    plannedStartAt: z.string().datetime({ offset: true }).optional(),
    vehicleId: uuid.nullable().optional(),
    driverId: uuid.nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.plannedStartAt !== undefined ||
      value.vehicleId !== undefined ||
      value.driverId !== undefined,
  );

export const assignmentSchema = z
  .object({
    requestId: uuid,
    expectedVersion: version,
    vehicleId: uuid.nullable().optional(),
    driverId: uuid.nullable().optional(),
  })
  .strict()
  .refine(
    (value) => value.vehicleId !== undefined || value.driverId !== undefined,
  );

export const addShipmentsSchema = z
  .object({
    requestId: uuid,
    expectedTripVersion: version,
    shipments: z
      .array(
        z
          .object({
            shipmentId: uuid,
            expectedShipmentVersion: version,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.shipments.map(({ shipmentId }) => shipmentId)).size ===
      value.shipments.length,
  );

export const removeShipmentsSchema = z
  .object({
    requestId: uuid,
    expectedTripVersion: version,
    shipmentIds: z.array(uuid).min(1).max(100),
  })
  .strict()
  .refine(
    (value) => new Set(value.shipmentIds).size === value.shipmentIds.length,
  );

export const cancelPreviewSchema = z
  .object({
    expectedVersion: version,
  })
  .strict();

const cancelTripFields = {
  requestId: uuid,
  expectedVersion: version,
  confirmed: z.literal(true),
  reason: z.string().trim().min(1).max(1000),
};

export const cancelTripSchema = z.union([
  z
    .object({
      ...cancelTripFields,
      previewToken: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      ...cancelTripFields,
      previewId: uuid,
    })
    .strict(),
]);

export const tripListQuerySchema = z
  .object({
    warehouseId: uuid.optional(),
    status: tripStatusSchema.optional(),
    vehicleId: uuid.optional(),
    driverId: uuid.optional(),
    plannedStartFrom: z.string().datetime({ offset: true }).optional(),
    plannedStartTo: z.string().datetime({ offset: true }).optional(),
    search: z.string().trim().max(100).optional(),
    page: z.coerce
      .number()
      .int()
      .positive()
      .max(TRANSPORT_MAX_PAGE_NUMBER)
      .default(1),
    pageSize: z.coerce.number().int().positive().max(100).default(20),
  })
  .strict()
  .refine(
    (value) =>
      !value.plannedStartFrom ||
      !value.plannedStartTo ||
      new Date(value.plannedStartFrom) <= new Date(value.plannedStartTo),
    { message: 'plannedStartFrom must be no later than plannedStartTo' },
  );

export const eligibleShipmentsQuerySchema = z
  .object({
    warehouseId: uuid,
    page: z.coerce
      .number()
      .int()
      .positive()
      .max(TRANSPORT_MAX_PAGE_NUMBER)
      .default(1),
    pageSize: z.coerce.number().int().positive().max(100).default(20),
  })
  .strict();

export type CreateTripDto = z.infer<typeof createTripSchema>;
export type UpdateTripDto = z.infer<typeof updateTripSchema>;
export type AssignmentDto = z.infer<typeof assignmentSchema>;
export type AddShipmentsDto = z.infer<typeof addShipmentsSchema>;
export type RemoveShipmentsDto = z.infer<typeof removeShipmentsSchema>;
export type CancelTripDto = z.infer<typeof cancelTripSchema>;
export type TripListQueryDto = z.infer<typeof tripListQuerySchema>;
