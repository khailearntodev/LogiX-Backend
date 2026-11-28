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
      json: async () => ({ userIds: [user1, user2, user1] }),
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
        body: JSON.stringify({ kind: 'PERMISSION', code: 'transport:trip:dispatch' }),
      }),
    );
  });

  it('verifies USERS audience through identity-service instead of bypassing', async () => {
    const tenantId = randomUUID();
    const user1 = randomUUID();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ userIds: [user1] }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new IdentityRecipientClient(makeConfig());
    const result = await client.resolve(tenantId, {
      kind: 'USERS',
      userIds: [user1, user1],
    });

    expect(result).toEqual([user1]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://identity.example.test/api/v1/internal/recipients/resolve',
      expect.objectContaining({
        body: JSON.stringify({ kind: 'USERS', userIds: [user1] }),
      }),
    );
  });

  it('returns empty array without HTTP call when USERS list is empty', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new IdentityRecipientClient(makeConfig());
    await expect(
      client.resolve(randomUUID(), { kind: 'USERS', userIds: [] }),
    ).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on non-OK HTTP status or invalid payload', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as typeof fetch;
    const client = new IdentityRecipientClient(makeConfig());
    await expect(
      client.resolve(randomUUID(), { kind: 'PERMISSION', code: 'x' }),
    ).rejects.toThrow('HTTP 503');

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ userIds: [123] }),
    }) as typeof fetch;
    await expect(
      client.resolve(randomUUID(), { kind: 'PERMISSION', code: 'x' }),
    ).rejects.toThrow('Identity recipient response is invalid');
  });
});
