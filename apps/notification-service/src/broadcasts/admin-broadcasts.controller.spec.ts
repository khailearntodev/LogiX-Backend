import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { sign } from 'jsonwebtoken';
import request from 'supertest';
import { NOTIFICATION_BROADCAST_PERMISSIONS } from '@logix/auth';
import { EntityNotFoundError, GlobalExceptionFilter } from '@logix/errors';
import { AuthModule } from '../auth/auth.module.js';
import { AdminBroadcastsController } from './admin-broadcasts.controller.js';
import { BroadcastCommandService } from './broadcast-command.service.js';
import { BroadcastQueryService } from './broadcast-query.service.js';
import { BroadcastIdempotencyConflictError } from './broadcast.types.js';

const JWT_SECRET = 'controller-test-jwt-secret-min-32-chars';

function signToken(
  userId: string,
  tenantId: string,
  permissions: string[],
): string {
  return sign(
    { sub: userId, email: 'admin@logix.test', tenantId, role: 'MEMBER', permissions },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' },
  );
}

describe('AdminBroadcastsController (HTTP & Guards)', () => {
  let app: INestApplication;
  const commands = { enqueue: vi.fn() };
  const queries = { list: vi.fn(), getById: vi.fn() };
  const tenantId = randomUUID();
  const actorId = randomUUID();

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ JWT_SECRET, MAX_BROADCAST_RECIPIENTS: 3 })],
        }),
        AuthModule,
      ],
      controllers: [AdminBroadcastsController],
      providers: [
        { provide: BroadcastCommandService, useValue: commands },
        { provide: BroadcastQueryService, useValue: queries },
        { provide: APP_FILTER, useClass: GlobalExceptionFilter },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('enforces 401/403 guards, 400/422 validation, 202 Accepted, and 409 idempotency conflict', async () => {
    const server = app.getHttpServer();
    const body = {
      title: '  Bảo trì hệ thống  ',
      body: '  Hệ thống sẽ bảo trì lúc 23:00.  ',
      severity: 'INFO',
      audience: { kind: 'ALL' },
      link: '/settings',
    };

    await request(server)
      .post('/api/v1/notifications/admin/broadcasts')
      .set('Idempotency-Key', randomUUID())
      .send(body)
      .expect(401);

    const noPerm = signToken(actorId, tenantId, ['order:sales-order:read']);
    await request(server)
      .post('/api/v1/notifications/admin/broadcasts')
      .set('Authorization', `Bearer ${noPerm}`)
      .set('Idempotency-Key', randomUUID())
      .send(body)
      .expect(403);

    const sendToken = signToken(actorId, tenantId, [NOTIFICATION_BROADCAST_PERMISSIONS.SEND]);

    await request(server)
      .post('/api/v1/notifications/admin/broadcasts')
      .set('Authorization', `Bearer ${sendToken}`)
      .set('Idempotency-Key', 'not-a-uuid')
      .send(body)
      .expect(400);

    for (const badLink of ['https://evil.test', '//evil.test', 'javascript:alert(1)']) {
      await request(server)
        .post('/api/v1/notifications/admin/broadcasts')
        .set('Authorization', `Bearer ${sendToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ ...body, link: badLink })
        .expect(400);
    }

    await request(server)
      .post('/api/v1/notifications/admin/broadcasts')
      .set('Authorization', `Bearer ${sendToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ ...body, audience: { kind: 'ROLES', roleIds: [] } })
      .expect(422);

    await request(server)
      .post('/api/v1/notifications/admin/broadcasts')
      .set('Authorization', `Bearer ${sendToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        ...body,
        audience: { kind: 'USERS', userIds: [randomUUID(), randomUUID(), randomUUID(), randomUUID()] },
      })
      .expect(422);

    const idemKey = randomUUID();
    const broadcastId = randomUUID();
    commands.enqueue.mockResolvedValueOnce({ id: broadcastId, status: 'QUEUED', deduplicated: false });

    const created = await request(server)
      .post('/api/v1/notifications/admin/broadcasts')
      .set('Authorization', `Bearer ${sendToken}`)
      .set('Idempotency-Key', idemKey)
      .send(body)
      .expect(202);
    expect(created.body).toEqual({ id: broadcastId, status: 'QUEUED' });
    expect(commands.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        actorId,
        idempotencyKey: idemKey,
        title: 'Bảo trì hệ thống',
        body: 'Hệ thống sẽ bảo trì lúc 23:00.',
        link: '/settings',
      }),
    );

    commands.enqueue.mockRejectedValueOnce(new BroadcastIdempotencyConflictError());
    await request(server)
      .post('/api/v1/notifications/admin/broadcasts')
      .set('Authorization', `Bearer ${sendToken}`)
      .set('Idempotency-Key', idemKey)
      .send({ ...body, title: 'Khác' })
      .expect(409);
  });

  it('enforces READ permission and returns 200/404 on broadcast list and detail', async () => {
    const server = app.getHttpServer();
    const sendOnly = signToken(actorId, tenantId, [NOTIFICATION_BROADCAST_PERMISSIONS.SEND]);
    await request(server)
      .get('/api/v1/notifications/admin/broadcasts')
      .set('Authorization', `Bearer ${sendOnly}`)
      .expect(403);

    const readToken = signToken(actorId, tenantId, [NOTIFICATION_BROADCAST_PERMISSIONS.READ]);
    queries.list.mockResolvedValueOnce({ items: [], nextCursor: null });
    await request(server)
      .get('/api/v1/notifications/admin/broadcasts?limit=10')
      .set('Authorization', `Bearer ${readToken}`)
      .expect(200)
      .expect({ items: [], nextCursor: null });

    const missingId = randomUUID();
    queries.getById.mockRejectedValueOnce(
      new EntityNotFoundError('NotificationBroadcast', missingId),
    );
    await request(server)
      .get(`/api/v1/notifications/admin/broadcasts/${missingId}`)
      .set('Authorization', `Bearer ${readToken}`)
      .expect(404);
  });
});
