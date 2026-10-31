import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../../database/prisma.service.js';
import type { Driver } from '../../generated/prisma/client.js';
import type { IdentityDriverClient } from './identity-driver.client.js';
import type { TransportDriverClient } from './transport-driver.client.js';
import { DriverLinkService } from './driver-link.service.js';

describe('Driver relink command invariants', () => {
  const tenantId = randomUUID(),
    id = randomUUID(),
    previousUserId = randomUUID(),
    userId = randomUUID(),
    actorId = randomUUID();
  const dto = {
    version: 1,
    expectedUserId: previousUserId,
    userId,
    reason: 'Correction',
  };
  const row: Driver = {
    id,
    tenantId,
    userId: previousUserId,
    code: 'D',
    licenseNumber: 'L',
    licenseExpiry: new Date('2027-10-25'),
    phone: null,
    status: 'ACTIVE',
    version: 1n,
    linkLockedAt: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  function fixture(current = row) {
    let transactionActive = false;
    const tx = {
      driver: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi
          .fn()
          .mockResolvedValue({ ...current, userId, version: 2n }),
      },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const driver = {
      findFirst: vi.fn().mockResolvedValueOnce(current).mockResolvedValue(null),
    };
    const transaction = vi.fn(
      async (action: (client: typeof tx) => Promise<unknown>) => {
        transactionActive = true;
        try {
          return await action(tx);
        } finally {
          transactionActive = false;
        }
      },
    );
    const identity = {
      eligible: vi.fn(async () => {
        expect(transactionActive).toBe(false);
        return {
          id: userId,
          displayName: 'New',
          email: 'new@example.test',
          status: 'ACTIVE',
        };
      }),
      resolve: vi.fn(async () => {
        expect(transactionActive).toBe(false);
        return [
          {
            id: previousUserId,
            displayName: 'Previous',
            email: 'previous@example.test',
            status: 'ACTIVE',
          },
        ];
      }),
    };
    const transport = {
      used: vi.fn(async () => {
        expect(transactionActive).toBe(false);
        return false;
      }),
    };
    const service = new DriverLinkService(
      { driver, $transaction: transaction } as unknown as PrismaService,
      identity as unknown as IdentityDriverClient,
      transport as unknown as TransportDriverClient,
    );
    return { service, driver, transaction, identity, transport, tx };
  }
  it('preview is read/validation only and has exact old/new display contract', async () => {
    const f = fixture();
    expect(await f.service.preview(tenantId, id, dto)).toEqual({
      driverId: id,
      version: 1,
      previousUserId,
      userId,
      previousDisplayName: 'Previous',
      displayName: 'New',
      reason: 'Correction',
    });
    expect(f.transaction).not.toHaveBeenCalled();
    expect(f.tx.outboxEvent.create).not.toHaveBeenCalled();
  });
  it.each([
    [{ ...dto, version: 2 }, row, 'Concurrency conflict'],
    [{ ...dto, expectedUserId: userId }, row, 'Concurrency conflict'],
    [{ ...dto, userId: previousUserId }, row, 'trùng'],
    [dto, { ...row, linkLockedAt: new Date() }, 'chuyến giao'],
  ])(
    'rejects old-binding/noop/permanent-lock before external checks',
    async (body, current, message) => {
      const f = fixture(current);
      await expect(
        f.service.relink(tenantId, id, actorId, body),
      ).rejects.toThrow(message);
      expect(f.identity.eligible).not.toHaveBeenCalled();
      expect(f.transport.used).not.toHaveBeenCalled();
      expect(f.transaction).not.toHaveBeenCalled();
    },
  );
  it('rejects historical reference without any write', async () => {
    const f = fixture();
    f.transport.used.mockResolvedValue(true);
    await expect(f.service.relink(tenantId, id, actorId, dto)).rejects.toThrow(
      'chuyến giao',
    );
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it('does network prechecks before transaction and CAS plus audit together inside it', async () => {
    const f = fixture();
    await expect(
      f.service.relink(tenantId, id, actorId, dto),
    ).resolves.toMatchObject({ userId, version: 2 });
    expect(f.tx.driver.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        id,
        tenantId,
        deletedAt: null,
        userId: previousUserId,
        version: 1n,
        linkLockedAt: null,
      },
      data: { userId, version: { increment: 1 } },
    });
    expect(f.tx.outboxEvent.create).toHaveBeenCalledOnce();
    expect(f.tx.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            actorId,
            beforeData: { userId: previousUserId, version: 1 },
            afterData: { userId, version: 2 },
          }),
        }),
      }),
    );
  });
  it('revalidates permanent lock at the write and emits no audit for losing CAS', async () => {
    const f = fixture();
    f.tx.driver.updateMany.mockResolvedValue({ count: 0 });
    f.tx.driver.findFirst.mockResolvedValue({
      ...row,
      linkLockedAt: new Date(),
    });
    await expect(f.service.relink(tenantId, id, actorId, dto)).rejects.toThrow(
      'chuyến giao',
    );
    expect(f.tx.outboxEvent.create).not.toHaveBeenCalled();
  });
  it('sanitizes audit persistence failures instead of logging sensitive payloads', async () => {
    const f = fixture();
    f.tx.outboxEvent.create.mockRejectedValue(
      new Error('sensitive database diagnostics'),
    );
    await expect(f.service.relink(tenantId, id, actorId, dto)).rejects.toThrow(
      'Không thể lưu liên kết',
    );
  });
});
