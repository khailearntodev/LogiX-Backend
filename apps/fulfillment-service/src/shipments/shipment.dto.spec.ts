import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { ValidationPipe } from '@nestjs/common';
import { SHIPMENT_STATUS } from '@logix/messaging';
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

  const queryPipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const parseQuery = (query: object) =>
    queryPipe.transform(query, { type: 'query', metatype: ShipmentQueryDto });

  it.each([
    {},
    { status: SHIPMENT_STATUS.READY_TO_SHIP },
    { statuses: 'PENDING_PICK,PICKING' },
    { statuses: Object.values(SHIPMENT_STATUS).join(',') },
    { statuses: 'READY_TO_SHIP', page: '2', pageSize: '100' },
  ])('accepts compatible status query %j', async (query) => {
    await expect(parseQuery(query)).resolves.toBeInstanceOf(ShipmentQueryDto);
  });

  it('parses CSV once into the DTO status set', async () => {
    const dto: ShipmentQueryDto = await parseQuery({
      statuses: 'PENDING_PICK,PICKING',
    });
    expect(dto.statuses).toEqual([
      SHIPMENT_STATUS.PENDING_PICK,
      SHIPMENT_STATUS.PICKING,
    ]);
  });

  it.each([
    { statuses: '' },
    { statuses: ',' },
    { statuses: 'PENDING_PICK,' },
    { statuses: ',PICKING' },
    { statuses: 'PENDING_PICK,,PICKING' },
    { statuses: 'PENDING_PICK, PICKING' },
    { statuses: 'PENDING_PICK,PENDING_PICK' },
    { statuses: 'PENDING_PICK,UNKNOWN' },
    { statuses: ['PENDING_PICK', 'PICKING'] },
    { statuses: ['PENDING_PICK'] },
    { statuses: null },
    { statuses: 1 },
    { status: 'READY_TO_SHIP', statuses: 'PENDING_PICK,PICKING' },
    { status: '', statuses: 'PENDING_PICK' },
    { status: ['PENDING_PICK', 'PICKING'] },
    { page: '0' },
    { page: '1.5' },
    { page: '21474837' },
    { pageSize: '0' },
    { pageSize: '101' },
    { createdTo: 'not-a-date' },
    { unknown: 'value' },
  ])('rejects malformed or ambiguous query %j with 400', async (query) => {
    await expect(parseQuery(query)).rejects.toMatchObject({ status: 400 });
  });
});
