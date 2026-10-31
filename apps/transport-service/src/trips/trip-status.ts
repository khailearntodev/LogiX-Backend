import { z } from 'zod';

export const TRIP_STATUS = {
  DRAFT: 'DRAFT',
  APPROVED: 'APPROVED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELED: 'CANCELED',
} as const;

export const TRIP_STATUSES = [
  TRIP_STATUS.DRAFT,
  TRIP_STATUS.APPROVED,
  TRIP_STATUS.IN_PROGRESS,
  TRIP_STATUS.COMPLETED,
  TRIP_STATUS.CANCELED,
] as const;

export type TripStatus = (typeof TRIP_STATUSES)[number];
export const tripStatusSchema = z.enum(TRIP_STATUSES);

export const TRIP_STOP_STATUS = {
  PENDING: 'PENDING',
  DELIVERED: 'DELIVERED',
  FAILED: 'FAILED',
} as const;

export const TRIP_STOP_STATUSES = [
  TRIP_STOP_STATUS.PENDING,
  TRIP_STOP_STATUS.DELIVERED,
  TRIP_STOP_STATUS.FAILED,
] as const;

export type TripStopStatus = (typeof TRIP_STOP_STATUSES)[number];
export const tripStopStatusSchema = z.enum(TRIP_STOP_STATUSES);

export const DELIVERY_ATTEMPT_OUTCOME = {
  DELIVERED: 'DELIVERED',
  FAILED: 'FAILED',
} as const;

export const DELIVERY_ATTEMPT_OUTCOMES = [
  DELIVERY_ATTEMPT_OUTCOME.DELIVERED,
  DELIVERY_ATTEMPT_OUTCOME.FAILED,
] as const;

export type DeliveryAttemptOutcome = (typeof DELIVERY_ATTEMPT_OUTCOMES)[number];
