import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { tripDispatchCommandSchema, tripDispatchOperationSchema, tripDispatchPreviewSchema } from './trip-dispatch.contract.js';

describe('Gateway dispatch wire contract', () => {
  it('requires explicit confirmation and rejects actor or tenant supplied in the public command', () => {
    const command = { requestId: randomUUID(), version: 3, previewToken: 'signed-preview', confirmed: true };
    expect(tripDispatchCommandSchema.parse(command)).toEqual(command);
    for (const changed of [
      { ...command, confirmed: false }, { ...command, actorId: randomUUID() },
      { ...command, tenantId: randomUUID() }, { ...command, version: 0 },
    ]) expect(tripDispatchCommandSchema.safeParse(changed).success).toBe(false);
  });
  it('publishes exact preview and durable pending/rejected/completed envelopes without a stock-issued claim', () => {
    const tripId = randomUUID(), requestId = randomUUID();
    const preview = tripDispatchPreviewSchema.parse({
      tripId, version: 4, approvedPlanId: randomUUID(), inputHash: 'a'.repeat(64),
      dispatchVersion: 1, shipmentCount: 2, previewToken: 'signed-preview', expiresAt: new Date().toISOString(),
    });
    expect(preview.shipmentCount).toBe(2);
    for (const status of ['PENDING', 'REJECTED', 'COMPLETED']) {
      const envelope = tripDispatchOperationSchema.parse({
        tripId, requestId, kind: 'DISPATCH', status, stage: status === 'PENDING' ? 'SUBMITTED' : status,
        payloadHash: 'b'.repeat(64), version: 4, result: null, error: null,
        nextRetryAt: status === 'PENDING' ? new Date().toISOString() : null, results: [],
      });
      expect(envelope).not.toHaveProperty('stockIssued');
    }
  });
});
