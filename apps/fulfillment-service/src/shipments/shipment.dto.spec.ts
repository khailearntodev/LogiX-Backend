import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomUUID } from 'node:crypto';
import {
  DispatchShipmentDto,
  FailShipmentDto,
  ShipmentQueryDto,
} from './shipment.dto.js';

describe('Shipment boundary DTOs', () => {
  it('accepts dispatch with explicit confirmation and safe versions', async () => {
    expect(
      await validate(
        plainToInstance(DispatchShipmentDto, {
          requestId: randomUUID(),
          version: 3,
          orderVersion: 8,
          confirmed: true,
        }),
      ),
    ).toHaveLength(0);
  });
  it.each([
    {},
    { confirmed: false },
    { version: 0 },
    { orderVersion: Number.MAX_SAFE_INTEGER + 1 },
    { requestId: 'bad' },
  ])('rejects unsafe dispatch %j', async (changes) => {
    expect(
      await validate(
        plainToInstance(DispatchShipmentDto, {
          requestId: randomUUID(),
          version: 3,
          orderVersion: 8,
          confirmed: true,
          ...changes,
          ...(Object.keys(changes).length ? {} : { confirmed: undefined }),
        }),
      ),
    ).not.toHaveLength(0);
  });
  it.each(['', '   ', 'x'.repeat(1001)])(
    'rejects invalid failure reason',
    async (reason) => {
      expect(
        await validate(
          plainToInstance(FailShipmentDto, {
            version: 4,
            confirmed: true,
            reason,
          }),
        ),
      ).not.toHaveLength(0);
    },
  );
  it('trims valid failure reason', async () => {
    const dto = plainToInstance(FailShipmentDto, {
      version: 4,
      confirmed: true,
      reason: ' no recipient ',
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.reason).toBe('no recipient');
  });
  it.each([
    { pageSize: 101 },
    { status: 'CREATED' },
    { warehouseId: 'bad' },
    { createdFrom: 'bad' },
  ])('rejects invalid query', async (query) => {
    expect(
      await validate(plainToInstance(ShipmentQueryDto, query)),
    ).not.toHaveLength(0);
  });
});
