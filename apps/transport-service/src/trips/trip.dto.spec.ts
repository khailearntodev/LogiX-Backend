import { describe, expect, it } from 'vitest';
import { tripListQuerySchema } from './trip.dto.js';
import {
  DELIVERY_ATTEMPT_OUTCOMES,
  TRIP_STATUSES,
  TRIP_STOP_STATUSES,
} from './trip-status.js';

describe('trip lifecycle query contract', () => {
  it.each(TRIP_STATUSES)('accepts target trip status %s', (status) => {
    expect(tripListQuerySchema.parse({ status }).status).toBe(status);
  });

  it('does not accept PLANNED as a trip status filter', () => {
    expect(tripListQuerySchema.safeParse({ status: 'PLANNED' }).success).toBe(
      false,
    );
  });

  it('exposes only PENDING and terminal stop statuses', () => {
    expect(TRIP_STOP_STATUSES).toEqual(['PENDING', 'DELIVERED', 'FAILED']);
    expect(DELIVERY_ATTEMPT_OUTCOMES).toEqual(['DELIVERED', 'FAILED']);
  });
});
