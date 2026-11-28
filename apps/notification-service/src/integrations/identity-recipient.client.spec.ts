import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { IdentityRecipientClient } from './identity-recipient.client.js';

const configValues: Record<string, unknown> = {
  IDENTITY_SERVICE_URL: 'http://identity.example.test/',
  INTERNAL_SERVICE_JWT_SECRET: 'b'.repeat(32),
  IDENTITY_REQUEST_TIMEOUT_MS: 5000,
};

function makeConfig(): ConfigService {
  return {
    getOrThrow: vi.fn((key: string) => configValues[key]),
  } as unknown as ConfigService;
}

describe('IdentityRecipientClient', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('resolves PERMISSION audience via identity internal endpoint and deduplicates ids', async () => {
    const tenantId = randomUUID();
    const user1 = randomUUID();
    const user2 = randomUUID();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        userIds: [user1, user2, user1],
        nextCursor: null,
        hasMore: false,
      }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new IdentityRecipientClient(makeConfig());
    const result = await client.resolve(tenantId, {
      kind: 'PERMISSION',
      code: 'transport:trip:dispatch',
    });

    expect(result).toEqual([user1, user2]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://identity.example.test/api/v1/internal/recipients/resolve',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          'x-internal-service-token': expect.any(String),
        }),
      }),
    );
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sentBody).toEqual({
      audience: { kind: 'PERMISSION', code: 'transport:trip:dispatch' },
      cursor: null,
      snapshotAt: expect.any(String),
    });
  });

  it('paginates ALL and ROLES audiences across multiple keyset pages with a consistent snapshotAt', async () => {
    const tenantId = randomUUID();
    const u1 = randomUUID();
    const u2 = randomUUID();
    const u3 = randomUUID();
    const snapshotAt = '2026-11-27T10:00:00.000Z';

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          userIds: [u1, u2],
          nextCursor: u2,
          hasMore: true,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          userIds: [u2, u3],
          nextCursor: null,
          hasMore: false,
        }),
      });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new IdentityRecipientClient(makeConfig());
    const result = await client.resolve(
      tenantId,
      { kind: 'ALL' },
      { pageSize: 2, snapshotAt },
    );

    expect(result).toEqual([u1, u2, u3]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://identity.example.test/api/v1/internal/recipients/resolve',
      expect.objectContaining({
        body: JSON.stringify({
          audience: { kind: 'ALL' },
          limit: 2,
          cursor: null,
          snapshotAt,
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://identity.example.test/api/v1/internal/recipients/resolve',
      expect.objectContaining({
        body: JSON.stringify({
          audience: { kind: 'ALL' },
          limit: 2,
          cursor: u2,
          snapshotAt,
        }),
      }),
    );
  });

  it('verifies USERS and ROLES audiences through identity-service and deduplicates input ids', async () => {
    const tenantId = randomUUID();
    const user1 = randomUUID();
    const role1 = randomUUID();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        userIds: [user1],
        nextCursor: null,
        hasMore: false,
      }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new IdentityRecipientClient(makeConfig());
    const page = await client.resolvePage(
      tenantId,
      { kind: 'ROLES', roleIds: [role1, role1] },
      { limit: 100, cursor: null },
    );

    expect(page).toEqual({
      userIds: [user1],
      nextCursor: null,
      hasMore: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://identity.example.test/api/v1/internal/recipients/resolve',
      expect.objectContaining({
        body: JSON.stringify({
          audience: { kind: 'ROLES', roleIds: [role1] },
          limit: 100,
          cursor: null,
        }),
      }),
    );
  });

  it('returns empty array without HTTP call when USERS or ROLES list is empty', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new IdentityRecipientClient(makeConfig());
    await expect(
      client.resolve(randomUUID(), { kind: 'USERS', userIds: [] }),
    ).resolves.toEqual([]);
    await expect(
      client.resolve(randomUUID(), { kind: 'ROLES', roleIds: [] }),
    ).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on non-OK HTTP status, invalid payload, or stalled pagination cursor', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503 }) as typeof fetch;
    const client = new IdentityRecipientClient(makeConfig());
    await expect(
      client.resolve(randomUUID(), { kind: 'PERMISSION', code: 'x' }),
    ).rejects.toThrow('HTTP 503');

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ userIds: [123], nextCursor: null, hasMore: false }),
    }) as typeof fetch;
    await expect(
      client.resolve(randomUUID(), { kind: 'PERMISSION', code: 'x' }),
    ).rejects.toThrow('Identity recipient response is invalid');

    const stuckCursor = randomUUID();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          userIds: [stuckCursor],
          nextCursor: stuckCursor,
          hasMore: true,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          userIds: [stuckCursor],
          nextCursor: stuckCursor,
          hasMore: true,
        }),
      }) as typeof fetch;
    await expect(
      client.resolve(randomUUID(), { kind: 'ALL' }),
    ).rejects.toThrow('Identity recipient pagination cursor did not advance');
  });
});
