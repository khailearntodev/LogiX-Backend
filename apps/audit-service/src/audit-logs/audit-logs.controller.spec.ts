import { randomUUID } from 'node:crypto';
import { createHmac } from 'node:crypto';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AUDIT_PERMISSIONS } from '@logix/auth';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { PrismaService } from '../database/prisma.service.js';
import { AuditLogsModule } from './audit-logs.module.js';

const TEST_JWT_SECRET = 'test-audit-jwt-secret-key-32-chars-minimum';

function signHs256Jwt(payload: Record<string, unknown>, secret = TEST_JWT_SECRET): string {
  const encode = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const body = encode({ iat: now, exp: now + 3600, ...payload });
  const signature = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

describe('AuditLogsController (HTTP Security & Read-Only Contract)', () => {
  let app: INestApplication;
  const tenantId = randomUUID();
  const auditId = randomUUID();
  const correlationId = randomUUID();

  const prismaMock = {
    auditLog: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue({
        id: auditId,
        tenantId,
        actorId: randomUUID(),
        actorType: 'USER',
        action: 'IDENTITY_ROLE_PERMISSIONS_UPDATED',
        entityType: 'Role',
        entityId: randomUUID(),
        outcome: 'SUCCESS',
        beforeData: { permissions: [] },
        afterData: { permissions: ['audit:log:read'] },
        metadata: { eventType: 'IdentityRolePermissionsUpdated' },
        correlationId,
        causationId: correlationId,
        sourceService: 'identity-service',
        sourceEventId: randomUUID(),
        occurredAt: new Date('2026-11-24T10:00:00.000Z'),
        ingestedAt: new Date('2026-11-24T10:00:00.120Z'),
      }),
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, AuthModule, AuditLogsModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .useMocker((token) => {
        if (token === ConfigService) {
          return {
            getOrThrow: (key: string) => {
              if (key === 'JWT_SECRET') return TEST_JWT_SECRET;
              throw new Error(`Unexpected config key: ${key}`);
            },
          };
        }
        return undefined;
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('rejects unauthenticated requests with 401', async () => {
    await request(app.getHttpServer()).get('/api/v1/audit-logs').expect(401);
  });

  it('rejects MEMBER and ungranted ADMIN tokens with 403', async () => {
    const memberToken = signHs256Jwt({
      sub: randomUUID(),
      email: 'member@logix.vn',
      tenantId,
      role: 'MEMBER',
      permissions: ['order:sales-order:read'],
    });
    const adminWithoutAuditToken = signHs256Jwt({
      sub: randomUUID(),
      email: 'admin@logix.vn',
      tenantId,
      role: 'ADMIN',
      permissions: ['order:sales-order:read', 'iam:member:read'],
    });

    await request(app.getHttpServer())
      .get('/api/v1/audit-logs')
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/v1/audit-logs')
      .set('Authorization', `Bearer ${adminWithoutAuditToken}`)
      .expect(403);
  });

  it('allows OWNER and explicitly granted audit:log:read users to query read-only endpoints', async () => {
    const ownerToken = signHs256Jwt({
      sub: randomUUID(),
      email: 'owner@logix.vn',
      tenantId,
      role: 'OWNER',
      permissions: ['*'],
    });
    const managerToken = signHs256Jwt({
      sub: randomUUID(),
      email: 'manager@logix.vn',
      tenantId,
      role: 'MANAGER',
      permissions: [AUDIT_PERMISSIONS.LOG_READ],
    });

    await request(app.getHttpServer())
      .get('/api/v1/audit-logs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/audit-logs/${auditId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
    expect(detail.body.id).toBe(auditId);
    expect(detail.body.latencyMs).toBe(120);

    await request(app.getHttpServer())
      .get(`/api/v1/audit-logs/correlations/${correlationId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);
  });

  it('rejects non-whitelisted query params with 400 and exposes no mutation endpoints', async () => {
    const ownerToken = signHs256Jwt({
      sub: randomUUID(),
      email: 'owner@logix.vn',
      tenantId,
      role: 'OWNER',
      permissions: ['*'],
    });

    await request(app.getHttpServer())
      .get('/api/v1/audit-logs?tenantId=override-attempt')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(400);

    await request(app.getHttpServer())
      .post('/api/v1/audit-logs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({})
      .expect(404);

    await request(app.getHttpServer())
      .patch(`/api/v1/audit-logs/${auditId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({})
      .expect(404);

    await request(app.getHttpServer())
      .delete(`/api/v1/audit-logs/${auditId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(404);
  });
});
